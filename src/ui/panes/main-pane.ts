import type { CliRenderer } from "@opentui/core"
import type { AppModel } from "../../app/model"
import { parseDiff } from "../../domain/diff/parse"
import type { DiffDocument } from "../../domain/diff/document"
import { renderDiff } from "../../domain/diff/render"
import { createPane, type PaneHandle } from "./common"

const documents = new WeakMap<PaneHandle, DiffDocument>()
export type MainCursorTarget = { readonly fileIndex: number; readonly hunkIndex: number }
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
  if (!document?.files[target.fileIndex]?.hunks[target.hunkIndex]) return
  cursorTargets.set(pane, target)
}

export function updateMainPane(pane: PaneHandle, model: AppModel, tooSmall: boolean): void {
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
  const hasPreviousTarget = previousTarget !== undefined && document.files[previousTarget.fileIndex]?.hunks[previousTarget.hunkIndex] !== undefined
  documents.set(pane, document)
  cursorTargets.set(pane, hasPreviousTarget ? previousTarget : { fileIndex: 0, hunkIndex: 0 })
  pane.update(renderDiff(document).styledText)
}
