import type { CliRenderer } from "@opentui/core"
import type { AppModel } from "../../app/model"
import { createPane, type PaneHandle } from "./common"

export function createBranchesPane(renderer: CliRenderer, model: AppModel): PaneHandle {
  const pane = createPane(renderer, "branches", "3 Branches / Remotes", "")
  updateBranchesPane(pane, model)
  return pane
}

export function updateBranchesPane(pane: PaneHandle, model: AppModel): void {
  pane.update([
    model.branch ? `* ${model.branch}` : "* (detached/loading)",
    model.upstream ? `  ↳ ${model.upstream}` : "  (no upstream)",
  ].join("\n"))
}
