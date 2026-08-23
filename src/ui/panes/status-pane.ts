import type { CliRenderer } from "@opentui/core"
import type { AppModel } from "../../app/model"
import { createPane, type PaneHandle } from "./common"

export function createStatusPane(renderer: CliRenderer, model: AppModel): PaneHandle {
  const pane = createPane(renderer, "status", "1 Status / Review", "")
  updateStatusPane(pane, model)
  return pane
}

export function updateStatusPane(pane: PaneHandle, model: AppModel): void {
  const target = model.reviewTarget.kind === "working-tree"
    ? `Working tree (${model.reviewTarget.scope})`
    : model.reviewTarget.kind
  pane.update([
    model.branch ? `Branch: ${model.branch}` : "Branch: (loading)",
    `Target: ${target}`,
    model.loading ? "Loading…" : `${model.files.length} changed file${model.files.length === 1 ? "" : "s"}`,
    model.banner ? `! ${model.banner}` : "",
  ].filter(Boolean).join("\n"))
}
