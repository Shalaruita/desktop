import { Repository } from '../../models/repository'
import { User } from '../../models/user'
import { GitHubRepository } from '../../models/github-repository'
import { API } from '../api'
import { fatalError } from '../fatal-error'
import { LocalGitOperations } from '../local-git-operations'

/**
 * A default interval at which to automatically fetch repositories, if the
 * server doesn't specify one or the header is malformed.
 */
const DefaultFetchInterval = 1000 * 60 * 60

/**
 * A minimum fetch interval, to protect against the server accidentally sending
 * us a crazy value.
 */
const MinimumInterval = 1000 * 5 * 60

/**
 * An upper bound to the skew that should be applied to the fetch interval to
 * prevent clients from accidentally syncing up.
 */
const SkewUpperBound = 30 * 1000

/** The class which handles doing background fetches of the repository. */
export class BackgroundFetcher {
  private readonly repository: Repository
  private readonly user: User

  /** The handle for our setTimeout invocation. */
  private timeoutHandle: number | null = null

  /** Flag to indicate whether `stop` has been called. */
  private stopped = false

  public constructor(repository: Repository, user: User) {
    this.repository = repository
    this.user = user
  }

  /** Start background fetching. */
  public start() {
    if (this.stopped) {
      fatalError('Cannot start a background fetcher that has been stopped.')
      return
    }

    const gitHubRepository = this.repository.gitHubRepository
    if (!gitHubRepository) { return }

    this.performAndScheduleFetch(gitHubRepository)
  }

  /**
   * Stop background fetching. Once this is called, the fetcher cannot be
   * restarted.
   */
  public stop() {
    this.stopped = true

    const handle = this.timeoutHandle
    if (handle) {
      clearTimeout(handle)
      this.timeoutHandle = null
    }
  }

  /** Perform a fetch and schedule the next one. */
  private async performAndScheduleFetch(repository: GitHubRepository): Promise<void> {
    try {
      await this.fetch()
    } catch (e) {
      console.error('Error performing periodic fetch:')
      console.error(e)
    }

    if (this.stopped) { return }

    const interval = await this.getFetchInterval(repository)
    if (this.stopped) { return }

    // NB: We need to use `window.` here to make sure TypeScript looks at the
    // right type declaration :\
    this.timeoutHandle = window.setTimeout(() => this.performAndScheduleFetch(repository), interval)
  }

  /** Get the allowed fetch interval from the server. */
  private async getFetchInterval(repository: GitHubRepository): Promise<number> {
    const api = new API(this.user)

    let interval = DefaultFetchInterval
    try {
      const pollInterval = await api.getFetchPollInterval(repository.owner.login, repository.name)
      interval = Math.max(pollInterval, MinimumInterval)
    } catch (e) {
      console.error('Error fetching poll interval:')
      console.error(e)
    }

    return interval + skewInterval()
  }

  /** Perform a fetch. */
  private async fetch(): Promise<void> {
    const remote = await LocalGitOperations.getDefaultRemote(this.repository)
    if (!remote) { return }

    return LocalGitOperations.fetch(this.repository, this.user, remote)
  }
}

let _skewInterval: number | null = null

/**
 * The milliseconds by which the fetch interval should be skewed, to prevent
 * clients from accidentally syncing up.
 */
function skewInterval(): number {
  if (_skewInterval !== null) {
    return _skewInterval!
  }

  const skew = Math.ceil(Math.random() * SkewUpperBound)
  _skewInterval = skew
  return skew
}
