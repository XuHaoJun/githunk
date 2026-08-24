import type { CliRenderer } from "@opentui/core"
import type { AppModel } from "../../app/model"
import { createPane, type PaneHandle } from "./common"

export function createStatusPane(renderer: CliRenderer, model: AppModel): PaneHandle {
  const pane = createPane(renderer, "status", "1 Status / Review", "")
  updateStatusPane(pane, model)
  return pane
}

export function updateStatusPane(pane: PaneHandle, model: AppModel): void {
  const aggregate = model.branchReviewTarget
  const target = model.reviewTarget.kind === "working-tree"
    ? `Working Tree (${model.reviewTarget.scope})`
    : model.reviewTarget.kind === "branch"
      ? `Branch Changes (${model.branch || "current"} vs ${model.reviewTarget.baseRef})`
      : model.reviewTarget.kind === "commit"
        ? aggregate === undefined
          ? model.reviewTarget.kind
          : `Commit ${model.reviewTarget.oid.slice(0, 7)} (Branch Review: ${aggregate.baseRef})`
        : model.reviewTarget.kind
  const summary = model.reviewSummary
  const branchDetails = aggregate === undefined
    ? model.reviewTarget.kind === "branch" ? `Base: ${model.reviewTarget.baseRef} (${model.reviewTarget.baseOid})` : undefined
    : `Base: ${aggregate.baseRef} (${aggregate.baseOid}) · Aggregate target ${aggregate.baseOid}..${aggregate.headOid}`
  // The arranged layout pins this pane to STATUS_PANE_HEIGHT rows — one visible content
  // row — so the review target leads; it is the line every downstream assertion and the
  // user's routing decision depend on seeing.
  pane.update([
    `Target: ${target}`,
    model.branch ? `Branch: ${model.branch}` : "Branch: (loading)",
    ...(branchDetails === undefined ? [] : [branchDetails]),
    model.basePicker === undefined ? "" : `Base picker: ${model.basePicker.candidates.join(", ") || "(none)"}`,
    model.loading ? "Loading…" : `${summary?.files ?? model.files.length} files · ${summary?.additions ?? 0} additions · ${summary?.deletions ?? 0} deletions`,
    `Review: ${summary?.reviewed ?? 0} reviewed · ${summary?.invalidated ?? 0} invalidated · ${summary?.commits ?? 0} commits`,
    model.banner ? `! ${model.banner}` : "",
  ].filter(Boolean).join("\n"))
}
