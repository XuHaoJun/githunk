import type { AppModel } from "../../app/model"
import { filterItems } from "../../app/filter"
import type { ListRow } from "../list-view"
import { REFLOG_HASH_FG } from "../theme"

/** Panel 4's tab labels and jump label, in lazygit's order (`{"commits", "reflog"}` — pkg/config/user_config.go:874). */
export const COMMITS_TABS = ["Commits", "Reflog"] as const
export const COMMITS_JUMP_KEY = "4"

/** Shown in place of the list, and in the main pane, when the reflog is empty — reflog_commits_controller.go:46. */
export const NO_REFLOG_HISTORY = "No reflog history"

/**
 * One row per reflog entry, matching `getDisplayStringsForReflogCommit`
 * (pkg/gui/presentation/reflog_commits.go:72): the short hash in `style.FgBlue`, then the
 * reflog subject in `theme.DefaultTextColor` — i.e. no explicit colour, so it inherits the
 * list's own foreground the way the commits pane's subject column does. The date column only
 * appears in lazygit's full-description mode, which githunk does not offer.
 */
export function reflogRows(model: AppModel, filter = ""): ListRow[] {
  const rows: ListRow[] = (model.reflog ?? []).map((entry) => ({
    id: entry.id,
    columns: [
      { text: entry.shortOid, priority: 1, color: REFLOG_HASH_FG },
      { text: entry.subject, priority: 2, flex: true },
    ],
  }))
  if (filter.length === 0) return rows
  return [...filterItems(filter, rows, (row) => row.columns[1]?.text ?? row.id)]
}
