import type { CommitDetails } from "../../domain/commit"
import { filterItems } from "../../app/filter"
import type { ListRow } from "../list-view"

function statusForFile(oldPath: string | undefined, newPath: string | undefined): string {
  if (oldPath === "/dev/null") return "A"
  if (newPath === "/dev/null") return "D"
  if (oldPath !== undefined && newPath !== undefined && oldPath !== newPath) return "R"
  return "M"
}

export function commitFileRows(details: CommitDetails, filter = ""): ListRow[] {
  const files = details.document.files
  if (files.length === 0) return []
  const rows = files.map((file) => {
    const newPath = file.newPath ?? file.oldPath ?? ""
    const oldPath = file.oldPath ?? ""
    const id = `${newPath}\u0000${oldPath}`
    const status = statusForFile(file.oldPath, file.newPath)
    const displayPath = newPath.length > 0 ? newPath : oldPath
    const previous = file.oldPath !== undefined && file.oldPath !== newPath ? file.oldPath : undefined
    const columns: ListRow["columns"] = [
      { text: status, priority: 1 },
      { text: displayPath, priority: 2 },
      ...(previous !== undefined ? [{ text: `→ ${previous}`, priority: 3, style: "dim" as const }] : []),
    ]
    return { id, columns }
  })
  if (filter.length === 0) return rows
  return [...filterItems(filter, rows, (row) => row.columns[1]?.text ?? row.id)]
}
export function commitFileIdForPath(newPath: string, oldPath?: string): string {
  return `${newPath}\u0000${oldPath ?? ""}`
}
