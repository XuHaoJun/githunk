import { createCliRenderer } from "@opentui/core"
import { createApp } from "./app/create-app"
import { GitCommandError, GitRunner } from "./git/runner"

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

  const app = createApp({
    repositoryRoot,
    runner,
    renderer,
    onQuit: () => renderer.destroy(),
  })
  renderer.once("destroy", () => app.destroy())

  try {
    await app.refresh()
  } catch (error) {
    app.destroy()
    renderer.destroy()
    throw error
  }

  return 0
}

if (import.meta.main) {
  process.exitCode = await startApp()
}
