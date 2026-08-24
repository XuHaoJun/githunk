import type { CliRenderer } from "@opentui/core"
import type { AppModel } from "../../app/model"
import { createPane, type PaneHandle } from "./common"

export type BranchPaneItem =
  | { readonly kind: "local"; readonly name: string }
  | { readonly kind: "remote"; readonly name: string }
  | { readonly kind: "remote-branch"; readonly remote: string; readonly name: string; readonly ref: string }

export function branchPaneItems(model: AppModel): readonly BranchPaneItem[] {
  const listing = model.branches
  if (listing === undefined) return []
  return [
    ...listing.localBranches.map((branch) => ({ kind: "local" as const, name: branch.name })),
    ...listing.remotes.flatMap((remote) => [
      { kind: "remote" as const, name: remote.name },
      ...(remote.branches ?? []).map((branch) => ({ kind: "remote-branch" as const, remote: remote.name, name: branch.name, ref: branch.ref })),
    ]),
  ]
}

export function selectedBranchItem(model: AppModel, index: number): BranchPaneItem | undefined {
  return branchPaneItems(model)[Math.max(0, Math.min(index, branchPaneItems(model).length - 1))]
}

export function moveBranchesCursor(model: AppModel, index: number, direction: "next" | "previous"): number {
  const count = branchPaneItems(model).length
  if (count === 0) return 0
  return Math.max(0, Math.min(count - 1, index + (direction === "next" ? 1 : -1)))
}

export function createBranchesPane(renderer: CliRenderer, model: AppModel): PaneHandle {
  const pane = createPane(renderer, "branches", "3 Branches / Remotes", "")
  updateBranchesPane(pane, model)
  return pane
}

export function updateBranchesPane(pane: PaneHandle, model: AppModel, selectedIndex = 0): void {
  const listing = model.branches
  const lines = [
    model.branch ? `* ${model.branch}` : "* (detached/loading)",
    model.upstream ? `  ↳ ${model.upstream}` : "  (no upstream)",
  ]
  if (listing !== undefined) {
    lines.push("Local Branches")
    for (const [index, branch] of listing.localBranches.entries()) {
      const marker = branchPaneItems(model)[index]?.kind === "local" && index === selectedIndex ? ">" : " "
      lines.push(`${marker} ${branch.isCurrent ? "*" : " "} ${branch.name}${branch.upstream === undefined ? "" : ` → ${branch.upstream}`}`)
    }
    lines.push("Remotes")
    let itemIndex = listing.localBranches.length
    for (const remote of listing.remotes) {
      const marker = itemIndex === selectedIndex ? ">" : " "
      lines.push(`${marker} ${remote.name}`)
      itemIndex += 1
      for (const branch of remote.branches ?? []) {
        lines.push(`${itemIndex === selectedIndex ? ">" : " "}   ${branch.name}`)
        itemIndex += 1
      }
    }
  }
  pane.update(lines.join("\n"))
}
