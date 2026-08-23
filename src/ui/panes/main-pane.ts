import type { CliRenderer } from "@opentui/core"
import type { AppModel } from "../../app/model"
import { parseDiff } from "../../domain/diff/parse"
import type { DiffDocument } from "../../domain/diff/document"
import { renderDiff } from "../../domain/diff/render"
import { createPane, type PaneHandle } from "./common"

const documents = new WeakMap<PaneHandle, DiffDocument>()

export function createMainPane(renderer: CliRenderer, model: AppModel): PaneHandle {
  const pane = createPane(renderer, "main", "0 Main", "", true)
  updateMainPane(pane, model, false)
  return pane
}

export function getMainDocument(pane: PaneHandle): DiffDocument | undefined {
  return documents.get(pane)
}

export function updateMainPane(pane: PaneHandle, model: AppModel, tooSmall: boolean): void {
  if (tooSmall) {
    pane.update("Terminal too small")
    documents.delete(pane)
    return
  }

  const sections = model.rawPatchSections.length > 0 ? model.rawPatchSections : model.patches
  const raw = sections.map((patch) => patch.text).filter(Boolean).join("")
  if (raw.length === 0) {
    pane.update(model.loading ? "Loading…" : model.banner ? `! ${model.banner}` : "No patch loaded")
    documents.delete(pane)
    return
  }

  const document = parseDiff(raw)
  documents.set(pane, document)
  pane.update(renderDiff(document).styledText)
}
