import type { AppModel } from "../../app/model"
import { filterItems } from "../../app/filter"
import type { ListRow } from "../list-view"
import { createListState, renderListRows, setListRows, type ListState } from "../list-view"
import type { PaneHandle } from "./common"

export function remoteRows(model: AppModel, filter = ""): ListRow[] {
  const listing = model.branches
  if (listing === undefined) return []
  const rows: ListRow[] = listing.remotes.map((remote) => {
    const id = `remote:${remote.name}`
    const columns: ListRow["columns"] = [
      { text: remote.name, priority: 2 },
      ...(remote.fetchUrl ? [{ text: remote.fetchUrl, priority: 4, style: "dim" as const }] : []),
      ...(remote.pushUrl !== undefined && remote.pushUrl !== remote.fetchUrl ? [{ text: remote.pushUrl, priority: 4, style: "dim" as const }] : []),
    ]
    return { id, columns }
  })
  if (filter.length === 0) return rows
  return [...filterItems(filter, rows, (row) => row.columns[0]?.text ?? row.id)]
}

export function remoteBranchRows(model: AppModel, remote: string, filter = ""): ListRow[] {
  const listing = model.branches
  if (listing === undefined) return []
  const remoteEntry = listing.remotes.find((r) => r.name === remote)
  if (remoteEntry?.branches === undefined) return []
  const rows: ListRow[] = remoteEntry.branches.map((branch) => {
    const id = `remote-branch:${branch.ref}`
    const columns: ListRow["columns"] = [
      { text: branch.name, priority: 2 },
      { text: branch.ref, priority: 3, style: "dim" as const },
      ...(branch.oid ? [{ text: branch.oid.slice(0, 7), priority: 1, style: "yellow" as const }] : []),
    ]
    return { id, columns }
  })
  if (filter.length === 0) return rows
  return [...filterItems(filter, rows, (row) => row.columns[0]?.text ?? row.id)]
}

export function updateRemotesPane(pane: PaneHandle, model: AppModel, state: ListState, focused: boolean): ListState {
  const rows = remoteRows(model)
  const displayRows = rows.length === 0 ? [{ kind: "message" as const, text: "No remotes" }] : undefined
  const next = setListRows(state, rows, displayRows)
  const content = renderListRows(next, focused, 80)
  pane.update(content)
  pane.syncScrollbar()
  return next
}

export function updateRemoteBranchesPane(pane: PaneHandle, model: AppModel, remote: string, state: ListState, focused: boolean): ListState {
  const rows = remoteBranchRows(model, remote)
  const displayRows = rows.length === 0 ? [{ kind: "message" as const, text: "No branches" }] : undefined
  const next = setListRows(state, rows, displayRows)
  const content = renderListRows(next, focused, 80)
  pane.update(content)
  pane.syncScrollbar()
  return next
}

// Backward compat: initial state helper for tests
export function createRemotesState(model: AppModel): ListState {
  const rows = remoteRows(model)
  return createListState(rows, rows.length === 0 ? [{ kind: "message", text: "No remotes" }] : undefined)
}
