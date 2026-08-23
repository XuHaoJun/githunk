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
    ? `Working Tree (${model.reviewTarget.scope})`
    : model.reviewTarget.kind === "branch"
      ? `Branch Changes (${model.branch || "current"} vs ${model.reviewTarget.baseRef})`
      : model.reviewTarget.kind
  const summary = model.reviewSummary
  const branchDetails = model.reviewTarget.kind === "branch"
    ? `Base: ${model.reviewTarget.baseRef} (${model.reviewTarget.baseOid})`
    : undefined
  pane.update([
    model.branch ? `Branch: ${model.branch}` : "Branch: (loading)",
    `Target: ${target}`,
    ...(branchDetails === undefined ? [] : [branchDetails]),
    model.basePicker === undefined ? "" : `Base picker: ${model.basePicker.candidates.join(", ") || "(none)"}`,
    model.loading ? "Loading…" : `${summary?.files ?? model.files.length} files · ${summary?.additions ?? 0} additions · ${summary?.deletions ?? 0} deletions`,
    `Review: ${summary?.reviewed ?? 0} reviewed · ${summary?.invalidated ?? 0} invalidated · ${summary?.commits ?? 0} commits`,
    model.banner ? `! ${model.banner}` : "",
  ].filter(Boolean).join("\n"))
}
