import { sha256Tuple } from "./identity"
import type { ReviewCommit, ReviewDocument, ReviewDocumentIndex, ReviewFile, ReviewHunk } from "./types"

export function createReviewHunk(input: Omit<ReviewHunk, "digest">): ReviewHunk {
  const digest = sha256Tuple([
    String(input.oldStart),
    String(input.oldCount),
    String(input.newStart),
    String(input.newCount),
    ...input.lines,
  ])
  return { ...input, lines: [...input.lines], digest }
}

export function createReviewDocument(input: {
  identity: ReviewDocument["identity"]
  generation: ReviewDocument["generation"]
  commits: readonly ReviewCommit[]
  files: readonly ReviewFile[]
  aggregatePatchDigest?: string
}): ReviewDocument {
  const commits = [...input.commits]
  const files = [...input.files]

  const commitOids = new Set<string>()
  for (const commit of commits) {
    if (commitOids.has(commit.oid)) throw new Error(`duplicate commit oid: ${commit.oid}`)
    commitOids.add(commit.oid)
  }

  const fileKeys = new Set<string>()
  const filePaths = new Set<string>()
  for (const file of files) {
    if (fileKeys.has(file.key)) throw new Error(`duplicate file key: ${file.key}`)
    fileKeys.add(file.key)
    if (filePaths.has(file.path)) throw new Error(`duplicate file path: ${file.path}`)
    filePaths.add(file.path)
  }

  const aggregatePatchDigest =
    input.aggregatePatchDigest ?? sha256Tuple(files.map((f) => f.patchDigest))

  return {
    identity: input.identity,
    generation: input.generation,
    commits: Object.freeze([...commits]),
    files: Object.freeze([...files]),
    aggregatePatchDigest,
  }
}

export function indexReviewDocument(document: ReviewDocument): ReviewDocumentIndex {
  const fileByKey = new Map<string, ReviewFile>()
  const fileIndexByKey = new Map<string, number>()
  const commitByOid = new Map<string, ReviewCommit>()

  for (const commit of document.commits) {
    if (commitByOid.has(commit.oid)) throw new Error(`duplicate commit oid: ${commit.oid}`)
    commitByOid.set(commit.oid, commit)
  }

  document.files.forEach((file, index) => {
    if (fileByKey.has(file.key)) throw new Error(`duplicate file key: ${file.key}`)
    fileByKey.set(file.key, file)
    fileIndexByKey.set(file.key, index)
  })

  // Validate duplicate paths as well (mirrors createReviewDocument invariant)
  const seenPaths = new Set<string>()
  for (const file of document.files) {
    if (seenPaths.has(file.path)) throw new Error(`duplicate file path: ${file.path}`)
    seenPaths.add(file.path)
  }

  return {
    fileByKey,
    fileIndexByKey,
    commitByOid,
  }
}
