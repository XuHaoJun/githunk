import type { AppModel } from "../../app/model"
import { filterItems } from "../../app/filter"
import type { ListRow } from "../list-view"

export function tagRows(model: AppModel, filter = ""): ListRow[] {
  const tags = model.tags ?? []
  const rows: ListRow[] = tags.map((tag) => {
    const id = `tag:${tag.ref}`
    const columns: ListRow["columns"] = [
      { text: tag.name, priority: 2 },
      { text: tag.kind, priority: 3, style: "dim" as const },
      { text: tag.targetOid.slice(0, 7), priority: 1, style: "yellow" as const },
      ...(tag.subject ? [{ text: tag.subject, priority: 2 }] : []),
      ...(tag.taggerName ? [{ text: tag.taggerName, priority: 4, style: "cyan" as const }] : []),
      ...(tag.taggedAt ? [{ text: tag.taggedAt, priority: 4, style: "dim" as const }] : []),
    ]
    return { id, columns }
  })
  if (filter.length === 0) return rows
  return [...filterItems(filter, rows, (row) => row.columns[0]?.text ?? row.id)]
}
