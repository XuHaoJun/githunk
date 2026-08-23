import type { CliRenderer } from "@opentui/core"
import type { AppModel } from "../../app/model"
import { createPane, type PaneHandle } from "./common"

export function createStashPane(renderer: CliRenderer, model: AppModel): PaneHandle {
  const pane = createPane(renderer, "stash", "5 Stash", "No stash selected")
  updateStashPane(pane, model)
  return pane
}

export function updateStashPane(pane: PaneHandle, model: AppModel): void {
  pane.update(model.reviewTarget.kind === "stash" ? `* ${model.reviewTarget.ref}` : "No stash selected")
}
