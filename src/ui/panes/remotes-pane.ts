import type { AppModel } from "../../app/model"
import { filterItems } from "../../app/filter"
import type { ListRow } from "../list-view"

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
