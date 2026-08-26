import { afterEach, describe, expect, test } from "bun:test"
import { BoxRenderable, TextareaRenderable } from "@opentui/core"
import { createShellHarness, type ShellHarness } from "../helpers/shell-harness"
import { createTempRepository, type TempRepository } from "../helpers/temp-repository"

/**
 * lazygit commits whatever the index holds straight from the mixed Files list
 * (pkg/gui/controllers/helpers/working_tree_helper.go:229 `WithEnsureCommittableFiles`):
 * nothing staged prompts to stage everything, then the handler retries. These
 * tests pin that contract for both `c` and `A`, including the scope-independence
 * of availability — githunk must not require switching to the Staged scope first.
 */

/** Base commit, an unstaged edit to a.txt, and a staged (worktree-clean) edit to b.txt. */
async function mixedStaging(repository: TempRepository): Promise<void> {
  await repository.write("a.txt", "a\n")
  await repository.write("b.txt", "b\n")
  await repository.git(["add", "-A"])
  await repository.git(["commit", "-m", "base"])
  await repository.write("a.txt", "a changed\n")
  await repository.write("b.txt", "b changed\n")
  await repository.git(["add", "b.txt"])
}

/** Base commit and one unstaged edit; the index is empty. */
async function nothingStaged(repository: TempRepository): Promise<void> {
  await repository.write("a.txt", "a\n")
  await repository.git(["add", "-A"])
  await repository.git(["commit", "-m", "base"])
  await repository.write("a.txt", "a changed\n")
}

async function installRejectingCommitHook(repository: TempRepository): Promise<void> {
  await repository.write(".git/hooks/commit-msg", "#!/bin/sh\necho hook failed >&2\nexit 1\n")
  await Bun.spawn(["chmod", "+x", `${repository.path}/.git/hooks/commit-msg`]).exited
}

async function lastSubject(repository: TempRepository): Promise<string> {
  const log = await repository.git(["log", "-1", "--pretty=%s"])
  return log.stdout.trim()
}

describe("committing from the files pane", () => {
  let harness: ShellHarness | undefined
  let repository: TempRepository | undefined
  afterEach(async () => {
    await harness?.cleanup()
    harness = undefined
    await repository?.cleanup()
    repository = undefined
  })

  test("c opens a centered summary and description popup from the all scope", async () => {
    repository = await createTempRepository()
    await mixedStaging(repository)
    harness = await createShellHarness({ repository })

    await harness.pressKey("2")
    expect(harness.app.controller.state.reviewTarget).toEqual({ kind: "working-tree", scope: "all" })
    await harness.pressKey("c")
    const view = harness.app.view!
    const popup = view.root.findDescendantById("commit-message-popup")
    const summaryBox = view.root.findDescendantById("commit-summary-box")
    const summaryEditor = view.root.findDescendantById("commit-summary-editor")
    const descriptionBox = view.root.findDescendantById("commit-description-box")
    const hint = view.root.findDescendantById("commit-description-hint")
    expect(popup?.visible).toBe(true)
    expect(popup?.left).toBeGreaterThan(0)
    expect(popup?.top).toBeGreaterThan(0)
    expect(popup).toBeInstanceOf(BoxRenderable)
    const popupBox = popup instanceof BoxRenderable ? popup : undefined
    expect(popupBox?.backgroundColor.intent).toBe("default")
    expect(summaryBox).toBeInstanceOf(BoxRenderable)
    expect(descriptionBox).toBeInstanceOf(BoxRenderable)
    const summaryField = summaryBox instanceof BoxRenderable ? summaryBox : undefined
    const descriptionField = descriptionBox instanceof BoxRenderable ? descriptionBox : undefined
    expect(summaryField?.borderColor.intent).toBe("indexed")
    expect(summaryField?.borderColor.slot).toBe(2)
    expect(descriptionField?.borderColor.intent).toBe("default")
    expect(summaryEditor).toBeInstanceOf(TextareaRenderable)
    const summaryInput = summaryEditor instanceof TextareaRenderable ? summaryEditor : undefined
    expect(summaryInput?.backgroundColor.intent).toBe("default")
    expect(summaryInput?.textColor.intent).toBe("default")
    expect(summaryInput?.cursorStyle.style).toBe("block")
    expect(popupBox?.border).toBe(false)
    expect(summaryEditor?.screenX).toBeGreaterThan(summaryBox?.screenX ?? -1)
    expect(summaryEditor?.screenY).toBeGreaterThan(summaryBox?.screenY ?? -1)
    expect((summaryEditor?.screenX ?? 0) + (summaryEditor?.width ?? 0))
      .toBeLessThanOrEqual((summaryBox?.screenX ?? 0) + (summaryBox?.width ?? 0) - 1)
    expect(hint?.screenY).toBe(descriptionBox?.screenY)
    expect((hint?.screenX ?? 0) + (hint?.width ?? 0))
      .toBeGreaterThanOrEqual((descriptionBox?.screenX ?? 0) + (descriptionBox?.width ?? 0) - 2)
    const frame = harness.frame()
    expect(frame).toContain("Commit summary")
    expect(frame).toContain("Commit description")
    const cursor = harness.renderer.getCursorState()
    expect(cursor.visible).toBe(true)
    expect(cursor.x).toBeGreaterThan(summaryEditor?.screenX ?? -1)
    expect(cursor.x).toBeLessThan((summaryBox?.screenX ?? 0) + (summaryBox?.width ?? 0))
    expect(cursor.y).toBeGreaterThan(summaryEditor?.screenY ?? -1)
    expect(cursor.y).toBeLessThan((summaryBox?.screenY ?? 0) + (summaryBox?.height ?? 0))
    expect(frame).toContain("Enter submit")
    expect(frame).not.toContain("Commit staged changes")

    for (const key of ["m", "s", "g"]) await harness.pressKey(key)
    expect(harness.frame()).toContain("msg")
    await harness.pressKey("RETURN")
    await harness.settle()

    expect(await lastSubject(repository)).toBe("msg")
    expect(view.root.findDescendantById("commit-message-popup")?.visible).toBe(false)
  })

  test("description receives multiline text and Ctrl+Enter confirms it", async () => {
    repository = await createTempRepository()
    await nothingStaged(repository)
    harness = await createShellHarness({ repository })

    await harness.pressKey("2")
    await harness.pressKey("a")
    await harness.settle()
    await harness.pressKey("c")
    for (const key of ["s", "u", "b", "j", "e", "c", "t"]) await harness.pressKey(key)
    await harness.pressKey("TAB")
    expect(harness.frame()).toContain("Ctrl+Enter submit")
    for (const key of ["b", "o", "d", "y"]) await harness.pressKey(key)
    await harness.pressKey("RETURN", { ctrl: true })
    await harness.settle()

    const message = await repository.git(["log", "-1", "--pretty=%B"])
    expect(message.stdout.trimEnd()).toBe("subject\n\nbody")
    expect(harness.app.view!.root.findDescendantById("commit-message-popup")?.visible).toBe(false)
  })
  test("c with nothing staged stages everything on the second press, as lazygit's prompt does", async () => {
    repository = await createTempRepository()
    await nothingStaged(repository)
    harness = await createShellHarness({ repository })

    await harness.pressKey("2")
    await harness.pressKey("c")
    await harness.settle()
    expect(harness.frame()).toContain("stage everything")
    expect(harness.frame()).not.toContain("Commit summary")
    expect(await lastSubject(repository)).toBe("base")

    await harness.pressKey("c")
    await harness.settle()
    expect(harness.frame()).toContain("Commit summary")
    const unstaged = await repository.git(["diff", "--name-only"])
    expect(unstaged.stdout.trim()).toBe("")

    for (const key of ["a", "l", "l"]) await harness.pressKey(key)
    await harness.pressKey("RETURN")
    await harness.settle()
    expect(await lastSubject(repository)).toBe("all")
  })

  test("keeps the popup message and hook error visible after commit failure", async () => {
    repository = await createTempRepository()
    await nothingStaged(repository)
    await repository.git(["add", "a.txt"])
    await installRejectingCommitHook(repository)
    harness = await createShellHarness({ repository })

    await harness.pressKey("2")
    await harness.pressKey("c")
    for (const key of ["h", "o", "o", "k", " ", "f", "a", "i", "l"]) await harness.pressKey(key)
    await harness.pressKey("RETURN")
    await harness.settle()

    expect(await lastSubject(repository)).toBe("base")
    const frame = harness.frame()
    expect(frame).toContain("Commit summary")
    expect(frame).toContain("hook fail")
    expect(frame).toContain("hook failed")
  })

  test("A shares the stage-everything retry before amending", async () => {
    repository = await createTempRepository()
    await nothingStaged(repository)
    harness = await createShellHarness({ repository })

    await harness.pressKey("2")
    await harness.pressKey("A")
    await harness.settle()
    expect(harness.frame()).toContain("stage everything")
    expect(await lastSubject(repository)).toBe("base")

    await harness.pressKey("A")
    await harness.settle()
    const amendFrame = harness.frame()
    expect(amendFrame).toContain("Amend commit")
    expect(amendFrame).toContain("Commit description")
    expect(amendFrame).toContain("base")
    // The summary editor opens with the current subject prefilled; replace it before confirming.
    for (let index = 0; index < 4; index++) await harness.pressKey("BACKSPACE")
    for (const key of ["a", "m", "e", "n", "d", "e", "d"]) await harness.pressKey(key)
    await harness.pressKey("RETURN")
    await harness.settle()
    expect(await lastSubject(repository)).toBe("amended")
    const count = await repository.git(["rev-list", "--count", "HEAD"])
    expect(count.stdout.trim()).toBe("1")
    expect(harness.app.view!.root.findDescendantById("commit-message-popup")?.visible).toBe(false)
  })
})
