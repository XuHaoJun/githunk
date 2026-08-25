import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createTestRenderer, type KeyInput, type MockMouse } from "@opentui/core/testing"
import type { CliRenderer } from "@opentui/core"
import { createApp, type App } from "../../src/app/create-app"
import { GitRunner } from "../../src/git/runner"
import { createTempRepository, type TempRepository } from "./temp-repository"
import type { FocusId } from "../../src/ui/focus"

async function createTempBareRepository(): Promise<TempRepository> {
  const path = await mkdtemp(join(tmpdir(), "githunk-bare-"))
  const git = async (args: readonly string[], stdin?: string): Promise<{ exitCode: number; stdout: string; stderr: string }> => {
    const proc = Bun.spawn(["git", ...args], {
      cwd: path,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
      },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    })
    if (stdin !== undefined) proc.stdin.write(stdin)
    proc.stdin.end()
    const [stdout, stderr, exitCode] = await Promise.all([
      Bun.readableStreamToText(proc.stdout),
      Bun.readableStreamToText(proc.stderr),
      proc.exited,
    ])
    return { exitCode, stdout, stderr }
  }
  const initialized = await git(["init", "--bare", "--quiet"])
  if (initialized.exitCode !== 0) {
    await rm(path, { recursive: true, force: true })
    throw new Error(`git init --bare failed: ${initialized.stderr}`)
  }
  return {
    path,
    git,
    async write(relativePath: string, content: string): Promise<void> {
      // Bare repos do not have a working tree; write is not supported but keep interface for uniformity.
      throw new Error(`refusing to write to bare repository: ${relativePath} -> ${content.length} bytes`)
    },
    async cleanup(): Promise<void> {
      await rm(path, { recursive: true, force: true })
    },
  }
}

export type ShellHarnessOptions = {
  readonly width?: number
  readonly height?: number
  /** Commit subjects to create, oldest first. */
  readonly commits?: readonly string[]
  readonly stash?: boolean
  /** Reuse an existing repository, e.g. to test that geometry survives a restart. */
  readonly repository?: TempRepository
  /** Repository fixture callback that receives the working repo and two bare remotes. The harness creates and cleans both bare repos. */
  readonly setup?: (repository: TempRepository, fetchBare: TempRepository, pushBare: TempRepository) => Promise<void>
  /** Alias for setup. */
  readonly setupRepository?: (repository: TempRepository, fetchBare: TempRepository, pushBare: TempRepository) => Promise<void>
}

export type ShellHarness = {
  readonly app: App
  readonly repository: TempRepository
  readonly fetchBare?: TempRepository
  readonly pushBare?: TempRepository
  readonly renderer: CliRenderer
  readonly mockMouse: MockMouse
  /** Whether RootView's `onQuit` callback (the "quit" action) has fired. */
  readonly quitCalled: boolean
  pressKey(key: KeyInput, modifiers?: { shift?: boolean; ctrl?: boolean }): Promise<void>
  drag(startX: number, startY: number, endX: number, endY: number): Promise<void>
  resize(width: number, height: number): Promise<void>
  /** Waits until no mutation (a git operation started via `runUiMutation`) is in flight and the
   *  view has settled, rather than relying on `flush()` alone or a fixed sleep. Use this after a
   *  key press that triggers an async git operation and before asserting on its outcome. */
  settle(): Promise<void>
  frame(): string
  flush(): Promise<void>
  paneTextGeometry(id: FocusId): { readonly screenX: number; readonly screenY: number; readonly width: number; readonly height: number } | undefined
  cleanup(): Promise<void>
}

export async function createShellHarness(options: ShellHarnessOptions = {}): Promise<ShellHarness> {
  const reused = options.repository !== undefined
  const repository = options.repository ?? await createTempRepository()
  const setupFn = options.setup ?? options.setupRepository
  let fetchBare: TempRepository | undefined
  let pushBare: TempRepository | undefined
  if (setupFn !== undefined && !reused) {
    fetchBare = await createTempBareRepository()
    pushBare = await createTempBareRepository()
    await setupFn(repository, fetchBare, pushBare)
  } else if (!reused) {
    const subjects = options.commits ?? ["first commit", "second commit", "third commit"]
    for (const [index, subject] of subjects.entries()) {
      await repository.write("a.txt", `revision ${index}\n`)
      await repository.git(["add", "a.txt"])
      await repository.git(["commit", "-m", subject])
    }
    if (options.stash === true) {
      await repository.write("a.txt", "stashed\n")
      await repository.git(["stash", "push", "-m", "wip"])
    }
  }
  // Leave one unstaged change so the working-tree target is never empty — but only for the
  // default harness; a custom setup callback already defines its own staged/unstaged fixture.
  if (setupFn === undefined) {
    await repository.write("b.txt", "unstaged\n")
  }

  const setup = await createTestRenderer({
    width: options.width ?? 120,
    height: options.height ?? 40,
    useMouse: true,
    enableMouseMovement: true,
    // Matches src/main.ts's real renderer configuration explicitly, rather than relying on the
    // library default of `true` for the same value: ctrl+c must behave the same way under test
    // as it does in the shipped app.
    exitOnCtrlC: true,
  })

  // Exposes whether the app's quit path ran, from either of the two independent mechanisms that
  // can trigger it: RootView's own `onQuit` (reached via the "quit" action, bound to both `q` and
  // ctrl+c) and the renderer's own `exitOnCtrlC` handling (which — like in the shipped app —
  // destroys the renderer directly on ctrl+c, regardless of RootView's key handling).
  let quitCalled = false
  setup.renderer.on("destroy", () => { quitCalled = true })

  const app = createApp({
    repositoryRoot: repository.path,
    runner: new GitRunner(repository.path),
    renderer: setup.renderer,
    onQuit: () => { quitCalled = true },
  })
  await app.refresh()
  await setup.flush()

  return {
    app,
    repository,
    ...(fetchBare === undefined ? {} : { fetchBare }),
    ...(pushBare === undefined ? {} : { pushBare }),
    renderer: setup.renderer,
    mockMouse: setup.mockMouse,
    get quitCalled() {
      return quitCalled
    },
    async pressKey(key, modifiers) {
      setup.mockInput.pressKey(key, modifiers)
      if (key === "ESCAPE") {
        // A lone ESC byte needs the stdin parser's real-time arm timeout (20ms) to elapse before
        // it's recognized as a standalone Escape rather than a prefix of a longer sequence.
        // Without this wait, a key pressed immediately afterwards can be parsed as part of the
        // same escape sequence (e.g. Escape then "d" arriving as Alt+d) instead of two separate
        // keypresses, silently corrupting whatever the next pressKey call was meant to simulate.
        await new Promise((resolve) => setTimeout(resolve, 30))
      }
      await setup.flush()
    },
    async drag(startX, startY, endX, endY) {
      await setup.mockMouse.drag(startX, startY, endX, endY)
      await setup.flush()
    },
    async resize(width, height) {
      setup.resize(width, height)
      await setup.flush()
    },
    async settle() {
      // `setup.waitFor` gives up once the renderer's own frame scheduler goes idle, but a git
      // mutation is driven by a subprocess promise that isn't tied to render scheduling until it
      // resolves — so that helper can (and did) report a spurious timeout while a mutation was
      // still genuinely in flight. Poll RootView's own `isMutating` flag instead: each iteration
      // yields a real tick (so the underlying subprocess I/O can actually progress) and the loop
      // exits the instant the flag flips, rather than waiting out a fixed sleep.
      const maxIterations = 2000
      for (let iteration = 0; iteration < maxIterations; iteration++) {
        if (app.view === undefined || !app.view.isMutating) break
        if (iteration === maxIterations - 1) {
          throw new Error("settle(): timed out waiting for RootView.isMutating to clear")
        }
        await new Promise((resolve) => setTimeout(resolve, 1))
      }
      await setup.flush()
    },
    frame: () => setup.captureCharFrame(),
    flush: () => setup.flush(),
    paneTextGeometry(id: FocusId) {
      return app.view?.paneTextGeometry(id)
    },
    async cleanup() {
      if (!reused) await repository.cleanup().catch(() => {})
      await fetchBare?.cleanup().catch(() => {})
      await pushBare?.cleanup().catch(() => {})
      app.destroy()
      setup.renderer.destroy()
      await repository.cleanup().catch(() => {})
    },
  }
}
