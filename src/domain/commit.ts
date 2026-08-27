import type { DiffDocument } from "./diff/document"

/**
 * lazygit's `models.CommitStatus` (pkg/commands/models/commit.go), restricted to the three values
 * a plain `git log` listing can produce. `StatusRebasing`, `StatusCherryPickingOrReverting`,
 * `StatusConflicted` and `StatusReflog` belong to rows githunk's Commits panel does not yet build
 * (rebase todos and the sequencer, and the Reflog tab which colours its own hashes blue), so they
 * are absent rather than unreachable.
 */
export type CommitStatus = "unpushed" | "pushed" | "merged"

export type CommitSummary = {
  readonly oid: string
  readonly shortOid: string
  readonly parentOids: readonly string[]
  readonly authorName: string
  readonly authoredAt: string
  readonly subject: string
  readonly body: string
  /** Absent when the pushed/merged reachability queries were not run (injected loaders, tests). */
  readonly status?: CommitStatus
}

export type CommitDetails = CommitSummary & {
  readonly document: DiffDocument
  readonly patch: DiffDocument
  readonly raw: string
  // TODO Task 5: make required once fixtures updated
  readonly preamble?: string
}
