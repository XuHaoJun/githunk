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
