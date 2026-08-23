import type { CliRenderer } from "@opentui/core"
import type { AppModel } from "../../app/model"
import { createPane, type PaneHandle } from "./common"

export function createMainPane(renderer: CliRenderer, model: AppModel): PaneHandle {
  const pane = createPane(renderer, "main", "0 Main", "", true)
  updateMainPane(pane, model, false)
  return pane
}

export function updateMainPane(pane: PaneHandle, model: AppModel, tooSmall: boolean): void {
  if (tooSmall) {
    pane.update("Terminal too small")
    return
  }

  const sections = model.patches.length === 0
    ? "No patch loaded"
    : model.patches.map((patch) => `${patch.label}\n${patch.text}`).join("\n\n")
  const content = [
    model.title,
    model.repositoryRoot ? `Repository: ${model.repositoryRoot}` : "",
    model.loading ? "Loading…" : "",
    model.banner ? `! ${model.banner}` : "",
    sections,
  ].filter(Boolean).join("\n")
  pane.update(content)
}
