import type { AppModel } from "../../app/model"
import type { TagSummary } from "../../domain/tag"
import { filterItems } from "../../app/filter"
import type { ListRow } from "../list-view"
import { createListState, renderListRows, setListRows, type ListState } from "../list-view"
import type { PaneHandle } from "./common"

/** tags_controller.go:107. */
export const NO_TAGS = "No tags"

/**
 * tags_controller.go:142-156 `filterOutPgpSignature`: an annotated tag's signature block is
 * dropped from the info shown above the graph, terminator line included.
 */
function withoutPgpSignature(message: string): string {
  let inSignature = false
  return message.split("\n").filter((line) => {
    if (line === "-----END PGP SIGNATURE-----") {
      inSignature = false
      return false
    }
    if (line === "-----BEGIN PGP SIGNATURE-----") inSignature = true
    return !inSignature
  }).join("\n")
}

/**
 * What lazygit renders above a tag's commit graph: `getTagInfo(tag) + "\n\n---\n\n"`
 * (tags_controller.go:110,125-141). An annotated tag adds its own annotation
 * (`git tag -n99 --list <name>`, here already carried on the summary as `message`); a lightweight
 * one is just the header line.
 */
export function tagPreamble(tag: TagSummary): string {
  const header = `${tag.kind === "annotated" ? "Annotated tag" : "Lightweight tag"}: ${tag.name}`
  const annotation = tag.kind === "annotated" && tag.message !== undefined
    ? withoutPgpSignature(tag.message).replace(/\n+$/, "")
    : ""
  return `${annotation.length === 0 ? header : `${header}\n\n${annotation}`}\n\n---\n\n`
}

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

export function updateTagsPane(pane: PaneHandle, model: AppModel, state: ListState, focused: boolean): ListState {
  const rows = tagRows(model)
  const displayRows = rows.length === 0 ? [{ kind: "message" as const, text: "No tags" }] : undefined
  const next = setListRows(state, rows, displayRows)
  const content = renderListRows(next, focused, 80)
  pane.update(content)
  pane.syncScrollbar()
  return next
}

export function createTagsState(model: AppModel): ListState {
  const rows = tagRows(model)
  return createListState(rows, rows.length === 0 ? [{ kind: "message", text: "No tags" }] : undefined)
}
