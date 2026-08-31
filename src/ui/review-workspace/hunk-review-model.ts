import { normalizeReviewDiffMetadata, patchForHunkReviewFile as adapterPatchForHunkReviewFile } from "../../review/git/pierre-diff-adapter"
import type { ReviewDiffMetadata } from "../../review/git/pierre-diff-adapter"
import type { ReviewFile } from "../../review/core/types"

export type ReviewSourceLoader = Readonly<{
  read: (side: "old" | "new", file: ReviewFile) => Promise<readonly string[]>
}>

export type HunkReviewFile = Readonly<{
  id: string
  path: string
  previousPath?: string
  kind: ReviewFile["kind"]
  reviewFile: ReviewFile
  metadata: ReviewDiffMetadata
  sourceLoader?: ReviewSourceLoader
}>

export function patchForHunkReviewFile(file: ReviewFile): string {
  return adapterPatchForHunkReviewFile(file)
}

export function toHunkReviewFile(file: ReviewFile, sourceLoader?: ReviewSourceLoader): HunkReviewFile {
  const metadata = normalizeReviewDiffMetadata(file)
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
