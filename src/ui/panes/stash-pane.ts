import type { CliRenderer } from "@opentui/core"
import type { AppModel } from "../../app/model"
import { createPane, type PaneHandle } from "./common"
import { createListState, renderListRows, setListRows, type ListRow, type ListState } from "../list-view"

export function stashRows(model: AppModel): ListRow[] {
  const stashes = model.stashes ?? []
  return stashes.map((stash) => {
    const columns: ListRow["columns"] = [
      { text: stash.ref, priority: 1 },
      { text: stash.message, priority: 2 },
    ]
    return { id: stash.oid, columns }
  })
}

function stashDisplayRows(model: AppModel, rows: readonly ListRow[]): readonly { readonly kind: "message"; readonly text: string }[] | undefined {
  if (rows.length !== 0) return undefined
  const text = model.reviewTarget.kind === "stash" ? `* ${model.reviewTarget.ref}` : "No stashes"
  return [{ kind: "message", text }]
}

export function createStashPane(renderer: CliRenderer, model: AppModel): PaneHandle {
  const pane = createPane(renderer, "stash", "5 Stash", "")
  const rows = stashRows(model)
  const displayRows = stashDisplayRows(model, rows)
  const state = createListState(rows, displayRows)
  const content = renderListRows(state, false, 80)
  pane.update(content)
  return pane
}

export function updateStashPane(pane: PaneHandle, model: AppModel, state: ListState, focused: boolean): ListState {
  const rows = stashRows(model)
  const displayRows = stashDisplayRows(model, rows)
  const next = setListRows(state, rows, displayRows)
  const content = renderListRows(next, focused, 80)
  pane.update(content)
  pane.syncScrollbar()
  return next
}

export function selectedStashEntryFromState(state: ListState, model: AppModel): { readonly ref: string; readonly oid: string } | undefined {
  const stashes = model.stashes ?? []
  if (state.selectedId === undefined) return undefined
  const entry = stashes.find((s) => s.oid === state.selectedId)
  return entry === undefined ? undefined : { ref: entry.ref, oid: entry.oid }
}
