import { createCliRenderer, TextRenderable } from "@opentui/core"
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
    renderer.root.add(
      new TextRenderable(renderer, {
        content: `githunk\nRepository: ${repositoryRoot}\n`,
      }),
    )
  } finally {
    renderer.destroy()
  }

  return 0
}

if (import.meta.main) {
  process.exitCode = await startApp()
}
