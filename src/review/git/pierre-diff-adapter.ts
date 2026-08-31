import { parsePatchFiles, type FileDiffMetadata } from "@pierre/diffs"
import type { ReviewFile } from "../core/types"

export type ReviewDiffHunk = Readonly<{
  hunkSpecs?: string
  deletionStart: number
  deletionCount: number
  additionStart: number
  additionCount: number
  deletionLineIndex: number
  additionLineIndex: number
  collapsedBefore: number
  hunkContent: readonly Readonly<{
    type: "context" | "change"
    lines: number
    deletions: number
    additions: number
  }>[]
}>

export type ReviewDiffMetadata = Readonly<{
  name: string
  prevName?: string
  type: "new" | "deleted" | "change" | "rename-pure" | "rename-changed"
  hunks: readonly ReviewDiffHunk[]
  deletionLines: readonly string[]
  additionLines: readonly string[]
  splitLineCount: number
  unifiedLineCount: number
  isPartial: boolean
  cacheKey: string
}>

function normalizePath(path: string | undefined): string {
  return (path ?? "").replace(/^[ab]\//, "").replace(/[\r\n]+$/u, "")
}

function prefixedPath(path: string, prefix: "a" | "b"): string {
  return `${prefix}/${path}`
}

function hunkText(hunk: ReviewFile["hunks"][number]): string {
  const header = `@@ -${hunk.oldStart},${hunk.oldCount} +${hunk.newStart},${hunk.newCount} @@`
  return `${header}\n${hunk.lines.join("\n")}`
}

function patchForFile(file: ReviewFile): string {
  const oldPath = file.previousPath ?? file.path
  const oldHeader = file.kind === "added" ? "/dev/null" : prefixedPath(oldPath, "a")
  const newHeader = file.kind === "deleted" ? "/dev/null" : prefixedPath(file.path, "b")
  const lines = [`diff --git ${prefixedPath(oldPath, "a")} ${prefixedPath(file.path, "b")}`]

  if (file.kind === "renamed" || file.kind === "copied") {
    lines.push(`${file.kind === "renamed" ? "rename" : "copy"} from ${oldPath}`)
    lines.push(`${file.kind === "renamed" ? "rename" : "copy"} to ${file.path}`)
  }

  if (file.kind === "binary" || file.source === "binary") {
    lines.push(`Binary files ${oldHeader} and ${newHeader} differ`)
    return `${lines.join("\n")}\n`
  }

  lines.push(`--- ${oldHeader}`, `+++ ${newHeader}`)
  for (const hunk of file.hunks) lines.push(hunkText(hunk))
  return `${lines.join("\n")}\n`
}

function diffType(file: ReviewFile): ReviewDiffMetadata["type"] {
  if (file.kind === "added") return "new"
  if (file.kind === "deleted") return "deleted"
  if (file.kind === "renamed") return file.hunks.length === 0 ? "rename-pure" : "rename-changed"
  return "change"
}

function cacheKey(file: ReviewFile): string {
  return `${file.contentId}:${file.patchDigest}`
}

function fallbackMetadata(file: ReviewFile): ReviewDiffMetadata {
  return {
    name: file.path,
    ...(file.previousPath ? { prevName: file.previousPath } : {}),
    type: diffType(file),
    hunks: [],
    deletionLines: [],
    additionLines: [],
    splitLineCount: 0,
    unifiedLineCount: 0,
    isPartial: true,
    cacheKey: cacheKey(file),
  }
}

function normalizeHunk(hunk: FileDiffMetadata["hunks"][number]): ReviewDiffHunk {
  return {
    ...(hunk.hunkSpecs === undefined ? {} : { hunkSpecs: hunk.hunkSpecs }),
    deletionStart: hunk.deletionStart,
    deletionCount: hunk.deletionCount,
    additionStart: hunk.additionStart,
    additionCount: hunk.additionCount,
    deletionLineIndex: hunk.deletionLineIndex,
    additionLineIndex: hunk.additionLineIndex,
    collapsedBefore: hunk.collapsedBefore,
    hunkContent: hunk.hunkContent.map((content) => content.type === "context"
      ? { type: "context", lines: content.lines, deletions: 0, additions: 0 }
      : { type: "change", lines: Math.max(content.deletions, content.additions), deletions: content.deletions, additions: content.additions }),
  }
}

function normalizeMetadata(file: ReviewFile, metadata: FileDiffMetadata): ReviewDiffMetadata {
  return {
    name: file.path,
    ...(file.previousPath ? { prevName: file.previousPath } : {}),
    type: diffType(file),
    hunks: metadata.hunks.map(normalizeHunk),
    deletionLines: metadata.deletionLines.slice(),
    additionLines: metadata.additionLines.slice(),
    splitLineCount: metadata.splitLineCount,
    unifiedLineCount: metadata.unifiedLineCount,
    isPartial: metadata.isPartial,
    cacheKey: metadata.cacheKey ?? cacheKey(file),
  }
}

/**
 * Build renderer-owned diff metadata for one review file. Pierre parser
 * objects are normalized here so no parser-specific fields or types cross into
 * the review UI. The input file identity always wins over parser paths/types.
 */
const metadataCache = new WeakMap<ReviewFile, ReviewDiffMetadata>()

export function normalizeReviewDiffMetadata(file: ReviewFile): ReviewDiffMetadata {
  const cached = metadataCache.get(file)
  if (cached) return cached

  const patch = patchForFile(file)
  let normalized: ReviewDiffMetadata | undefined
  try {
    const parsed = parsePatchFiles(patch, `${file.key}:${file.patchDigest}`, true)
    const metadata = parsed
      .flatMap((entry) => entry.files)
      .find((candidate) => normalizePath(candidate.name) === file.path || normalizePath(candidate.prevName) === file.path)
    const first = metadata ?? parsed[0]?.files[0]
    if (first) normalized = normalizeMetadata(file, first)
  } catch {
    // Keep the file visible with stable identity when malformed patches cannot be parsed.
  }
  normalized ??= fallbackMetadata(file)
  metadataCache.set(file, normalized)
  return normalized
}

export function patchForHunkReviewFile(file: ReviewFile): string {
  return patchForFile(file)
}

export function normalizeReviewDiffLine(contents: string): string {
  let end = contents.length
  if (contents.charCodeAt(end - 1) === 10) {
    end -= 1
    if (contents.charCodeAt(end - 1) === 13) end -= 1
  }
  return contents.slice(0, end)
}
