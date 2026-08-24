import { createTestRenderer, type KeyInput } from "@opentui/core/testing"
import { createApp, type App } from "../../src/app/create-app"
import { GitRunner } from "../../src/git/runner"
import { createTempRepository, type TempRepository } from "./temp-repository"

export type ShellHarnessOptions = {
  readonly width?: number
  readonly height?: number
  /** Commit subjects to create, oldest first. */
  readonly commits?: readonly string[]
  readonly stash?: boolean
}

export type ShellHarness = {
  readonly app: App
  readonly repository: TempRepository
  pressKey(key: KeyInput, modifiers?: { shift?: boolean; ctrl?: boolean }): Promise<void>
  drag(startX: number, startY: number, endX: number, endY: number): Promise<void>
  resize(width: number, height: number): Promise<void>
  frame(): string
  cleanup(): Promise<void>
}

export async function createShellHarness(options: ShellHarnessOptions = {}): Promise<ShellHarness> {
  const repository = await createTempRepository()
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
  // Leave one unstaged change so the working-tree target is never empty.
  await repository.write("b.txt", "unstaged\n")

  const setup = await createTestRenderer({
    width: options.width ?? 120,
    height: options.height ?? 40,
    useMouse: true,
    enableMouseMovement: true,
  })

  const app = createApp({
    repositoryRoot: repository.path,
    runner: new GitRunner(repository.path),
    renderer: setup.renderer,
  })
  await app.refresh()
  await setup.flush()

  return {
    app,
    repository,
    async pressKey(key, modifiers) {
      setup.mockInput.pressKey(key, modifiers)
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
    frame: () => setup.captureCharFrame(),
    async cleanup() {
      app.destroy()
      setup.renderer.destroy()
      await repository.cleanup()
    },
  }
}
