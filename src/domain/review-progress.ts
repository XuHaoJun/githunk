export type ReviewFileState = "not-reviewed" | "reviewing" | "reviewed" | "changed-after-review"

export type ReviewFileRecord = {
  readonly reviewedFingerprint: string
  readonly reviewedAt: string
}

export type ReviewTargetRecord = {
  readonly files: Record<string, ReviewFileRecord>
}

export type ReviewDatabase = {
  readonly version: 1
  readonly baseByBranch: Record<string, { readonly ref: string }>
  readonly targets: Record<string, ReviewTargetRecord>
}

export function reviewStateFor(record: ReviewFileRecord | undefined, currentFingerprint: string): ReviewFileState {
  if (record === undefined) return "not-reviewed"
  return record.reviewedFingerprint === currentFingerprint ? "reviewed" : "changed-after-review"
}
