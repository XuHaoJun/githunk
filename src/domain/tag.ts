import type { CommitSummary } from "./commit"

export type TagSummary = {
  readonly name: string
  readonly ref: string
  readonly kind: "annotated" | "lightweight"
  readonly objectOid: string
  readonly targetOid: string
  readonly subject: string
  readonly taggerName?: string
  readonly taggedAt?: string
  readonly message?: string
}

export type TagPreview = TagSummary & { readonly targetCommit: CommitSummary }
