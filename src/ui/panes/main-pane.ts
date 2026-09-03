import type { CliRenderer } from "@opentui/core"
import type { AppModel } from "../../app/model"
import type { DiffDocument, DiffFile } from "../../domain/diff/document"
import type { DocumentSelection } from "../../domain/diff/selection"
import { renderDiff } from "../../domain/diff/render"
import { changedIndexesInDiffLineRange, createDiffLineRangeState, diffLineSelectionRange, type DiffLineRangeState } from "../../domain/diff/line-selection"
import type { AnsiText } from "../ansi"
import { createPane, type PaneHandle } from "./common"
import { installAnsiText, releaseAnsiText } from "./ansi-text"
import { installDiffText, releaseDiffText } from "./diff-text"
import { SELECTED_LINE_BG } from "../theme"
import { createVirtualMainPane, isVirtualDiffDocument, virtualMainPaneFor } from "./virtual-main-pane"
export { virtualMainPaneFor } from "./virtual-main-pane"

// Main generation has no patch threshold — all patches go through preview gate (Task 7)

const documents = new WeakMap<PaneHandle, DiffDocument>()
const cursorTargets = new WeakMap<PaneHandle, MainCursorTarget>()
const lineRanges = new WeakMap<PaneHandle, DiffLineRangeState>()
const installedContents = new WeakMap<PaneHandle, MainPaneContent>()
const renderedTexts = new WeakMap<PaneHandle, string>()
const paneTitles = new WeakMap<PaneHandle, string>()

export type MainCursorTarget = {
  readonly fileIndex: number
  readonly hunkIndex?: number
  readonly filePath?: string
  readonly hunkKey?: string
}

export type MainPaneContent = {
  readonly source: "files" | "local-branch" | "remote" | "remote-branch" | "tag" | "commit" | "commit-file" | "stash" | "reflog" | "worktree" | "submodule"
  readonly stableId: string
  readonly label: string
  readonly preamble?: string
  readonly document?: DiffDocument
  /**
   * A git command's own coloured output, already parsed by ../ansi. lazygit renders a ref's
   * `git log --graph` this way for every panel-3 selection — branches_controller.go:207,
   * remote_branches_controller.go:122, tags_controller.go:109.
   */
  readonly ansi?: AnsiText
  readonly plainText?: string
}

/**
 * The titles lazygit gives the main view per panel-3 selection. The panel, not the selected ref,
 * names the view: `self.c.Tr.LogTitle` for a local branch (branches_controller.go:221,
 * pkg/i18n/english.go:1183), then the literals `"Remote Branch"`
 * (remote_branches_controller.go:129), `"Remote"` (remotes_controller.go:119) and `"Tag"`
 * (tags_controller.go:117).
 */
export const MAIN_TITLE_LOG = "Log"
export const MAIN_TITLE_REMOTE_BRANCH = "Remote Branch"
export const MAIN_TITLE_REMOTE = "Remote"
export const MAIN_TITLE_TAG = "Tag"

type MainTextSelectionSurface = {
  setSelection?: (start: number, end: number) => void
  resetSelection?: () => void
  readonly textBufferView?: {
    setSelection(start: number, end: number, bgColor?: unknown, fgColor?: unknown): void
    resetSelection(): void
  }
  readonly _ctx?: { clearSelection?: () => void }
  requestRender?: () => void
}

function ensureMainTextSelectionSurface(pane: PaneHandle): void {
  const surface = pane.text as unknown as MainTextSelectionSurface
  if (surface.setSelection === undefined && surface.textBufferView !== undefined) {
    surface.setSelection = (start, end) => {
      surface._ctx?.clearSelection?.()
      surface.textBufferView!.setSelection(start, end, pane.text.selectionBg)
      surface.requestRender?.()
    }
  }
  if (surface.resetSelection === undefined && surface.textBufferView !== undefined) {
    surface.resetSelection = () => {
      surface._ctx?.clearSelection?.()
      surface.textBufferView!.resetSelection()
      surface.requestRender?.()
    }
  }
}
export function createMainPane(renderer: CliRenderer, _model: AppModel): PaneHandle {
  const pane = createPane(renderer, "main", "0 Main", "", true)
  pane.text.selectionBg = SELECTED_LINE_BG
  ensureMainTextSelectionSurface(pane)
  createVirtualMainPane(pane)
  // content will be installed via gate; keep placeholder until first install
  pane.box.title = "0 Main"
  paneTitles.set(pane, "0 Main")
  return pane
}

export type MainDiffLineSelection = {
  readonly document: DiffDocument
  readonly state: DiffLineRangeState
  readonly indexes: readonly number[]
  readonly startUtf16: number
  readonly endUtf16: number
  readonly displayStartUtf16: number
  readonly displayEndUtf16: number
}

export function getMainDiffLineRangeState(pane: PaneHandle): DiffLineRangeState | undefined {
  return lineRanges.get(pane)
}

function normalizedPreamble(preamble: string): string {
  return preamble.length === 0 || preamble.endsWith("\n") ? preamble : `${preamble}\n`
}
function renderedLineStarts(text: string): readonly number[] {
  const starts: number[] = [0]
  for (let index = text.indexOf("\n"); index >= 0; index = text.indexOf("\n", index + 1)) starts.push(index + 1)
  return starts
}

function mainDiffLineOffsets(document: DiffDocument, startIndex: number, endIndex: number, preamble: string): {
  readonly startUtf16: number
  readonly endUtf16: number
  readonly displayStartUtf16: number
  readonly displayEndUtf16: number
} | undefined {
  const first = document.lines[startIndex]
  const last = document.lines[endIndex]
  if (first === undefined || last === undefined) return undefined
  const rendered = renderDiff(document)
  const { displayText } = rendered
  const starts = renderedLineStarts(displayText)
  if (startIndex >= starts.length || endIndex >= starts.length) return undefined
  const firstStart = starts[startIndex]
  const lastStart = starts[endIndex]
  if (firstStart === undefined || lastStart === undefined) return undefined
  // Avoid displayText.split("\n") — for a 75k-line patch that allocates ~75k strings
  // plus a number array per keystroke. Derive the last display line length from the
  // starts index instead: next start minus one newline, or tail to end of text.
  const lastLineEnd = endIndex + 1 < starts.length ? starts[endIndex + 1]! - 1 : displayText.length
  const lastLength = lastLineEnd - lastStart
  const preambleLength = normalizedPreamble(preamble).length
  return {
    startUtf16: first.startUtf16,
    endUtf16: last.endUtf16,
    displayStartUtf16: preambleLength + firstStart,
    displayEndUtf16: preambleLength + lastStart + lastLength,
  }
}

export function mainDiffVisualRowRange(
  pane: PaneHandle,
  startIndex: number,
  endIndex: number,
): { readonly startRow: number; readonly endRow: number } | undefined {
  const document = documents.get(pane)
  if (document === undefined) return undefined
  const virtual = virtualMainPaneFor(pane)
  if (virtual?.isActive()) return virtual.visualRowRange(startIndex, endIndex)
  const content = installedContents.get(pane)
  const preambleRows = (normalizedPreamble(content?.preamble ?? "").match(/\n/g) ?? []).length
  const firstSource = preambleRows + Math.max(0, startIndex)
  const lastSource = preambleRows + Math.max(startIndex, endIndex)
  const lineInfo = (pane.text as unknown as { readonly lineInfo?: { readonly lineSources?: readonly number[] } }).lineInfo
  const sources = lineInfo?.lineSources
  if (sources !== undefined && sources.length > 0) {
    const startRow = sources.findIndex((source) => source === firstSource)
    let endRow = -1
    for (let row = 0; row < sources.length; row += 1) {
      if (sources[row]! >= firstSource && sources[row]! <= lastSource) endRow = row
    }
    if (startRow >= 0 && endRow >= startRow) return { startRow, endRow }
  }
  return { startRow: firstSource, endRow: lastSource }
}

export function getMainDiffLineSelection(pane: PaneHandle): MainDiffLineSelection | undefined {
  const document = documents.get(pane)
  const state = lineRanges.get(pane)
  if (document === undefined || state === undefined || state.rangeMode === "none") return undefined
  const range = diffLineSelectionRange(state)
  const virtual = virtualMainPaneFor(pane)
  const offsets = virtual?.isActive()
    ? (() => {
      const value = virtual.lineOffsets(range.startIndex, range.endIndex + 1)
      return value === undefined ? undefined : {
        startUtf16: value.rawStartUtf16,
        endUtf16: value.rawEndUtf16,
        displayStartUtf16: value.displayStartUtf16,
        displayEndUtf16: value.displayEndUtf16,
      }
    })()
    : mainDiffLineOffsets(document, range.startIndex, range.endIndex, installedContents.get(pane)?.preamble ?? "")
  if (offsets === undefined) return undefined
  return {
    document,
    state,
    indexes: changedIndexesInDiffLineRange(document, state),
    ...offsets,
  }
}

function applyMainDiffLineVisualSelection(pane: PaneHandle, resetWhenInactive = true): void {
  const virtual = virtualMainPaneFor(pane)
  const selection = getMainDiffLineSelection(pane)
  if (virtual?.isActive()) {
    if (selection !== undefined) virtual.setLineSelection(selection.startUtf16, selection.endUtf16)
    else if (resetWhenInactive) virtual.resetSelection()
    return
  }
  const text = pane.text as unknown as { setSelection?: (start: number, end: number) => void; resetSelection?: () => void }
  if (selection !== undefined) text.setSelection?.(selection.displayStartUtf16, selection.displayEndUtf16)
  else if (resetWhenInactive) text.resetSelection?.()
}

export function getMainPointerSelection(pane: PaneHandle): DocumentSelection | undefined {
  return virtualMainPaneFor(pane)?.selection()
}
export function setMainDiffLineRangeState(pane: PaneHandle, state: DiffLineRangeState): void {
  lineRanges.set(pane, state)
  const virtual = virtualMainPaneFor(pane)
  if (state.rangeMode === "none") {
    if (virtual?.isActive()) virtual.resetSelection()
    else applyMainDiffLineVisualSelection(pane)
    return
  }
  const document = documents.get(pane)
  const range = diffLineSelectionRange(state)
  const start = document?.lines[range.startIndex]
  const end = document?.lines[range.endIndex]
  if (virtual?.isActive() && start !== undefined && end !== undefined) {
    virtual.setLineSelection(start.startUtf16, end.endUtf16)
    return
  }
  applyMainDiffLineVisualSelection(pane)
}
export function getMainDocument(pane: PaneHandle): DiffDocument | undefined {
  return documents.get(pane)
}

export function getMainCursorTarget(pane: PaneHandle): MainCursorTarget | undefined {
  return cursorTargets.get(pane)
}
function hunkKey(hunk: DiffFile["hunks"][number]): string {
  return `${hunk.header.raw}\u0000${hunk.oldStart}:${hunk.oldCount}:${hunk.newStart}:${hunk.newCount}`
}

function targetWithIdentity(document: DiffDocument, target: MainCursorTarget): MainCursorTarget {
  const file = document.files[target.fileIndex]
  if (file === undefined) return target
  const filePath = file.newPath !== undefined && file.newPath !== "/dev/null" ? file.newPath : file.oldPath
  return {
    ...target,
    ...(filePath === undefined ? {} : { filePath }),
    ...(target.hunkIndex === undefined || file.hunks[target.hunkIndex] === undefined ? {} : { hunkKey: hunkKey(file.hunks[target.hunkIndex]!) }),
  }
}

export function setMainCursorTarget(pane: PaneHandle, target: MainCursorTarget): void {
  const document = documents.get(pane)
  const file = document?.files[target.fileIndex]
  if (!file) return
  if (target.hunkIndex === undefined ? file.hunks.length > 0 : file.hunks[target.hunkIndex] === undefined) return
  cursorTargets.set(pane, targetWithIdentity(document!, target))
}

export function moveMainCursor(document: DiffDocument, current: MainCursorTarget | undefined, direction: "next" | "previous"): MainCursorTarget | undefined {
  const targets: MainCursorTarget[] = document.files.flatMap((file) => file.hunks.length > 0
    ? file.hunks.map((_, hunkIndex) => ({ fileIndex: file.fileIndex, hunkIndex }))
    : [{ fileIndex: file.fileIndex }])
  if (targets.length === 0) return undefined
  const currentIndex = current ? targets.findIndex((target) => target.fileIndex === current.fileIndex && target.hunkIndex === current.hunkIndex) : -1
  const nextIndex = Math.max(0, Math.min(targets.length - 1, currentIndex + (direction === "next" ? 1 : -1)))
  return targets[nextIndex]
}

/**
 * First rendered row of a main cursor target: the hunk's `@@` header for hunk targets, or
 * the file's `diff --git` header for files without hunks (binary/conflicted). renderDiff
 * emits exactly one display row per document line, so the document-lines index is directly
 * the on-screen row to reveal.
 */
export function mainCursorTargetLine(document: DiffDocument, target: MainCursorTarget): number | undefined {
  const index = document.lines.findIndex((line) =>
    line.fileIndex === target.fileIndex
    && (target.hunkIndex === undefined || line.hunkIndex === target.hunkIndex))
  return index < 0 ? undefined : index
}

export type MainActionAvailability = {
  readonly canStageLines: boolean
  readonly canDiscardLines: boolean
  readonly reason?: string
}

export function mainActionAvailability(document: DiffDocument | undefined, target: MainCursorTarget | undefined): MainActionAvailability {
  const file = document === undefined || target === undefined ? undefined : document.files[target.fileIndex]
  if (!file) return { canStageLines: false, canDiscardLines: false, reason: "No diff selected" }
  if (file.hunks.length === 0) return { canStageLines: false, canDiscardLines: false, reason: "line actions disabled: binary or conflicted file" }
  return { canStageLines: true, canDiscardLines: true }
}


export function changeLineIndexes(document: DiffDocument, startUtf16: number, endUtf16: number): readonly number[] {
  return document.lines.flatMap((line, index) => {
    if (line.kind !== "addition" && line.kind !== "deletion") return []
    return line.endUtf16 > startUtf16 && line.startUtf16 < endUtf16 ? [index] : []
  })
}

export function getMainPaneContent(pane: PaneHandle): MainPaneContent | undefined {
  return installedContents.get(pane)
}

export function getMainRenderedText(pane: PaneHandle): string | undefined {
  return renderedTexts.get(pane)
}

function renderedTextFor(content: MainPaneContent): string {
  if (content.document !== undefined) {
    return `${normalizedPreamble(content.preamble ?? "")}${content.document.text}`
  }
  if (content.ansi !== undefined) return `${content.preamble ?? ""}${content.ansi.text}`
  if (content.plainText !== undefined) return content.plainText
  return content.preamble ?? ""
}

function buildPlainContent(content: MainPaneContent): string {
  if (content.plainText !== undefined) return content.plainText
  if (content.preamble !== undefined) return content.preamble
  return "No content"
}

/**
 * Re-clamps the viewport to content that has not changed. A resize moves `maxScrollY`/`maxScrollX`
 * without touching what the pane shows, so this is all a layout pass owes the main pane.
 */
export function clampMainScroll(pane: PaneHandle): void {
  const virtual = virtualMainPaneFor(pane)
  if (virtual?.isActive()) {
    virtual.clampScroll()
    return
  }
  pane.text.scrollY = Math.max(0, Math.min(pane.text.maxScrollY, pane.text.scrollY))
  pane.text.scrollX = Math.max(0, Math.min(pane.text.maxScrollX, pane.text.scrollX))
  pane.syncScrollbar()
}

/** Replaces whatever a diff or a log left behind, so plain content never inherits its highlights. */
function updatePlain(pane: PaneHandle, value: string): void {
  virtualMainPaneFor(pane)?.deactivate()
  releaseDiffText(pane.text)
  releaseAnsiText(pane.text)
  pane.update(value)
}
export function installMainContent(pane: PaneHandle, content: MainPaneContent, tooSmall: boolean): void {
  const previousContent = installedContents.get(pane)
  const previousText = renderedTexts.get(pane)
  const virtualDocument = content.document !== undefined && isVirtualDiffDocument(content.document)
  const nextText = virtualDocument ? undefined : renderedTextFor(content)
  const previousIdentity = previousContent === undefined ? undefined : `${previousContent.source}:${previousContent.stableId}`
  const nextIdentity = `${content.source}:${content.stableId}`

  const sameIdentity = previousIdentity !== undefined && previousIdentity === nextIdentity
  const identicalText = virtualDocument
    ? previousContent?.document?.text === content.document?.text && previousContent?.preamble === content.preamble
    : previousText !== undefined && previousText === nextText
  const previousWasDocument = documents.has(pane)
  const replacingDocument = previousWasDocument && content.document === undefined
  const enteringDocument = !previousWasDocument && content.document !== undefined
  const leavingAnsi = previousContent?.ansi !== undefined && content.ansi === undefined

  // Update installed tracking before rendering so subsequent installs compare correctly
  installedContents.set(pane, content)
  if (nextText === undefined) renderedTexts.delete(pane)
  else renderedTexts.set(pane, nextText)
  paneTitles.set(pane, `0 Main — ${content.label}`)

  const previousRange = lineRanges.get(pane)
  const clearSelection = (): void => {
    virtualMainPaneFor(pane)?.resetSelection()
    const view = pane.text
    if (view !== null && typeof view === "object" && "resetSelection" in view) {
      const reset = view.resetSelection
      if (typeof reset === "function") reset.call(view)
    }
    cursorTargets.delete(pane)
    lineRanges.delete(pane)
  }

  if (tooSmall) {
    pane.box.title = paneTitles.get(pane) ?? `0 Main — ${content.label}`
    updatePlain(pane, "Terminal too small")
    documents.delete(pane)
    clearSelection()
    pane.text.scrollX = 0
    pane.text.scrollY = 0
    return
  }

  pane.box.title = paneTitles.get(pane) ?? `0 Main — ${content.label}`

  // Lifecycle: viewport and selection handling
  if (!sameIdentity) {
    clearSelection()
    pane.text.scrollX = 0
    pane.text.scrollY = 0
  } else if (enteringDocument) {
    clearSelection()
    pane.text.scrollY = Math.max(0, Math.min(pane.text.maxScrollY, pane.text.scrollY))
    pane.text.scrollX = Math.max(0, Math.min(pane.text.maxScrollX, pane.text.scrollX))
  } else if (identicalText) {
    pane.text.scrollY = Math.max(0, Math.min(pane.text.maxScrollY, pane.text.scrollY))
    pane.text.scrollX = Math.max(0, Math.min(pane.text.maxScrollX, pane.text.scrollX))
  } else {
    clearSelection()
    pane.text.scrollY = Math.max(0, Math.min(pane.text.maxScrollY, pane.text.scrollY))
    pane.text.scrollX = Math.max(0, Math.min(pane.text.maxScrollX, pane.text.scrollX))
  }

  // Render content
  if (content.document !== undefined) {
    const doc = content.document
    // For document lifecycle, preserve hunk cursor if same identity identical text
    const previousDocument = documents.get(pane)
    const previousTarget = cursorTargets.get(pane)
    let preservedTarget: MainCursorTarget | undefined
    if (sameIdentity && identicalText && previousTarget !== undefined && previousDocument !== undefined) {
      const oldFile = previousDocument.files[previousTarget.fileIndex]
      const filePath = previousTarget.filePath ?? (oldFile?.newPath !== undefined && oldFile.newPath !== "/dev/null" ? oldFile.newPath : oldFile?.oldPath)
      const newFileIndex = filePath === undefined ? -1 : doc.files.findIndex((file) => {
        const path = file.newPath !== undefined && file.newPath !== "/dev/null" ? file.newPath : file.oldPath
        return path === filePath
      })
      if (newFileIndex >= 0) {
        const newFile = doc.files[newFileIndex]!
        if (previousTarget.hunkIndex === undefined) {
          if (newFile.hunks.length === 0) preservedTarget = { fileIndex: newFileIndex, ...(filePath === undefined ? {} : { filePath }) }
        } else {
          const key = previousTarget.hunkKey ?? (oldFile?.hunks[previousTarget.hunkIndex] === undefined ? undefined : hunkKey(oldFile.hunks[previousTarget.hunkIndex]!))
          const newHunkIndex = key === undefined ? -1 : newFile.hunks.findIndex((hunk) => hunkKey(hunk) === key)
          if (newHunkIndex >= 0) preservedTarget = { fileIndex: newFileIndex, hunkIndex: newHunkIndex, ...(filePath === undefined ? {} : { filePath }), ...(key === undefined ? {} : { hunkKey: key }) }
      }
    }
      }
    // If not preserved, pick first hunk
    const initialTarget = preservedTarget ?? (!sameIdentity || !identicalText ? moveMainCursor(doc, undefined, "next") : previousTarget ?? moveMainCursor(doc, undefined, "next"))
    const shouldKeepTarget = sameIdentity && identicalText
    documents.set(pane, doc)
    const nextRange = !enteringDocument && sameIdentity && identicalText && previousRange?.lineCount === doc.lines.length
      ? previousRange
      : createDiffLineRangeState(doc)
    lineRanges.set(pane, nextRange)
    if (shouldKeepTarget && initialTarget) {
      cursorTargets.set(pane, targetWithIdentity(doc, initialTarget))
    } else {
      cursorTargets.delete(pane)
    }
    const virtual = virtualMainPaneFor(pane)
    if (virtualDocument && virtual !== undefined) {
      releaseAnsiText(pane.text)
      // install() already clamps and paints the bounded window via renderWindow;
      // a second clampScroll() would repaint the same window twice per install.
      virtual.install(doc, content.preamble ?? "")
      renderedTexts.delete(pane)
      if (previousRange?.rangeMode !== "none") applyMainDiffLineVisualSelection(pane)
      return
    }
    virtual?.deactivate()
    pane.text.wrapMode = "char"
    releaseAnsiText(pane.text)
    if (enteringDocument || !sameIdentity || !identicalText) {
      const rendered = renderDiff(doc)
      installDiffText(pane.text, { preamble: content.preamble ?? "", body: rendered.displayText, displayLines: rendered.displayLines })

    }
    pane.text.scrollY = Math.max(0, Math.min(pane.text.maxScrollY, pane.text.scrollY))
    pane.text.scrollX = Math.max(0, Math.min(pane.text.maxScrollX, pane.text.scrollX))
    pane.syncScrollbar()
    if (!enteringDocument && sameIdentity && identicalText && previousRange?.rangeMode !== "none") applyMainDiffLineVisualSelection(pane)
    return
  }
  if (content.ansi !== undefined) {
    virtualMainPaneFor(pane)?.deactivate()
    documents.delete(pane)
    if (replacingDocument || !sameIdentity || !identicalText) clearSelection()
    // wrap either (pkg/gui/views.go: the Normal view leaves `Wrap` false for command output).
    pane.text.wrapMode = "none"
    releaseDiffText(pane.text)
    installAnsiText(pane.text, { preamble: content.preamble ?? "", body: content.ansi.text, spans: content.ansi.spans })
    pane.text.scrollY = Math.max(0, Math.min(pane.text.maxScrollY, pane.text.scrollY))
    pane.text.scrollX = Math.max(0, Math.min(pane.text.maxScrollX, pane.text.scrollX))
    pane.syncScrollbar()
    return
  }
  virtualMainPaneFor(pane)?.deactivate()
  documents.delete(pane)
  if (replacingDocument || leavingAnsi || !sameIdentity || !identicalText) clearSelection()
  if (replacingDocument || leavingAnsi || !sameIdentity || !identicalText) updatePlain(pane, buildPlainContent(content))
  pane.text.scrollY = Math.max(0, Math.min(pane.text.maxScrollY, pane.text.scrollY))
  pane.text.scrollX = Math.max(0, Math.min(pane.text.maxScrollX, pane.text.scrollX))
  pane.syncScrollbar()
}

export function setMainLoading(pane: PaneHandle, loading: boolean, tooSmall: boolean): void {
  if (tooSmall) return
  const current = installedContents.get(pane)
  const base = current !== undefined ? `0 Main — ${current.label}` : "0 Main"
  pane.box.title = loading ? `${base} (Loading…)` : base
  paneTitles.set(pane, base)
}

export function updateMainPane(pane: PaneHandle, _model: AppModel, tooSmall: boolean, override?: MainPaneContent): void {
  if (override !== undefined) {
    installMainContent(pane, override, tooSmall)
    return
  }
  // Legacy fallback: if no override, show placeholder. After cutover, every source goes through gate,
  // so this path is only used during initial create before gate installs synchronous content.
  if (tooSmall) {
    pane.box.title = "0 Main"
    pane.update("Terminal too small")
    return
  }
  pane.box.title = "0 Main"
  pane.update("No patch loaded")
}

/** Scrolls the main pane's text viewport, clamped to its content. */
export function scrollMainPane(pane: PaneHandle, axis: "x" | "y", delta: number): void {
  if (axis === "y") {
    pane.text.scrollY = Math.max(0, Math.min(pane.text.maxScrollY, pane.text.scrollY + delta))
    pane.syncScrollbar()
    return
  }
  pane.text.scrollX = Math.max(0, Math.min(pane.text.maxScrollX, pane.text.scrollX + delta))
}
