import { resolve } from "node:path"
import { createCliRenderer, type TerminalCapabilities } from "@opentui/core"
import { backgroundOptionsFromEnv, createApp } from "./app/create-app"
import { configureTerminalPalette } from "./ui/theme"
import { GitCommandError, GitRunner } from "./git/runner"

/**
 * Zellij does not consume OpenTUI's OSC 4 palette replies reliably; leaked replies become shell
 * input after the renderer exits. Never issue palette queries in a zellij process or capability
 * context. `ZELLIJ=0` is still the zellij marker, so presence—not truthiness—is intentional.
 */
export function shouldQueryTerminalPalette(env: Readonly<Record<string, string | undefined>> = process.env, capabilities?: Pick<TerminalCapabilities, "multiplexer"> | null): boolean {
  return env.ZELLIJ === undefined && env.ZELLIJ_SESSION_NAME === undefined && env.TERM_PROGRAM?.toLowerCase() !== "zellij" && capabilities?.multiplexer !== "zellij"
}

export type StartAppOptions = {
  /** Directory to resolve the repository from. Defaults to the current working directory. */
  readonly startDirectory?: string
}

export async function startApp(options: StartAppOptions = {}): Promise<number> {
  const startDirectory = options.startDirectory === undefined ? process.cwd() : resolve(process.cwd(), options.startDirectory)
  const runner = new GitRunner(startDirectory)
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
    targetFps: 30
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
    onQuit: () => renderer.destroy(),
    background: backgroundOptionsFromEnv()
  })
  renderer.once("destroy", () => {
    void app.destroy()
  })

  try {
    await app.refresh()
  } catch (error) {
    await app.destroy()
    renderer.destroy()
    // OpenTUI 0.6 restores the terminal asynchronously — `destroy()` only starts it — and returning
    // before `closed` settles would leave the alternate screen and mouse tracking on.
    await renderer.closed.catch(() => undefined)
    throw error
  }

  // The session ends when the renderer is destroyed: the quit key, ctrl+c, or a dead stdout. 0.6
  // restores the terminal asynchronously, so awaiting `closed` is what keeps the process alive until
  // that restore finishes. It rejects when the output stream fails, which is not a failed session —
  // report it and exit 0 rather than losing the terminal state to a stack trace.
  try {
    await renderer.closed
  } catch (error) {
    process.stderr.write(`githunk: terminal session ended with an error: ${error instanceof Error ? error.message : String(error)}\n`)
  }
  return 0
}
