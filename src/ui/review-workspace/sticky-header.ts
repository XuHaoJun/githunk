import type { ReviewState } from "../../review/core/state"
import type { HunkReviewFile } from "./hunk-review-model"
import { hunkHeaderText } from "./hunk-diff-rows"
import { hunkSectionRowOffset } from "./components/ReviewDiffSection"

/**
 * Which file and hunk the reviewer is inside at the top of the diff viewport.
 *
 * lazygit renders the main panel as captured pager output and scrolls it as
 * opaque text, so it cannot answer this question — the `diff --git` / `@@`
 * headers simply scroll away (jesseduffield/lazygit#5836). githunk's stream is
 * a row model with known geometry, so the answer is a lookup rather than a
 * parse of rendered text.
 */
export type StickyDiffHeader = Readonly<{
  fileKey: string
  filePath: string
  /** Index of the enclosing hunk, or -1 above the first hunk header of the file. */
  hunkIndex: number
  hunkText?: string
}>

export type StickyDiffHeaderRequest = Readonly<{
  files: readonly HunkReviewFile[]
  state: ReviewState
  layout: "split" | "stack"
  scrollTop: number
  /**
   * Absolute first row of each section plus a trailing total, exactly as
   * `ReviewDiffPane.sectionWindow` computes it. Passed in rather than
   * recomputed so the sticky header can never disagree with what is rendered.
   */
  sectionOffsets: readonly number[]
  expandedSourceByGap?: ReadonlyMap<string, readonly string[]>
}>

/** First row of a section's own header: every section but the first leads with a divider. */
function headerTopOf(sectionOffsets: readonly number[], index: number): number {
  return (sectionOffsets[index] ?? 0) + (index > 0 ? 1 : 0)
}

function sectionIndexAt(sectionOffsets: readonly number[], fileCount: number, top: number): number {
  // Hand off only once the incoming file's own header row has scrolled through
  // the top, so its divider and header still read as the outgoing file and the
  // real header is seen exactly once instead of flashing against a pinned copy.
  // Matches hunk, which solved the same problem first:
  // learn-projects/hunk/src/ui/lib/fileSectionLayout.ts:149-160 and
  // learn-projects/hunk/src/ui/components/panes/DiffPane.tsx:962-966.
  let index = 0
  while (index < fileCount - 1 && headerTopOf(sectionOffsets, index + 1) < top) index += 1
  return index
}

export function resolveStickyDiffHeader(request: StickyDiffHeaderRequest): StickyDiffHeader | undefined {
  const { files, state, layout, sectionOffsets, expandedSourceByGap } = request
  if (files.length === 0) return undefined

  const top = Math.max(0, Math.floor(request.scrollTop))
  const fileIndex = sectionIndexAt(sectionOffsets, files.length, top)
  const file = files[fileIndex]
  if (!file) return undefined

  const localRow = top - (sectionOffsets[fileIndex] ?? 0)
  // `showDivider` matches ReviewDiffPane: every section but the first leads with one.
  const showDivider = fileIndex > 0

  let hunkIndex = -1
  for (let candidate = 0; candidate < file.metadata.hunks.length; candidate += 1) {
    const headerRow = hunkSectionRowOffset(file, layout, candidate, state, expandedSourceByGap, showDivider)
    if (headerRow > localRow) break
    hunkIndex = candidate
  }

  return {
    fileKey: file.id,
    filePath: file.path,
    hunkIndex,
    ...(hunkIndex < 0 ? {} : { hunkText: hunkHeaderText(file, hunkIndex) }),
  }
}
