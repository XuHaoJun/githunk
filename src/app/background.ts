/**
 * The background routines lazygit runs for the life of the app — pkg/gui/background.go.
 *
 *   - a `git fetch` every `refresher.fetchInterval` seconds, gated on `git.autoFetch`
 *   - a working-tree refresh every `refresher.refreshInterval` seconds, gated on `git.autoRefresh`
 *   - a refs-snapshot poll every `refresher.externalChangeCheckInterval` seconds, gated on
 *     `git.autoDetectExternalChanges`, which refreshes when refs moved outside the app
 *
 * and the two properties that make them safe:
 *
 *   - **paused while the app drives git itself.** `goEvery`'s `doit` returns early when
 *     `backgroundRefreshesPaused()` (background.go:219-221), so a fetch never lands in the middle
 *     of a rebase the user started.
 *   - **never bunched.** `goEvery` waits for each run to finish before the next one starts
 *     (background.go:230-236), so a fetch slower than the interval does not queue more fetches
 *     behind it. Timers here are one-shot and rescheduled on completion, which has the same effect.
 */

export type Timers = {
  setTimeout(callback: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

export type BackgroundRefresherOptions = {
  /** `git fetch`, and whatever refresh the caller wants to follow it. */
  readonly fetch: () => Promise<void>
  /** The working-tree refresh; lazygit's `RefreshOptions{Scope: []{FILES}}`. */
  readonly refresh: () => Promise<void>
  /**
   * One refs-snapshot poll; see ./refs-watcher, which owns the comparison. lazygit's
   * `checkForExternalChanges` (pkg/gui/background.go:169-208).
   */
  readonly detectExternalChanges?: () => Promise<void>
  /** `git.autoFetch` — pkg/config/user_config.go:958. */
  readonly autoFetch?: boolean
  /** `git.autoRefresh` — pkg/config/user_config.go:959. */
  readonly autoRefresh?: boolean
  /** `refresher.fetchInterval`, in milliseconds. Default 60s. */
  readonly fetchIntervalMs?: number
  /** `git.autoDetectExternalChanges` — pkg/config/user_config.go:960. */
  readonly autoDetectExternalChanges?: boolean
  /** `refresher.refreshInterval`, in milliseconds. Default 10s. */
  readonly refreshIntervalMs?: number
  /** `refresher.externalChangeCheckInterval`, in milliseconds. Default 2s. */
  readonly externalChangeIntervalMs?: number
  /**
   * Checked at each tick alongside the pause count, for the callers whose "busy" is a flag they
   * already own rather than a scope they can wrap. Same effect as a pause: the tick is skipped.
   */
  readonly isBusy?: () => boolean
  /** Reported rather than thrown: a background routine must never take the app down. */
  readonly onError?: (error: unknown, routine: RoutineName) => void
  readonly timers?: Timers
}

export const DEFAULT_FETCH_INTERVAL_MS = 60_000
export const DEFAULT_REFRESH_INTERVAL_MS = 10_000
export const DEFAULT_EXTERNAL_CHANGE_INTERVAL_MS = 2_000

export type RoutineName = "fetch" | "refresh" | "external-change"

type Routine = {
  readonly name: RoutineName
  readonly run: () => Promise<void>
  readonly intervalMs: number
  handle: unknown
  running: boolean
}

export class BackgroundRefresher {
  private readonly timers: Timers
  private readonly routines: Routine[] = []
  private readonly onError: ((error: unknown, routine: RoutineName) => void) | undefined
  private started = false
  private stopped = false
  /**
   * A count, not a flag: lazygit's `pauseRefreshesCount` is one too, because the scopes that pause
   * refreshes can overlap (background.go:22-28).
   */
  private pauseCount = 0

  constructor(private readonly options: BackgroundRefresherOptions) {
    this.timers = options.timers ?? {
      setTimeout: (callback, ms) => setTimeout(callback, ms),
      clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    }
    this.onError = options.onError
    if (options.autoFetch !== false) {
      this.routines.push({
        name: "fetch",
        run: options.fetch,
        intervalMs: options.fetchIntervalMs ?? DEFAULT_FETCH_INTERVAL_MS,
        handle: undefined,
        running: false,
      })
    }
    if (options.autoRefresh !== false) {
      this.routines.push({
        name: "refresh",
        run: options.refresh,
        intervalMs: options.refreshIntervalMs ?? DEFAULT_REFRESH_INTERVAL_MS,
        handle: undefined,
        running: false,
      })
    }
    if (options.autoDetectExternalChanges !== false && options.detectExternalChanges !== undefined) {
      this.routines.push({
        name: "external-change",
        run: options.detectExternalChanges,
        intervalMs: options.externalChangeIntervalMs ?? DEFAULT_EXTERNAL_CHANGE_INTERVAL_MS,
        handle: undefined,
        running: false,
      })
    }
  }

  get paused(): boolean {
    return this.pauseCount > 0
  }

  /**
   * lazygit fetches once at startup because `goEvery` begins by waiting out the interval
   * (background.go:135-137) — so an app opened on a stale repo does not sit stale for a minute.
   * The caller drives that first fetch itself rather than having it fire from a constructor.
   */
  start(): void {
    if (this.started || this.stopped) return
    this.started = true
    for (const routine of this.routines) this.schedule(routine)
  }

  stop(): void {
    this.stopped = true
    this.started = false
    for (const routine of this.routines) {
      if (routine.handle !== undefined) this.timers.clearTimeout(routine.handle)
      routine.handle = undefined
    }
  }

  /** `PauseBackgroundRefreshes(true|false)` — background.go:30-35. */
  setPaused(paused: boolean): void {
    this.pauseCount = Math.max(0, this.pauseCount + (paused ? 1 : -1))
  }

  /** Runs `operation` with the background routines paused, however it settles. */
  async whilePaused<T>(operation: () => Promise<T>): Promise<T> {
    this.setPaused(true)
    try {
      return await operation()
    } finally {
      this.setPaused(false)
    }
  }

  private schedule(routine: Routine): void {
    if (this.stopped) return
    routine.handle = this.timers.setTimeout(() => {
      routine.handle = undefined
      void this.tick(routine)
    }, routine.intervalMs)
  }

  private async tick(routine: Routine): Promise<void> {
    if (this.stopped) return
    // A paused tick is skipped, not deferred: the operation holding the pause will refresh when it
    // finishes, and the next tick comes around on its own.
    if (!this.paused && this.options.isBusy?.() !== true && !routine.running) {
      routine.running = true
      try {
        await routine.run()
      } catch (error) {
        this.onError?.(error, routine.name)
      } finally {
        routine.running = false
      }
    }
    this.schedule(routine)
  }
}
