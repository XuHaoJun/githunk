import { parsePatchFiles, type FileDiffMetadata } from "@pierre/diffs"
import type { ReviewFile, ReviewHunk } from "../../review/core/types"

export type ReviewSourceLoader = Readonly<{
  read: (side: "old" | "new", file: ReviewFile) => Promise<readonly string[]>
}>

export type HunkReviewFile = Readonly<{
  id: string
  path: string
  previousPath?: string
  kind: ReviewFile["kind"]
  reviewFile: ReviewFile
  metadata: FileDiffMetadata
  sourceLoader?: ReviewSourceLoader
}>

const metadataCache = new WeakMap<ReviewFile, FileDiffMetadata>()

function prefixedPath(path: string, prefix: "a" | "b"): string {
  return `${prefix}/${path}`
}

function hunkText(hunk: ReviewHunk): string {
  const header = `@@ -${hunk.oldStart},${hunk.oldCount} +${hunk.newStart},${hunk.newCount} @@`
  return `${header}\n${hunk.lines.join("\n")}`
}

function filePatch(file: ReviewFile): string {
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

function normalizePath(path: string | undefined): string {
  return (path ?? "").replace(/^[ab]\//, "").replace(/[\r\n]+$/u, "")
}

function pierreType(file: ReviewFile): FileDiffMetadata["type"] {
  if (file.kind === "added") return "new"
  if (file.kind === "deleted") return "deleted"
  if (file.kind === "renamed") return file.hunks.length === 0 ? "rename-pure" : "rename-changed"
  return "change"
}

function fallbackMetadata(file: ReviewFile): FileDiffMetadata {
  return {
    name: file.path,
    ...(file.previousPath ? { prevName: file.previousPath } : {}),
    type: pierreType(file),
    hunks: [],
    splitLineCount: 0,
    unifiedLineCount: 0,
    isPartial: true,
    deletionLines: [],
    additionLines: [],
    cacheKey: `${file.contentId}:${file.patchDigest}`,
  }
}

function parseMetadata(file: ReviewFile): FileDiffMetadata {
  const patch = filePatch(file)
  const applyIdentity = (metadata: FileDiffMetadata): FileDiffMetadata => ({
    ...metadata,
    name: file.path,
    ...(file.previousPath ? { prevName: file.previousPath } : {}),
    type: pierreType(file),
  })
  try {
    const parsed = parsePatchFiles(patch, `${file.key}:${file.patchDigest}`, true)
    const metadata = parsed
      .flatMap((entry) => entry.files)
      .find((candidate) => normalizePath(candidate.name) === file.path || normalizePath(candidate.prevName) === file.path)
    if (metadata) return applyIdentity(metadata)
    if (parsed.length === 1 && parsed[0]?.files[0]) return applyIdentity(parsed[0].files[0])
  } catch {
    // The renderer keeps a real file row even when a malformed patch cannot be parsed.
  }
  return fallbackMetadata(file)
}

export function patchForHunkReviewFile(file: ReviewFile): string {
  return filePatch(file)
}

export function toHunkReviewFile(file: ReviewFile, sourceLoader?: ReviewSourceLoader): HunkReviewFile {
  const cached = metadataCache.get(file)
  const metadata = cached ?? parseMetadata(file)
  if (!cached) metadataCache.set(file, metadata)
  return {
    id: file.key,
    path: file.path,
    ...(file.previousPath ? { previousPath: file.previousPath } : {}),
    kind: file.kind,
    reviewFile: file,
    metadata,
    ...(sourceLoader ? { sourceLoader } : {}),
  }
}

export function toHunkReviewFiles(
  files: readonly ReviewFile[],
  sourceLoader?: ReviewSourceLoader,
): readonly HunkReviewFile[] {
  return files.map((file) => toHunkReviewFile(file, sourceLoader))
}
