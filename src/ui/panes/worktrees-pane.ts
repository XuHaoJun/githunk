import type { AppModel } from "../../app/model"
import { filterItems } from "../../app/filter"
import type { Worktree } from "../../domain/worktree"
import type { ListColumn, ListRow } from "../list-view"
import {
  WORKTREE_BRANCH_FG,
  WORKTREE_CURRENT_FG,
  WORKTREE_DETACHED_FG,
  WORKTREE_INACTIVE_MARKER_FG,
  WORKTREE_MISSING_FG,
} from "../theme"

/** Shown in place of the list, and in the main pane, when there is no worktree selected — pkg/i18n/english.go:2069. */
export const NO_WORKTREES_THIS_REPO = "No worktrees"

/** `tr.MissingWorktree` — pkg/i18n/english.go:2070. */
export const MISSING_WORKTREE_LABEL = "(missing)"

/** `tr.MainWorktree` — pkg/i18n/english.go:2071. */
export const MAIN_WORKTREE_LABEL = "(main worktree)"

/** Row identity: a worktree's path is unique within `git worktree list` by construction. */
export function worktreeRowId(worktree: Worktree): string {
  return `worktree:${worktree.path}`
}

export function selectedWorktreeFrom(model: AppModel, id: string | undefined): Worktree | undefined {
  if (id === undefined) return undefined
  return (model.worktrees ?? []).find((worktree) => worktreeRowId(worktree) === id)
}

/** `worktree.Branch`, or lazygit's detached-head text — pkg/gui/presentation/worktrees.go:48-53. */
function branchText(worktree: Worktree): string {
  if (worktree.branch !== undefined && worktree.branch.length > 0) return worktree.branch
  if (worktree.shortHead !== undefined) return `HEAD detached at ${worktree.shortHead}`
  return ""
}

/**
 * One row per worktree, matching `GetWorktreeDisplayString`
 * (pkg/gui/presentation/worktrees.go:21): the current marker, the name, then the branch (or the
 * detached head) with the main-worktree label appended. githunk renders no icons, so the icon
 * cell is skipped and the missing label goes on the name, exactly as lazygit does when icons are
 * disabled (worktrees.go:44-46).
 */
export function worktreeRows(model: AppModel, filter = ""): ListRow[] {
  const rows: ListRow[] = (model.worktrees ?? []).map((worktree) => {
    const branch = branchText(worktree)
    const mainLabel = worktree.isMain ? ` ${MAIN_WORKTREE_LABEL}` : ""
    const marker: ListColumn = worktree.isCurrent
      ? { text: "  *", priority: 0, color: WORKTREE_CURRENT_FG }
      : { text: "", priority: 0, color: WORKTREE_INACTIVE_MARKER_FG }
    const name: ListColumn = {
      text: worktree.isPathMissing ? `${worktree.name} ${MISSING_WORKTREE_LABEL}` : worktree.name,
      priority: 1,
      ...(worktree.isPathMissing ? { color: WORKTREE_MISSING_FG } : {}),
    }
    // lazygit joins the branch and the main label into one display string with two different
    // styles, which `segments` is exactly for: the label keeps the row's default colour.
    const trailing: ListColumn = {
      text: `${branch}${mainLabel}`,
      priority: 2,
      flex: true,
      segments: [
        ...(branch.length === 0
          ? []
          : [{ text: branch, color: worktree.branch !== undefined && worktree.branch.length > 0 ? WORKTREE_BRANCH_FG : WORKTREE_DETACHED_FG }]),
        ...(mainLabel.length === 0 ? [] : [{ text: mainLabel }]),
      ],
    }
    return { id: worktreeRowId(worktree), columns: [marker, name, trailing] }
  })
  if (filter.length === 0) return rows
  return [...filterItems(filter, rows, (row) => row.columns[1]?.text ?? row.id)]
}

/**
 * The main-pane text for the selected worktree — `WorktreesController.GetOnRenderToMain`
 * (pkg/gui/controllers/worktrees_controller.go:80-110). Go's tabwriter is configured with
 * `minwidth 0, tabwidth 0, padding 2`, so the label column is the widest label plus two spaces.
 */
export function worktreePreviewText(worktree: Worktree): string {
  const rows: readonly (readonly [string, string])[] = [
    ["Name:", `${worktree.name}${worktree.isMain ? ` ${MAIN_WORKTREE_LABEL}` : ""}`],
    ["Branch:", branchText(worktree)],
    ["Path:", `${worktree.path}${worktree.isPathMissing ? ` ${MISSING_WORKTREE_LABEL}` : ""}`],
  ]
  const width = rows.reduce((max, [label]) => Math.max(max, label.length), 0) + 2
  return rows.map(([label, value]) => `${label}${" ".repeat(width - label.length)}${value}\n`).join("")
}
