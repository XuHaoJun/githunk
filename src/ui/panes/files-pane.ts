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
      return `${marker} ${file.path}`
    }).join("\n")
  pane.update(content)
}
