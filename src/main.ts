import { createCliRenderer, type TerminalCapabilities } from "@opentui/core"
import { backgroundOptionsFromEnv, createApp } from "./app/create-app"
import { configureTerminalPalette } from "./ui/theme"
import { GitCommandError, GitRunner } from "./git/runner"

/**
 * Zellij does not consume OpenTUI's OSC 4 palette replies reliably; leaked replies become shell
 * input after the renderer exits. Never issue palette queries in a zellij process or capability
 * context. `ZELLIJ=0` is still the zellij marker, so presence—not truthiness—is intentional.
 */
export function shouldQueryTerminalPalette(
  env: Readonly<Record<string, string | undefined>> = process.env,
  capabilities?: Pick<TerminalCapabilities, "multiplexer"> | null,
): boolean {
  return env.ZELLIJ === undefined
    && env.ZELLIJ_SESSION_NAME === undefined
    && env.TERM_PROGRAM?.toLowerCase() !== "zellij"
    && capabilities?.multiplexer !== "zellij"
}

export async function startApp(): Promise<number> {
  const runner = new GitRunner()
  let repositoryRoot: string

  try {
    repositoryRoot = (await runner.run(["rev-parse", "--show-toplevel"], { readOnly: true })).stdout.trim()
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

  if (shouldQueryTerminalPalette(process.env, renderer.capabilities)) {
    try {
      const terminalPalette = await renderer.getPalette({ size: 256, timeout: 500 })
      configureTerminalPalette(terminalPalette)
    } catch {
      // Static Ghostty defaults remain the fallback when the terminal cannot answer OSC palette queries.
    }
  }

  const app = createApp({
    repositoryRoot,
    runner,
    renderer,
    background: backgroundOptionsFromEnv(),
  })
  renderer.once("destroy", () => { void app.destroy() })

  try {
    await app.refresh()
  } catch (error) {
    await app.destroy()
    renderer.destroy()
    throw error
  }

  return 0
}

if (import.meta.main) {
  process.exitCode = await startApp()
}
