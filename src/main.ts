import { createCliRenderer } from "@opentui/core"
import { AppController } from "./app/controller"
import { GitCommandError, GitRunner } from "./git/runner"
import { RootView } from "./ui/root-view"

export async function startApp(): Promise<number> {
  const runner = new GitRunner()
  let repositoryRoot: string

  try {
    repositoryRoot = (await runner.run(["rev-parse", "--show-toplevel"])).stdout.trim()
  } catch (error) {
    const detail = error instanceof GitCommandError ? error.record.stderr.trim() : String(error)
    process.stderr.write(`githunk: not inside a Git repository. Start it from a repository or pass a repository path.\n${detail}\n`)
    return 1
  }

  const renderer = await createCliRenderer({
    exitOnCtrlC: true,
    useMouse: true,
    enableMouseMovement: true,
    targetFps: 30,
  })
  const controller = new AppController({ repositoryRoot, runner })
  let view: RootView
  view = new RootView(renderer, controller.state, {
    onStageFile: async (path) => {
      try { await controller.stageFile(path) } finally { view.update(controller.state) }
    },
    onUnstageFile: async (path) => {
      try { await controller.unstageFile(path) } finally { view.update(controller.state) }
    },
    onDiscardFile: async (path, untracked) => {
      try { await controller.discardFile(path, untracked) } finally { view.update(controller.state) }
    },
    onToggleAllFiles: async () => {
      try { await controller.toggleAllFiles() } finally { view.update(controller.state) }
    },
    onScopeChange: async (scope) => {
      try { await controller.setWorkingTreeScope(scope) } finally { view.update(controller.state) }
    },
    onApplySelection: async (document, indexes, reverse) => {
      try { await controller.applySelection(document, indexes, { reverse, wholeFile: false }) } finally { view.update(controller.state) }
    },
    onDiscardSelection: async (document, indexes) => {
      try { await controller.discardSelection(document, indexes, { wholeFile: false }) } finally { view.update(controller.state) }
    },
  })
  renderer.once("destroy", () => view.destroy())

  try {
    await controller.refresh()
    view.update(controller.state)
  } catch (error) {
    view.destroy()
    renderer.destroy()
    throw error
  }

  return 0
}

if (import.meta.main) {
  process.exitCode = await startApp()
}
