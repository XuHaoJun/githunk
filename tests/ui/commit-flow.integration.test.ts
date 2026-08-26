import { afterEach, describe, expect, test } from "bun:test"
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

  test("c commits the staged index directly from the all scope", async () => {
    repository = await createTempRepository()
    await mixedStaging(repository)
    harness = await createShellHarness({ repository })

    await harness.pressKey("2")
    expect(harness.app.controller.state.reviewTarget).toEqual({ kind: "working-tree", scope: "all" })
    await harness.pressKey("c")
    expect(harness.frame()).toContain("Commit staged changes")

    for (const key of ["m", "s", "g"]) await harness.pressKey(key)
    await harness.pressKey("RETURN", { ctrl: true })
    await harness.settle()

    expect(await lastSubject(repository)).toBe("msg")
  })

  test("c with nothing staged stages everything on the second press, as lazygit's prompt does", async () => {
    repository = await createTempRepository()
    await nothingStaged(repository)
    harness = await createShellHarness({ repository })

    await harness.pressKey("2")
    await harness.pressKey("c")
    await harness.settle()
    expect(harness.frame()).toContain("stage everything")
    expect(harness.frame()).not.toContain("Commit staged changes")
    expect(await lastSubject(repository)).toBe("base")

    await harness.pressKey("c")
    await harness.settle()
    expect(harness.frame()).toContain("Commit staged changes")
    const unstaged = await repository.git(["diff", "--name-only"])
    expect(unstaged.stdout.trim()).toBe("")

    for (const key of ["a", "l", "l"]) await harness.pressKey(key)
    await harness.pressKey("RETURN", { ctrl: true })
    await harness.settle()
    expect(await lastSubject(repository)).toBe("all")
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
    expect(harness.frame()).toContain("Amend commit")
    // The dialog opens prefilled with the current message; replace it rather than appending,
    // since appended text after the trailing blank lines lands in the body, not the subject.
    for (let index = 0; index < 6; index++) await harness.pressKey("BACKSPACE")
    for (const key of ["a", "m", "e", "n", "d", "e", "d"]) await harness.pressKey(key)
    await harness.pressKey("RETURN", { ctrl: true })
    await harness.settle()

    expect(await lastSubject(repository)).toBe("amended")
    const count = await repository.git(["rev-list", "--count", "HEAD"])
    expect(count.stdout.trim()).toBe("1")
  })
})
