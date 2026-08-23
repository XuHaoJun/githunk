import type { CliRenderer } from "@opentui/core"
import type { AppModel } from "../../app/model"
import { createPane, type PaneHandle } from "./common"

export function createFilesPane(renderer: CliRenderer, model: AppModel): PaneHandle {
  const pane = createPane(renderer, "files", "2 Files", "")
  updateFilesPane(pane, model)
  return pane
}

export function updateFilesPane(pane: PaneHandle, model: AppModel): void {
  const content = model.files.length === 0
    ? "No changed files"
    : model.files.map((file) => {
      const marker = file.conflicted ? "!" : file.untracked ? "?" : file.worktreeStatus || file.indexStatus || " "
      const reason = file.conflicted
        ? " — line actions disabled: conflicted file"
        : !file.untracked && file.additions === 0 && file.deletions === 0
          ? " — line actions disabled: binary file"
          : ""
      return `${marker} ${file.path}${reason}`
    }).join("\n")
  pane.update(content)
}

export function fileLineActionReason(file: AppModel["files"][number]): string | undefined {
  if (file.conflicted) return "line actions disabled: conflicted file"
  if (!file.untracked && file.additions === 0 && file.deletions === 0) return "line actions disabled: binary file"
  return undefined
}
