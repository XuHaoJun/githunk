import { StyledText } from "@opentui/core"
import type { CliRenderer, TextChunk } from "@opentui/core"
import type { AppModel } from "../../app/model"
import { parseDiff } from "../../domain/diff/parse"
import type { DiffDocument, DiffFile } from "../../domain/diff/document"
import { renderDiff } from "../../domain/diff/render"
import { createPane, type PaneHandle } from "./common"

// Main generation has no patch threshold — all patches go through preview gate (Task 7)

const documents = new WeakMap<PaneHandle, DiffDocument>()
const cursorTargets = new WeakMap<PaneHandle, MainCursorTarget>()
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
  readonly plainText?: string
}

export function createMainPane(renderer: CliRenderer, _model: AppModel): PaneHandle {
  const pane = createPane(renderer, "main", "0 Main", "", true)
  // content will be installed via gate; keep placeholder until first install
  pane.box.title = "0 Main"
  paneTitles.set(pane, "0 Main")
  return pane
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

export function mainPaneCommitAvailable(model: AppModel): boolean {
  return model.reviewTarget.kind === "working-tree" && model.reviewTarget.scope === "staged"
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
    return `${content.preamble ?? ""}${content.document.text}`
  }
  if (content.plainText !== undefined) return content.plainText
  return content.preamble ?? ""
}

function buildStyledContent(content: MainPaneContent): string | StyledText {
  if (content.document !== undefined) {
    const preamble = content.preamble ?? ""
    const diffStyled = renderDiff(content.document).styledText
    if (preamble.length === 0) return diffStyled
    const plainChunk = { __isChunk: true as const, text: preamble } as unknown as TextChunk
    // Access chunks via guarded property check to avoid inline cast lint
    if (diffStyled !== null && typeof diffStyled === "object" && "chunks" in diffStyled) {
      const maybe = (diffStyled as unknown as { chunks: unknown }).chunks
      if (Array.isArray(maybe) && maybe.length > 0) {
        const diffChunks = maybe as unknown as TextChunk[]
        return new StyledText([plainChunk, ...diffChunks])
      }
    }
    return `${preamble}${content.document.text}`
  }
  if (content.plainText !== undefined) return content.plainText
  if (content.preamble !== undefined) return content.preamble
  return "No content"
}
export function installMainContent(pane: PaneHandle, content: MainPaneContent, tooSmall: boolean): void {
  const previousContent = installedContents.get(pane)
  const previousText = renderedTexts.get(pane)
  const nextText = renderedTextFor(content)
  const previousIdentity = previousContent === undefined ? undefined : `${previousContent.source}:${previousContent.stableId}`
  const nextIdentity = `${content.source}:${content.stableId}`

  const sameIdentity = previousIdentity !== undefined && previousIdentity === nextIdentity
  const identicalText = previousText !== undefined && previousText === nextText

  // Update installed tracking before rendering so subsequent installs compare correctly
  installedContents.set(pane, content)
  renderedTexts.set(pane, nextText)
  paneTitles.set(pane, `0 Main — ${content.label}`)

  const clearSelection = (): void => {
    const view = pane.text
    if (view !== null && typeof view === "object" && "resetSelection" in view) {
      const reset = view.resetSelection
      if (typeof reset === "function") reset.call(view)
    }
    cursorTargets.delete(pane)
  }

  if (tooSmall) {
    pane.box.title = paneTitles.get(pane) ?? `0 Main — ${content.label}`
    pane.update("Terminal too small")
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
    if (shouldKeepTarget && initialTarget) {
      cursorTargets.set(pane, targetWithIdentity(doc, initialTarget))
    } else {
      cursorTargets.delete(pane)
    }
    pane.text.wrapMode = "char"
    pane.update(buildStyledContent(content))
    // clamp again after content size known
    pane.text.scrollY = Math.max(0, Math.min(pane.text.maxScrollY, pane.text.scrollY))
    pane.text.scrollX = Math.max(0, Math.min(pane.text.maxScrollX, pane.text.scrollX))
    pane.syncScrollbar()
    return
  }

  // plainText or preamble-only
  documents.delete(pane)
  const styled = buildStyledContent(content)
  pane.update(styled)
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
