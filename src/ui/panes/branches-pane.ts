import type { CliRenderer } from "@opentui/core"
import type { AppModel } from "../../app/model"
import { filterItems } from "../../app/filter"
import { createPane, type PaneHandle } from "./common"

export type BranchPaneItem =
  | { readonly kind: "local"; readonly name: string }
  | { readonly kind: "remote"; readonly name: string }

  | { readonly kind: "remote-branch"; readonly remote: string; readonly name: string; readonly ref: string }
export function branchItemId(item: BranchPaneItem): string {
  return item.kind === "remote-branch" ? `${item.kind}:${item.remote}:${item.name}` : `${item.kind}:${item.name}`
}

export function branchPaneItems(model: AppModel, filter = ""): readonly BranchPaneItem[] {
  const listing = model.branches
  if (listing === undefined) return []
  const all = [
    ...listing.localBranches.map((branch) => ({ kind: "local" as const, name: branch.name })),
    ...listing.remotes.flatMap((remote) => [
      { kind: "remote" as const, name: remote.name },
      ...(remote.branches ?? []).map((branch) => ({ kind: "remote-branch" as const, remote: remote.name, name: branch.name, ref: branch.ref })),
    ]),
  ]
  return filterItems(filter, all, (item) => item.name)
}

export function selectedBranchItem(model: AppModel, index: number, filter = ""): BranchPaneItem | undefined {
  const items = branchPaneItems(model, filter)
  return items[Math.max(0, Math.min(index, items.length - 1))]
}

export function moveBranchesCursor(model: AppModel, index: number, direction: "next" | "previous", filter = ""): number {
  const count = branchPaneItems(model, filter).length
  if (count === 0) return 0
  return Math.max(0, Math.min(count - 1, index + (direction === "next" ? 1 : -1)))
}

export function createBranchesPane(renderer: CliRenderer, model: AppModel): PaneHandle {
  const pane = createPane(renderer, "branches", "3 Branches / Remotes", "")
  updateBranchesPane(pane, model)
  return pane
}

export function updateBranchesPane(pane: PaneHandle, model: AppModel, selectedIndex = 0, filter = ""): void {
  const listing = model.branches
  const items = branchPaneItems(model, filter)
  const lines = [
    model.branch ? `* ${model.branch}` : "* (detached/loading)",
    model.upstream ? `  ↳ ${model.upstream}` : "  (no upstream)",
  ]
  if (listing !== undefined) {
    lines.push(filter.length === 0 ? "Local Branches" : `Branches / ${filter}`)
    for (const [index, item] of items.entries()) {
      const marker = index === selectedIndex ? ">" : " "
      lines.push(item.kind === "remote-branch" ? `${marker}   ${item.remote}/${item.name}` : `${marker} ${item.name}`)
    }
  }
  pane.update(lines.join("\n"))
}
