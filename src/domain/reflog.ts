/** Lazygit shortens hashes to eight characters (`utils.COMMIT_HASH_SHORT_SIZE`). */
const SHORT_HASH_LENGTH = 8

export function shortHash(oid: string): string {
  return oid.length <= SHORT_HASH_LENGTH ? oid : oid.slice(0, SHORT_HASH_LENGTH)
}

/**
 * One `git log -g` entry, modelled on lazygit's reflog commit
 * (`pkg/commands/git_commands/reflog_commit_loader.go`): hash, commit
 * timestamp, reflog subject (`%gs`) and parent hashes.
 *
 * The presentation layer (`pkg/gui/presentation/reflog_commits.go`) renders
 * `[shortOid, subject]`, plus a date column between them in full-description
 * mode, so everything a row needs is carried here.
 */
export type ReflogEntry = {
  /** Stable-enough identity for list selection; see `reflogEntryId`. */
  readonly id: string
  readonly oid: string
  readonly shortOid: string
  readonly parentOids: readonly string[]
  /** `%gs`, e.g. `checkout: moving from main to feature`. */
  readonly subject: string
  /**
   * ISO 8601 form of `committedAtUnix`, matching `CommitSummary.authoredAt` so
   * the UI's relative-time formatter takes it unchanged.
   */
  readonly committedAt: string
  /**
   * `%ct` in unix seconds. Note this is the COMMIT's timestamp, not the moment
   * the reflog entry was written, so neighbouring entries often share it.
   */
  readonly committedAtUnix: number
  /** Position in the reflog; 0 is the newest entry. */
  readonly index: number
  /** Git's own name for the entry, e.g. `HEAD@{2}`. */
  readonly selector: string
}

/**
 * `git log -g` reports the COMMIT's hash and timestamp, never the reflog
 * entry's, so two consecutive entries routinely share both — walking away from
 * a commit and back again produces two rows pointing at the same object.
 * lazygit disambiguates with the reflog subject and openly hopes an identical
 * subject never appears twice in a row; a hash+subject id would still collide
 * there (`checkout: moving from main to feature` can repeat), so the id also
 * carries how many identical pairs preceded this one.
 *
 * `occurrence` counts from the newest entry, which keeps an id stable across a
 * refresh unless a *newer* duplicate of the same pair lands in between — the
 * same assumption lazygit makes. Counting from the oldest end would be worse:
 * the tail moves whenever the load cap bites or `git reflog expire` runs.
 * Occurrence precedes the subject so a subject that itself ends in `#1` cannot
 * forge another entry's id.
 */
export function reflogEntryId(oid: string, subject: string, occurrence: number): string {
  return `${oid}:${occurrence}:${subject}`
}
