import type { CliRenderer } from "@opentui/core"
import type { AppModel } from "../../app/model"
import { createPane, type PaneHandle } from "./common"

const cursors = new WeakMap<PaneHandle, number>()

export function createStashPane(renderer: CliRenderer, model: AppModel): PaneHandle {
  const pane = createPane(renderer, "stash", "5 Stash", "No stashes", true)
  updateStashPane(pane, model, 0)
  return pane
}

export function selectedStashEntry(pane: PaneHandle, model: AppModel): { readonly ref: string; readonly oid: string } | undefined {
  const stashes = model.stashes ?? []
  const index = Math.max(0, Math.min(cursors.get(pane) ?? 0, stashes.length - 1))
  const entry = stashes[index]
  return entry === undefined ? undefined : { ref: entry.ref, oid: entry.oid }
}

export function selectedStashItem(pane: PaneHandle, model: AppModel): string | undefined {
  return selectedStashEntry(pane, model)?.ref
}

export function moveStashCursor(pane: PaneHandle, model: AppModel, direction: "next" | "previous"): void {
  const count = model.stashes?.length ?? 0
  if (count === 0) return
  const current = cursors.get(pane) ?? 0
  cursors.set(pane, Math.max(0, Math.min(count - 1, current + (direction === "next" ? 1 : -1))))
  updateStashPane(pane, model, cursors.get(pane) ?? 0)
}

export function updateStashPane(pane: PaneHandle, model: AppModel, selectedIndex = cursors.get(pane) ?? 0): void {
  const stashes = model.stashes ?? []
  if (stashes.length === 0) {
    pane.update(model.reviewTarget.kind === "stash" ? `* ${model.reviewTarget.ref}` : "No stashes")
    return
  }
  const index = Math.max(0, Math.min(selectedIndex, stashes.length - 1))
  cursors.set(pane, index)
  pane.update(stashes.map((stash, itemIndex) => `${itemIndex === index ? ">" : " "} ${stash.ref} ${stash.message}`).join("\n"))
}
