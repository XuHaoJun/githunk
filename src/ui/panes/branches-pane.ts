import type { CliRenderer } from "@opentui/core"
import type { AppModel } from "../../app/model"
import { filterItems } from "../../app/filter"
import { createPane, type PaneHandle } from "./common"
import type { ListColumn, ListRow } from "../list-view"
import { createListState, renderListRows, selectListRow } from "../list-view"

function formatBranchTime(committedAt: string, now: Date = new Date()): string {
  const unix = Number(committedAt)
  if (!Number.isFinite(unix) || committedAt.length === 0) return ""
  const thenMs = unix * 1000
  if (Number.isNaN(thenMs)) return ""
  const diffMs = now.getTime() - thenMs
  const diffSec = Math.round(diffMs / 1000)
  const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" })
  const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ["year", 365 * 24 * 60 * 60],
    ["month", 30 * 24 * 60 * 60],
    ["week", 7 * 24 * 60 * 60],
    ["day", 24 * 60 * 60],
    ["hour", 60 * 60],
    ["minute", 60],
    ["second", 1],
  ]
  for (const [unit, secs] of units) {
    if (Math.abs(diffSec) >= secs || unit === "second") {
      const value = Math.round(diffSec / secs)
      return rtf.format(-value, unit)
    }
  }
  return rtf.format(0, "second")
}

export function localBranchRows(model: AppModel, filter = ""): ListRow[] {
  const listing = model.branches
  if (listing === undefined) return []
  const rows: ListRow[] = listing.localBranches.map((branch) => {
    const id = `local:${branch.name}`
    const columns: ListColumn[] = []
    columns.push({
      text: branch.isCurrent ? "●" : " ",
      priority: 0,
      style: branch.isCurrent ? "green" : "dim",
    })
    if (branch.isCurrent) {
      columns.push({ text: branch.name, priority: 2, style: "green" })
    } else {
      columns.push({ text: branch.name, priority: 2 })
    }
    if (branch.upstream !== undefined && branch.upstream.length > 0) {
      columns.push({ text: `↳${branch.upstream}`, priority: 3, style: "dim" })
    }
    if (branch.upstreamTrack !== undefined && branch.upstreamTrack.length > 0) {
      columns.push({ text: branch.upstreamTrack, priority: 3, style: "yellow" })
    }
    if (branch.subject !== undefined && branch.subject.length > 0) {
      columns.push({ text: branch.subject, priority: 2 })
    }
    if (branch.committedAt !== undefined && branch.committedAt.length > 0) {
      const time = formatBranchTime(branch.committedAt)
      if (time.length > 0) columns.push({ text: time, priority: 4, style: "dim" })
    }
    return { id, columns }
  })
  if (filter.length === 0) return rows
  return [...filterItems(filter, rows, (row) => row.columns[1]?.text ?? row.id)]
}

export function createBranchesPane(renderer: CliRenderer, model: AppModel): PaneHandle {
  const pane = createPane(renderer, "branches", "3 Local Branches | Remotes | Tags", "")
  pane.box.title = "3 Local Branches | Remotes | Tags"
  updateBranchesPane(pane, model)
  return pane
}

/**
 * @deprecated — legacy direct-update path for pre-Task4 callers. Use PanelState + renderListRows via RootView.
 * TODO: delete with navigation task that removes dispatch.integration's 3 obsolete scope tests (bracket scope + mixed-pane j navigation).
 */
export function updateBranchesPane(pane: PaneHandle, model: AppModel, _selectedIndex = 0, _filter = ""): void {
  pane.box.title = "3 Local Branches | Remotes | Tags"
  const rows = localBranchRows(model, _filter)
  let state = createListState(rows)
  if (rows.length > 0) {
    const clamped = Math.max(0, Math.min(_selectedIndex, rows.length - 1))
    const id = rows[clamped]?.id
    if (id !== undefined) state = selectListRow(state, id)
  }
  const content = renderListRows(state, false, 80)
  pane.update(content)
  pane.syncScrollbar()
}

// --- Compatibility shims for pre-Task4 callers (dispatch.integration) ---
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
