import type { CliRenderer } from "@opentui/core"
import type { AppModel } from "../../app/model"
import { filterItems } from "../../app/filter"
import { createPane, type PaneHandle } from "./common"
import type { ListColumn, ListRow } from "../list-view"
import { createListState, renderListRows, selectListRow, setListRows, type ListState } from "../list-view"

function formatBranchTime(committedAt: string, now: Date = new Date()): string {
  const unix = Number(committedAt)
  if (!Number.isFinite(unix) || committedAt.length === 0) return ""
  const thenMs = unix * 1000
  if (Number.isNaN(thenMs)) return ""
  const diffMs = now.getTime() - thenMs
  const diffSec = Math.round(diffMs / 1000)
  const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" })
  const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ["year", 31536000],
    ["month", 2592000],
    ["week", 604800],
    ["day", 86400],
    ["hour", 3600],
    ["minute", 60],
    ["second", 1],
  ]
  for (const [unit, secs] of units) {
    if (Math.abs(diffSec) >= secs || unit === "second") {
      return rtf.format(-Math.round(diffSec / secs), unit)
    }
  }
  return rtf.format(0, "second")
}

export function localBranchRows(model: AppModel, filter = ""): ListRow[] {
  const listing = model.branches
  if (listing === undefined) return []
  // Lazygit orders branches by committer date descending (default `localBranchSortOrder: "date"` → `-committerdate`),
  // with the current branch (`Recency: "  *"`) pinned to the top regardless of date. Recency ordering
  // (`"recency"` mode merges reflog recency) is not replicated here, but date ordering matches the
  // default vendored config (`pkg/config/user_config.go:954`).
  const sortedBranches = [...listing.localBranches].sort((a, b) => {
    if (a.isCurrent !== b.isCurrent) return a.isCurrent ? -1 : 1
    const aTime = Number(a.committedAt ?? "0")
    const bTime = Number(b.committedAt ?? "0")
    if (Number.isFinite(aTime) && Number.isFinite(bTime) && aTime !== bTime) return bTime - aTime
    return a.name.localeCompare(b.name)
  })
  const rows: ListRow[] = sortedBranches.map((branch) => {
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
  const rows = localBranchRows(model)
  const displayRows = rows.length === 0 ? [{ kind: "message" as const, text: "No branches" }] : undefined
  const state = createListState(rows, displayRows)
  const content = renderListRows(state, false, 80)
  pane.update(content)
  pane.syncScrollbar()
  return pane
}

export function updateBranchesPane(pane: PaneHandle, model: AppModel, state: ListState, focused: boolean, filter = ""): ListState {
  const rows = localBranchRows(model, filter)
  const displayRows = rows.length === 0 ? [{ kind: "message" as const, text: "No branches" }] : undefined
  const next = setListRows(state, rows, displayRows)
  const content = renderListRows(next, focused, 80)
  pane.update(content)
  pane.syncScrollbar()
  return next
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
