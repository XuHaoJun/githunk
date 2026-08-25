import type { AppModel } from "../../app/model"
import { filterItems } from "../../app/filter"
import { submoduleDepth, submoduleFullName, submoduleFullPath, type SubmoduleConfig } from "../../domain/submodule"
import type { ListRow } from "../list-view"

/** Shown in place of the list, and in the main pane, when nothing is selected — submodules_controller.go:113. */
export const NO_SUBMODULES = "No submodules"

/** Row identity: lazygit's `FullName`, which is unique across the parent chain. */
export function submoduleRowId(submodule: SubmoduleConfig): string {
  return `submodule:${submoduleFullName(submodule)}`
}

export function selectedSubmoduleFrom(model: AppModel, id: string | undefined): SubmoduleConfig | undefined {
  if (id === undefined) return undefined
  return (model.submodules ?? []).find((submodule) => submoduleRowId(submodule) === id)
}

/**
 * The rendered name — `getSubmoduleDisplayStrings` (pkg/gui/presentation/submodules.go:17): the
 * section name, prefixed with two spaces per parent module plus `"- "` once nested.
 */
function submoduleRowName(submodule: SubmoduleConfig): string {
  const depth = submoduleDepth(submodule)
  return depth === 0 ? submodule.name : `${"  ".repeat(depth)}- ${submodule.name}`
}

export function submoduleRows(model: AppModel, filter = ""): ListRow[] {
  const rows: ListRow[] = (model.submodules ?? []).map((submodule) => ({
    id: submoduleRowId(submodule),
    columns: [{ text: submoduleRowName(submodule), priority: 2, flex: true }],
  }))
  if (filter.length === 0) return rows
  return [...filterItems(filter, rows, (row) => row.columns[0]?.text ?? row.id)]
}

/**
 * The main-pane prefix block for the selected submodule —
 * `SubmodulesController.GetOnRenderToMain` (pkg/gui/controllers/submodules_controller.go:107-121).
 * lazygit follows this with the submodule's own working-tree diff when the parent repo reports one;
 * githunk's model carries no submodule diff, so only the prefix is emitted.
 */
export function submodulePreviewText(submodule: SubmoduleConfig): string {
  return `Name: ${submoduleFullName(submodule)}\nPath: ${submoduleFullPath(submodule)}\nUrl:  ${submodule.url ?? ""}\n\n`
}
