import type { CliRenderer } from "@opentui/core"
import type { AppModel } from "../../app/model"
import { createPane, type PaneHandle } from "./common"

export function createCommitsPane(renderer: CliRenderer, model: AppModel): PaneHandle {
  const pane = createPane(renderer, "commits", "4 Commits", "No commit selected")
  updateCommitsPane(pane, model)
  return pane
}

export function updateCommitsPane(pane: PaneHandle, model: AppModel): void {
  const target = model.reviewTarget.kind === "commit" ? model.reviewTarget.oid : model.title
  pane.update(`Review target\n${target}`)
}
