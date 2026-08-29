import type { ReviewState, ReviewSelection, ReviewRevealIntent } from "./state"
import { visibleReviewFiles } from "./selectors"

export type ReviewNavigationMove = Readonly<{ unit: "file" | "hunk"; direction: "next" | "previous" }>
export type ReviewNavigationTarget = Readonly<{
  selection: ReviewSelection
  reveal: ReviewRevealIntent
}>

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

function indexOfFile(files: readonly { key: string }[], fileKey: string | null): number {
  if (fileKey === null) return -1
  return files.findIndex((f) => f.key === fileKey)
}

function hunkCountForFile(state: ReviewState, fileKey: string): number {
  const file = state.document.files.find((f) => f.key === fileKey)
  return file?.hunks.length ?? 0
}

export function moveReviewSelection(
  state: ReviewState,
  unit: "file" | "hunk",
  direction: "next" | "previous",
): ReviewNavigationTarget | null {
  const visible = visibleReviewFiles(state) as readonly { key: string }[]
  if (visible.length === 0) return null

  const current = state.selection
  // If selection is null (empty doc already handled) or not in visible, anchor to first visible
  const currentVisibleIndex = indexOfFile(visible, current.fileKey)
  // For hunk navigation we may need to flatten hunks
  if (unit === "file") {
    const delta = direction === "next" ? 1 : -1
    const nextIndex = currentVisibleIndex < 0
      ? direction === "next" ? 0 : visible.length - 1
      : clamp(currentVisibleIndex + delta, 0, visible.length - 1)
    if (currentVisibleIndex >= 0 && nextIndex === currentVisibleIndex) return null
    const nextFile = visible[nextIndex]!
    return {
      selection: { fileKey: nextFile.key, hunkIndex: 0 },
      reveal: {
        fileTopToken: state.reveal.fileTopToken + 1,
        fileTopRequestToken: state.reveal.fileTopRequestToken + 1,
        hunkToken: state.reveal.hunkToken,
        scrollToFeedback: false,
      },
    }
  }

  // unit === "hunk" — flatten visible files' hunks into cursors
  const cursors: { fileKey: string; hunkIndex: number }[] = []
  for (const vf of visible) {
    const count = hunkCountForFile(state, vf.key)
    // Files with no hunks still have one selectable position (hunkIndex 0)
    const hunkCount = count === 0 ? 1 : count
    for (let i = 0; i < hunkCount; i++) cursors.push({ fileKey: vf.key, hunkIndex: i })
  }
  if (cursors.length === 0) return null

  let currentCursorIndex = cursors.findIndex((c) => c.fileKey === current.fileKey && c.hunkIndex === current.hunkIndex)
  if (currentCursorIndex < 0) {
    // A filtered-out selection has no cursor; begin from the nearest visible boundary.
    if (current.fileKey !== null) {
      const fileIdx = indexOfFile(visible, current.fileKey)
      if (fileIdx >= 0) currentCursorIndex = cursors.findIndex((c) => c.fileKey === current.fileKey)
    }
    if (currentCursorIndex < 0) currentCursorIndex = direction === "next" ? -1 : cursors.length
  }

  const delta = direction === "next" ? 1 : -1
  const nextIndex = clamp(currentCursorIndex + delta, 0, cursors.length - 1)
  if (nextIndex === currentCursorIndex) return null
  const next = cursors[nextIndex]!
  // Forward cross-file hunk navigation owns the file header; backward navigation must keep the hunk reveal.
  const crossesFile = next.fileKey !== current.fileKey
  const crossesFileForward = crossesFile && direction === "next"
  return {
    selection: { fileKey: next.fileKey, hunkIndex: next.hunkIndex },
    reveal: crossesFile
      ? {
          fileTopToken: state.reveal.fileTopToken + 1,
          fileTopRequestToken: crossesFileForward ? state.reveal.fileTopRequestToken + 1 : state.reveal.fileTopRequestToken,
          hunkToken: state.reveal.hunkToken,
          scrollToFeedback: false,
        }
      : {
          fileTopToken: state.reveal.fileTopToken,
          fileTopRequestToken: state.reveal.fileTopRequestToken,
          hunkToken: state.reveal.hunkToken + 1,
          scrollToFeedback: false,
        },
  }
}
