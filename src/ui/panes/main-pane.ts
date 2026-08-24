import type { CliRenderer } from "@opentui/core"
import type { AppModel } from "../../app/model"
import { parseDiff } from "../../domain/diff/parse"
import type { DiffDocument, DiffFile } from "../../domain/diff/document"
import { renderDiff } from "../../domain/diff/render"
import { createPane, type PaneHandle } from "./common"

const documents = new WeakMap<PaneHandle, DiffDocument>()
const cursorTargets = new WeakMap<PaneHandle, MainCursorTarget>()
export type MainCursorTarget = {
  readonly fileIndex: number
  readonly hunkIndex?: number
  readonly filePath?: string
  readonly hunkKey?: string
}

/** When set, main renders this patch instead of the model's own sections (commits-pane preview). */
export type MainPaneOverride = {
  readonly label: string
  readonly raw: string
}

export function createMainPane(renderer: CliRenderer, model: AppModel): PaneHandle {
  const pane = createPane(renderer, "main", "0 Main", "", true)
  updateMainPane(pane, model, false)
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

export function updateMainPane(pane: PaneHandle, model: AppModel, tooSmall: boolean, override?: MainPaneOverride): void {
  pane.box.title = override !== undefined
    ? `0 Main — ${override.label}`
    : model.reviewTarget.kind === "commit"
      ? `0 Main — ${model.reviewTarget.oid.slice(0, 7)}${model.branchReviewTarget === undefined ? "" : ` · ${model.branchReviewTarget.baseRef}..HEAD`}`
      : "0 Main"
  if (tooSmall) {
    pane.update("Terminal too small")
    documents.delete(pane)
    cursorTargets.delete(pane)
    return
  }
  const raw = override !== undefined ? override.raw : (() => {
    const sections = model.rawPatchSections.length > 0 ? model.rawPatchSections : model.patches
    return sections.map((patch) => patch.text).filter(Boolean).join("")
  })()
  if (raw.length === 0) {
    pane.update(model.loading ? "Loading…" : model.banner ? `! ${model.banner}` : "No patch loaded")
    documents.delete(pane)
    cursorTargets.delete(pane)
    return
  }

  const document = parseDiff(raw)
  const previousDocument = documents.get(pane)
  const previousTarget = cursorTargets.get(pane)
  let preservedTarget: MainCursorTarget | undefined
  if (previousTarget !== undefined && previousDocument !== undefined) {
    const oldFile = previousDocument.files[previousTarget.fileIndex]
    const filePath = previousTarget.filePath ?? (oldFile?.newPath !== undefined && oldFile.newPath !== "/dev/null" ? oldFile.newPath : oldFile?.oldPath)
    const newFileIndex = filePath === undefined ? -1 : document.files.findIndex((file) => {
      const path = file.newPath !== undefined && file.newPath !== "/dev/null" ? file.newPath : file.oldPath
      return path === filePath
    })
    if (newFileIndex >= 0) {
      const newFile = document.files[newFileIndex]!
      if (previousTarget.hunkIndex === undefined) {
        if (newFile.hunks.length === 0) {
          preservedTarget = { fileIndex: newFileIndex, ...(filePath === undefined ? {} : { filePath }) }
        }
      } else {
        const key = previousTarget.hunkKey ?? (oldFile?.hunks[previousTarget.hunkIndex] === undefined ? undefined : hunkKey(oldFile.hunks[previousTarget.hunkIndex]!))
        const newHunkIndex = key === undefined ? -1 : newFile.hunks.findIndex((hunk) => hunkKey(hunk) === key)
        if (newHunkIndex >= 0) {
          preservedTarget = {
            fileIndex: newFileIndex,
            hunkIndex: newHunkIndex,
            ...(filePath === undefined ? {} : { filePath }),
            ...(key === undefined ? {} : { hunkKey: key }),
          }
        }
      }
    }
  }
  const initialTarget = preservedTarget ?? moveMainCursor(document, undefined, "next")
  documents.set(pane, document)
  if (initialTarget) cursorTargets.set(pane, targetWithIdentity(document, initialTarget))
  else cursorTargets.delete(pane)
  pane.text.wrapMode = "char"
  pane.update(renderDiff(document).styledText)
}

/** Scrolls the main pane's text viewport, clamped to its content. */
export function scrollMainPane(pane: PaneHandle, axis: "x" | "y", delta: number): void {
  if (axis === "y") {
    pane.text.scrollY = Math.max(0, Math.min(pane.text.maxScrollY, pane.text.scrollY + delta))
    return
  }
  pane.text.scrollX = Math.max(0, Math.min(pane.text.maxScrollX, pane.text.scrollX + delta))
}
