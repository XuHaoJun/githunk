import type { CliRenderer } from "@opentui/core"
import type { AppModel } from "../../app/model"
import { parseDiff } from "../../domain/diff/parse"
import type { DiffDocument } from "../../domain/diff/document"
import { renderDiff } from "../../domain/diff/render"
import { createPane, type PaneHandle } from "./common"

const documents = new WeakMap<PaneHandle, DiffDocument>()
export type MainCursorTarget = { readonly fileIndex: number; readonly hunkIndex?: number }
const cursorTargets = new WeakMap<PaneHandle, MainCursorTarget>()

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

export function setMainCursorTarget(pane: PaneHandle, target: MainCursorTarget): void {
  const document = documents.get(pane)
  const file = document?.files[target.fileIndex]
  if (!file) return
  if (target.hunkIndex === undefined ? file.hunks.length > 0 : file.hunks[target.hunkIndex] === undefined) return
  cursorTargets.set(pane, target)
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

export function updateMainPane(pane: PaneHandle, model: AppModel, tooSmall: boolean): void {
  pane.box.title = model.reviewTarget.kind === "commit"
    ? `0 Main — ${model.reviewTarget.oid.slice(0, 7)}${model.branchReviewTarget === undefined ? "" : ` · ${model.branchReviewTarget.baseRef}..HEAD`}`
    : "0 Main"
  if (tooSmall) {
    pane.update("Terminal too small")
    documents.delete(pane)
    cursorTargets.delete(pane)
    return
  }
  const sections = model.rawPatchSections.length > 0 ? model.rawPatchSections : model.patches
  const raw = sections.map((patch) => patch.text).filter(Boolean).join("")
  if (raw.length === 0) {
    pane.update(model.loading ? "Loading…" : model.banner ? `! ${model.banner}` : "No patch loaded")
    documents.delete(pane)
    cursorTargets.delete(pane)
    return
  }

  const document = parseDiff(raw)
  const previousTarget = cursorTargets.get(pane)
  const previousHunkIndex = previousTarget?.hunkIndex
  const previousFile = previousTarget ? document.files[previousTarget.fileIndex] : undefined
  const hasPreviousTarget = previousFile !== undefined
    && (previousHunkIndex === undefined ? previousFile.hunks.length === 0 : previousFile.hunks[previousHunkIndex] !== undefined)
  const initialTarget = hasPreviousTarget ? previousTarget : moveMainCursor(document, undefined, "next")
  documents.set(pane, document)
  if (initialTarget) cursorTargets.set(pane, initialTarget)
  else cursorTargets.delete(pane)
  pane.update(renderDiff(document).styledText)
}
