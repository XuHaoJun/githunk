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
    : model.reviewTarget.kind === "commit"
      ? `Commit ${model.reviewTarget.oid.slice(0, 7)}`
      : `Stash — ${model.reviewTarget.ref}`
  const summary = model.reviewSummary
  // The arranged layout pins this pane to STATUS_PANE_HEIGHT rows — one visible content
  // row — so the review target leads; it is the line every downstream assertion and the
  // user's routing decision depend on seeing.
  pane.update([
    `Target: ${target}`,
    model.branch ? `Branch: ${model.branch}` : "Branch: (loading)",
    model.basePicker === undefined ? "" : `Base picker: ${model.basePicker.candidates.join(", ") || "(none)"}`,
    model.loading ? "Loading…" : `${summary?.files ?? model.files.length} files · ${summary?.additions ?? 0} additions · ${summary?.deletions ?? 0} deletions`,
    `Review: ${summary?.reviewed ?? 0} reviewed · ${summary?.invalidated ?? 0} invalidated · ${summary?.commits ?? 0} commits`,
    model.banner ? `! ${model.banner}` : "",
  ].filter(Boolean).join("\n"))
}
