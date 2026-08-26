import { createCliRenderer } from "@opentui/core"
import { backgroundOptionsFromEnv, createApp } from "./app/create-app"
import { configureTerminalPalette } from "./ui/theme"
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

  try {
    const terminalPalette = await renderer.getPalette({ size: 256, timeout: 500 })
    configureTerminalPalette(terminalPalette)
  } catch {
    // Static Ghostty defaults remain the fallback when the terminal cannot answer OSC palette queries.
  }

  const app = createApp({
    repositoryRoot,
    runner,
    renderer,
    onQuit: () => renderer.destroy(),
    background: backgroundOptionsFromEnv(),
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
