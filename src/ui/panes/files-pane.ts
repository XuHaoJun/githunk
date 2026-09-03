import type { CliRenderer, ColorInput } from "@opentui/core"
import type { AppModel } from "../../app/model"
import type { ChangedFile } from "../../domain/review-target"
import { createPane, type PaneHandle } from "./common"
import {
  createFileTreeState,
  everyFileInNode,
  fileTreeRows,
  someFileInNode,
  type FileTreeAccessors,
  type FileTreeMode,
  type FileTreeRow,
  type FileTreeState,
} from "../file-tree"
import { createListState, type ListColumn, type ListColumnSegment, type ListRow } from "../list-view"
import { installListText } from "./list-text"
import { FILE_MIXED_FG, FILE_STAGED_FG, UNSTAGED_CHANGES_FG } from "../theme"

/** Panel 2's tab labels and jump label, in lazygit's order (`{"files", "worktrees", "submodules"}` — pkg/config/user_config.go:872). */
export const FILES_TABS = ["Files", "Worktrees", "Submodules"] as const
export const FILES_JUMP_KEY = "2"

/** Shown in place of the list when the working tree is clean. */
export const NO_CHANGED_FILES = "No changed files"

/**
 * lazygit's `models.File.ShortStatus`: the two-character porcelain XY pair. githunk parses
 * `--porcelain=v2`, which writes `.` where v1 writes a space, and splits the untracked marker
 * across the two fields — so both are mapped back onto lazygit's spelling here, once, and every
 * derived flag below is computed from the result exactly as `deriveStatusFields` does
 * (pkg/commands/models/file.go:149).
 */
export function fileShortStatus(file: ChangedFile): string {
  if (file.untracked) return "??"
  const staged = file.indexStatus === "." ? " " : file.indexStatus
  const unstaged = file.worktreeStatus === "." ? " " : file.worktreeStatus
  return `${staged}${unstaged}`
}

/** models/file.go:151 — anything but a space, a `U` or a `?` in the staged column. */
export function fileHasStagedChanges(file: ChangedFile): boolean {
  const staged = fileShortStatus(file)[0] ?? " "
  return staged !== " " && staged !== "U" && staged !== "?"
}

/** models/file.go:160 — anything but a space in the unstaged column. */
export function fileHasUnstagedChanges(file: ChangedFile): boolean {
  return (fileShortStatus(file)[1] ?? " ") !== " "
}

/** models/file.go:150 — everything except a brand-new file. */
export function fileIsTracked(file: ChangedFile): boolean {
  const status = fileShortStatus(file)
  return status !== "??" && status !== "A " && status !== "AM"
}

/** How `src/ui/file-tree.ts` reads a `ChangedFile`. */
const FILE_TREE_ACCESSORS: FileTreeAccessors<ChangedFile> = {
  getPath: (file) => file.path,
  getPreviousPath: (file) => file.previousPath,
  getShortStatus: fileShortStatus,
  hasMergeConflicts: (file) => file.conflicted,
  isTracked: fileIsTracked,
}

export function createFilesTreeState(model: AppModel, mode: FileTreeMode = "tree"): FileTreeState<ChangedFile> {
  // Match lazygit's Gui.ShowRootItemInFileTree default.
  return createFileTreeState(model.files, { ...FILE_TREE_ACCESSORS, showRootItem: true }, mode)
}

/**
 * The colour a row's name (and its trailing space, and a directory's arrow) is painted in:
 * green when the node's only changes are staged, yellow when it has both, otherwise the list's
 * own foreground — pkg/gui/presentation/files.go:133-138. `undefined` means the default.
 */
function nameColorFor(row: FileTreeRow<ChangedFile>): ColorInput | undefined {
  const hasStaged = someFileInNode(row.node, fileHasStagedChanges)
  if (!hasStaged) return undefined
  const allStaged = everyFileInNode(row.node, (file) => !fileHasUnstagedChanges(file))
  return allStaged ? FILE_STAGED_FG : FILE_MIXED_FG
}

/**
 * `formatFileStatus` (pkg/gui/presentation/files.go:184): the staged character is green unless
 * it is a `?` (the unstaged colour) or a space (the row's own colour); the unstaged character is
 * the unstaged colour unless it is a space.
 */
function statusSegments(status: string, nameColor: ColorInput | undefined): readonly ListColumnSegment[] {
  const staged = status[0] ?? " "
  const unstaged = status[1] ?? " "
  const colorFor = (char: string, base: ColorInput): ListColumnSegment =>
    char === " "
      ? { text: char, ...(nameColor === undefined ? {} : { color: nameColor }) }
      : { text: char, color: char === "?" ? UNSTAGED_CHANGES_FG : base }
  return [colorFor(staged, FILE_STAGED_FG), colorFor(unstaged, UNSTAGED_CHANGES_FG)]
}

function reviewMarkerFor(file: ChangedFile, model: AppModel): string {
  const reviewStatus = model.reviewStatuses !== undefined && Object.prototype.hasOwnProperty.call(model.reviewStatuses, file.path)
    ? model.reviewStatuses[file.path]
    : undefined
  if (reviewStatus === "reviewed") return "●"
  if (reviewStatus === "reviewing") return "◐"
  if (reviewStatus === "changed-after-review") return "!"
  return "○"
}

function reasonFor(file: ChangedFile): string | undefined {
  if (file.conflicted) return "line actions disabled: conflicted file"
  if (!file.untracked && file.additions === 0 && file.deletions === 0) return "line actions disabled: binary file"
  return undefined
}

/**
 * One `ListRow` per rendered tree row. The flex column carries lazygit's whole line —
 * `indentation` + arrow-or-status + `" "` + name — as a single string with per-character
 * `segments`, because lazygit's line is a concatenation and not a set of aligned columns: padding
 * the pieces into columns would shift the tree's indentation around.
 *
 * githunk's own review-status marker keeps a one-character column of its own in front of that
 * line (directories leave it blank), so the tree shape is unaffected by it.
 */
export function filesTreeRows(state: FileTreeState<ChangedFile>, model: AppModel): ListRow[] {
  return fileTreeRows(state).map((row) => {
    const nameColor = nameColorFor(row)
    const named = (text: string): ListColumnSegment => ({ text, ...(nameColor === undefined ? {} : { color: nameColor }) })
    const prefix = row.kind === "directory" ? `${row.arrow ?? ""} ` : `${row.status ?? "  "} `
    const segments: ListColumnSegment[] = [
      ...(row.indentation.length === 0 ? [] : [{ text: row.indentation }]),
      ...(row.kind === "directory"
        ? [named(prefix)]
        : [...statusSegments(row.status ?? "  ", nameColor), named(" ")]),
      named(row.name),
    ]
    const line: ListColumn = {
      text: `${row.indentation}${prefix}${row.name}`,
      priority: 2,
      flex: true,
      segments,
    }
    const marker: ListColumn = { text: row.payload === undefined ? " " : reviewMarkerFor(row.payload, model), priority: 0 }
    const reason = row.payload === undefined ? undefined : reasonFor(row.payload)
    return {
      id: row.id,
      columns: reason === undefined ? [marker, line] : [marker, line, { text: `— ${reason}`, priority: 4, style: "dim" as const }],
    }
  })
}

export function createFilesPane(renderer: CliRenderer, model: AppModel): PaneHandle {
  const pane = createPane(renderer, "files", "", "", false, {
    tabs: { jumpKey: FILES_JUMP_KEY, tabs: FILES_TABS },
  })
  const initialRows = filesTreeRows(createFilesTreeState(model), model)
  const displayRows = initialRows.length === 0 ? [{ kind: "message" as const, text: NO_CHANGED_FILES }] : undefined
  const state = createListState(initialRows, displayRows)
  installListText(pane.text, { state, width: 80, focused: false })
  return pane
}

export function fileLineActionReason(file: ChangedFile): string | undefined {
  return reasonFor(file)
}

/**
 * lazygit commits whatever the index holds regardless of which Files view is showing
 * (`WithEnsureCommittableFiles`, pkg/gui/controllers/helpers/working_tree_helper.go:229):
 * any staged file anywhere in the model is committable from every working-tree scope.
 */
export function anyStagedChanges(model: AppModel): boolean {
  return model.reviewTarget.kind === "working-tree" && model.files.some(fileHasStagedChanges)
}
