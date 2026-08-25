/**
 * Notices refs changing underneath the app, and refreshes when they do.
 *
 * lazygit's `checkForExternalChanges` (pkg/gui/background.go:169-208) plus the snapshot bookkeeping
 * in its refresh helper (`SetRefsSnapshot` / `RefsSnapshotChangedSince`,
 * pkg/gui/controllers/helpers/refresh_helper.go:592-617). The shape that matters:
 *
 *   - **No baseline means no change.** Until one snapshot has been taken there is nothing to
 *     compare against, so the first poll seeds the baseline and reports nothing. Otherwise every
 *     start-up would fire a spurious refresh.
 *   - **A change seen while the app is busy is not ours to act on.** The operation holding the app
 *     busy is mid-flight, so what the poll saw is its own intermediate state; the baseline is left
 *     alone so nothing is swallowed, and the next poll after it settles sees the truth.
 *   - **Everything the app does itself re-seeds the baseline.** `resync` is called after each of
 *     githunk's own git operations and refreshes, so a commit made *in* githunk cannot look like a
 *     commit made outside it.
 */
export type RefsWatcherOptions = {
  /** Reads the current fingerprint; see ../git/refs-snapshot. */
  readonly snapshot: () => Promise<string>
  /** Runs when the fingerprint moved without githunk having moved it. */
  readonly onExternalChange: () => Promise<void>
  /** Whether githunk is driving git right now. */
  readonly isBusy?: () => boolean
}

export class RefsWatcher {
  private baseline: string | undefined

  constructor(private readonly options: RefsWatcherOptions) {}

  /** The fingerprint the next poll compares against, for tests and diagnostics. */
  get lastSnapshot(): string | undefined {
    return this.baseline
  }

  /**
   * Takes a snapshot and stores it as the baseline without refreshing anything. Called after
   * githunk's own operations, so their effect on refs is never mistaken for an external change.
   */
  async resync(): Promise<void> {
    const current = await this.capture()
    if (current !== undefined) this.baseline = current
  }

  /** One poll. Returns whether it decided the change was external and refreshed. */
  async check(): Promise<boolean> {
    const current = await this.capture()
    if (current === undefined) return false
    if (this.baseline === undefined) {
      this.baseline = current
      return false
    }
    if (current === this.baseline) return false
    if (this.options.isBusy?.() === true) return false
    this.baseline = current
    await this.options.onExternalChange()
    return true
  }

  /**
   * A failed snapshot leaves the baseline alone: the git process could not start, or a concurrent
   * operation had the repo mid-write. Either way the next poll retries, and nothing is swallowed.
   */
  private async capture(): Promise<string | undefined> {
    try {
      return await this.options.snapshot()
    } catch {
      return undefined
    }
  }
}
