export type ReviewIdentity = Readonly<{
  id: string
  headRef: string | null
  baseRef: string
  detachedHeadOid: string | null
}>

export type ReviewGeneration = Readonly<{
  id: string
  baseOid: string
  mergeBaseOid: string
  headOid: string
}>

export type ReviewFileKind = "added" | "modified" | "deleted" | "renamed" | "copied" | "binary"

export type ReviewHunk = Readonly<{
  /** Stable ordering within the file; not part of digest (geometry + lines define identity). */
  index: number
  oldStart: number
  oldCount: number
  newStart: number
  newCount: number
  /** Normalized lines as produced by the patch parser; caller must normalize before constructing. */
  lines: readonly string[]
  /** Stable digest over old/new start/count + normalized lines; excludes index. */
  digest: string
}>

export type ReviewCommit = Readonly<{
  oid: string
  parents: readonly string[]
  author: string
  timestamp: number
  subject: string
  body: string
}>

export type ReviewFile = Readonly<{
  key: string
  path: string
  previousPath?: string
  kind: ReviewFileKind
  oldBlobOid: string | null
  newBlobOid: string | null
  oldMode: string | null
  newMode: string | null
  contentId: string
  patchDigest: string
  stats: Readonly<{ additions: number | null; deletions: number | null }>
  hunks: readonly ReviewHunk[]
  source: "available" | "binary" | "too-large" | "unavailable"
}>

export type ReviewDocument = Readonly<{
  identity: ReviewIdentity
  generation: ReviewGeneration
  commits: readonly ReviewCommit[]
  files: readonly ReviewFile[]
  aggregatePatchDigest: string
}>

export type ReviewDocumentIndex = Readonly<{
  fileByKey: ReadonlyMap<string, ReviewFile>
  fileIndexByKey: ReadonlyMap<string, number>
  commitByOid: ReadonlyMap<string, ReviewCommit>
}>
export type ReviewAnchor =
  | Readonly<{ kind: "file"; fileKey: string; contentId: string }>
  | Readonly<{
      kind: "range"
      fileKey: string
      contentId: string
      side: "old" | "new"
      startLine: number
      endLine: number
      ownerHunkIndex: number
      contextDigest: string
    }>

export type ReviewFeedback = Readonly<{
  id: string
  kind: "note" | "suggestion"
  severity: "comment" | "blocking"
  body: string
  replacement?: string
  anchor: ReviewAnchor
  resolution: "active" | "stale" | "orphaned"
  createdAt: string
  updatedAt: string
}>

export type ReviewFeedbackDraft = Readonly<{
  anchor: ReviewAnchor
  kind: "note" | "suggestion"
  severity: "comment" | "blocking"
  body: string
  replacement?: string
}>
export type ReviewProjection = Readonly<
  | { kind: "aggregate" }
  | { kind: "since-last-review"; fromHeadOid: string }
  | { kind: "commit"; oid: string }
>


export type ReviewProjectionDocument = Readonly<{
  reviewId: string
  generationId: string
  projection: ReviewProjection
  files: readonly ReviewFile[]
}>

export type SourceContextRequest = Readonly<{
  reviewId: string
  generationId: string
  fileKey: string
  side: "old" | "new"
  startLine: number
  endLine: number
}>

export type SourceContextResult = Readonly<{
  reviewId: string
  generationId: string
  fileKey: string
  side: "old" | "new"
  startLine: number
  lines: readonly string[]
}>
