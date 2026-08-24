import type { CliRenderer } from "@opentui/core"
import type { AppModel } from "../../app/model"
import { createPane, type PaneHandle } from "./common"

export function createBranchesPane(renderer: CliRenderer, model: AppModel): PaneHandle {
  const pane = createPane(renderer, "branches", "3 Branches / Remotes", "")
  updateBranchesPane(pane, model)
  return pane
}

export function updateBranchesPane(pane: PaneHandle, model: AppModel): void {
  const listing = model.branches
  const lines = [
    model.branch ? `* ${model.branch}` : "* (detached/loading)",
    model.upstream ? `  ↳ ${model.upstream}` : "  (no upstream)",
  ]
  if (listing !== undefined) {
    lines.push("Local Branches")
    for (const branch of listing.localBranches) {
      lines.push(`  ${branch.isCurrent ? "*" : " "} ${branch.name}${branch.upstream === undefined ? "" : ` → ${branch.upstream}`}`)
    }
    lines.push("Remotes")
    for (const remote of listing.remotes) lines.push(`  ${remote.name}`)
  }
  pane.update(lines.join("\n"))
}
