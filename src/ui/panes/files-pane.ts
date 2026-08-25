import type { CliRenderer } from "@opentui/core"
import type { AppModel } from "../../app/model"
import { createPane, type PaneHandle } from "./common"
import { createListState, renderListRows, setListRows, type ListRow, type ListState } from "../list-view"

function gitMarkerFor(file: AppModel["files"][number]): string {
  if (file.conflicted) return "!"
  if (file.untracked) return "?"
  return file.worktreeStatus || file.indexStatus || " "
}

function reviewMarkerFor(file: AppModel["files"][number], model: AppModel): string {
  const reviewStatus = model.reviewStatuses !== undefined && Object.prototype.hasOwnProperty.call(model.reviewStatuses, file.path)
    ? model.reviewStatuses[file.path]
    : undefined
  if (reviewStatus === "reviewed") return "●"
  if (reviewStatus === "reviewing") return "◐"
  if (reviewStatus === "changed-after-review") return "!"
  return "○"
}

function reasonFor(file: AppModel["files"][number]): string | undefined {
  if (file.conflicted) return "line actions disabled: conflicted file"
  if (!file.untracked && file.additions === 0 && file.deletions === 0) return "line actions disabled: binary file"
  return undefined
}

export function fileRows(model: AppModel): ListRow[] {
  return model.files.map((file) => {
    const gitMarker = gitMarkerFor(file)
    const reviewMarker = reviewMarkerFor(file, model)
    const reason = reasonFor(file)
    const baseColumns: ListRow["columns"] = [
      { text: gitMarker, priority: 0 },
      { text: reviewMarker, priority: 0 },
      { text: file.path, priority: 2 },
    ]
    const columns: ListRow["columns"] = reason !== undefined ? [...baseColumns, { text: `— ${reason}`, priority: 4, style: "dim" }] : baseColumns
    return { id: file.path, columns }
  })
}

export function createFilesPane(renderer: CliRenderer, model: AppModel): PaneHandle {
  const pane = createPane(renderer, "files", "2 Files", "")
  const initialRows = fileRows(model)
  const displayRows = initialRows.length === 0 ? [{ kind: "message" as const, text: "No changed files" }] : undefined
  const state = createListState(initialRows, displayRows)
  const content = renderListRows(state, false, 80)
  pane.update(content)
  return pane
}

export function updateFilesPane(pane: PaneHandle, model: AppModel, state: ListState, focused: boolean): ListState {
  const rows = fileRows(model)
  const displayRows = rows.length === 0 ? [{ kind: "message" as const, text: "No changed files" }] : undefined
  const next = setListRows(state, rows, displayRows)
  const content = renderListRows(next, focused, 80)
  pane.update(content)
  pane.syncScrollbar()
  return next
}

export function fileLineActionReason(file: AppModel["files"][number]): string | undefined {
  if (file.conflicted) return "line actions disabled: conflicted file"
  if (!file.untracked && file.additions === 0 && file.deletions === 0) return "line actions disabled: binary file"
  return undefined
}

export function filesPaneCommitAvailable(model: AppModel): boolean {
  return model.reviewTarget.kind === "working-tree" && model.reviewTarget.scope === "staged"
}
