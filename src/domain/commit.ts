import type { DiffDocument } from "./diff/document"

export type CommitSummary = {
  readonly oid: string
  readonly shortOid: string
  readonly parentOids: readonly string[]
  readonly authorName: string
  readonly authoredAt: string
  readonly subject: string
  readonly body: string
}

export type CommitDetails = CommitSummary & {
  readonly document: DiffDocument
  readonly patch: DiffDocument
  readonly raw: string
}
