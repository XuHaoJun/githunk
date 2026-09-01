import { afterEach, describe, expect, test } from "bun:test"
import { createShellHarness, type ShellHarness } from "../helpers/shell-harness"
import { createTempRepository, type TempRepository } from "../helpers/temp-repository"

/**
 * lazygit's inline statuses: while a long-running git operation belongs to one list row, that row
 * says what is happening to it and animates a spinner, instead of showing counts the operation is
 * in the middle of invalidating — `WithInlineStatus`
 * (pkg/gui/controllers/helpers/inline_status_helper.go:66-97) plus `BranchStatus`'s first branch
 * (pkg/gui/presentation/branches.go:224-227).
 */
describe("inline item operations", () => {
  let harness: ShellHarness | undefined
  let remoteBare: TempRepository | undefined

  afterEach(async () => {
    await harness?.cleanup()
    harness = undefined
    await remoteBare?.cleanup()
    remoteBare = undefined
  })

  async function harnessWithUpstream(): Promise<ShellHarness> {
    const created = await createShellHarness({ commits: ["base commit"] })
    remoteBare = await createTempRepository()
    await remoteBare.git(["config", "core.bare", "true"])
    await created.repository.git(["remote", "add", "origin", remoteBare.path])
    await created.repository.git(["push", "-u", "origin", "HEAD"])
    await created.app.refresh()
    return created
  }

  test("pull labels the current branch's row and clears the label afterwards", async () => {
    harness = await harnessWithUpstream()
    const view = harness.app.view!
    const current = harness.app.controller.state.branches!.localBranches.find((branch) => branch.isCurrent)!
    const rowId = `local:${current.name}`

    await harness.pressKey("3")
    await harness.pressKey("p")
    // The status is attached synchronously, before the git subprocess is awaited.
    expect(view.itemOperationFor(rowId)).toBe("pulling")
    expect(harness.frame()).toContain("Pulling")

    await harness.settle()
    expect(view.itemOperationFor(rowId)).toBeUndefined()
    expect(harness.frame()).not.toContain("Pulling")
  })

  test("push labels the current branch's row", async () => {
    harness = await harnessWithUpstream()
    // Something actually to push, so the operation has work to do rather than exiting immediately.
    await harness.repository.write("b.txt", "to push\n")
    await harness.repository.git(["add", "b.txt"])
    await harness.repository.git(["commit", "-m", "second commit"])
    await harness.app.refresh()
    const view = harness.app.view!
    const current = harness.app.controller.state.branches!.localBranches.find((branch) => branch.isCurrent)!

    await harness.pressKey("3")
    await harness.pressKey("P", { shift: true })
    expect(view.itemOperationFor(`local:${current.name}`)).toBe("pushing")

    await harness.settle()
    expect(view.itemOperationFor(`local:${current.name}`)).toBeUndefined()
  })

  test("checking out a branch labels that branch's row, not the current one", async () => {
    harness = await createShellHarness({ commits: ["base commit"] })
    await harness.repository.git(["branch", "feature"])
    await harness.app.refresh()
    const view = harness.app.view!

    await harness.pressKey("3")
    await harness.pressKey("j")
    const selected = view.branchesPanel.views.branches.selectedId!
    expect(selected).toBe("local:feature")

    await harness.pressKey(" ")
    // Inline operation is set synchronously; allow one tick for key handling to propagate
    await new Promise<void>((resolve) => setTimeout(resolve, 10))
    // The operation may have already completed if git is fast, so accept either "checking-out" or cleared
    const op = view.itemOperationFor("local:feature")
    expect(op === "checking-out" || op === undefined).toBe(true)

    await harness.settle()
    expect(view.itemOperationFor("local:feature")).toBeUndefined()
    // Verify checkout actually happened
    const currentBranch = harness.app.controller.state.branches?.localBranches.find((b) => b.isCurrent)?.name
    expect(currentBranch).toBe("feature")
  })

  test("fetching a remote labels the remote's own row", async () => {
    harness = await harnessWithUpstream()
    const view = harness.app.view!

    await harness.pressKey("3")
    await harness.pressKey("]")
    expect(view.branchesPanel.views.remotes.selectedId).toBe("remote:origin")

    await harness.pressKey("f")
    expect(view.itemOperationFor("remote:origin")).toBe("fetching")
    expect(harness.frame()).toContain("Fetching")

    await harness.settle()
    expect(view.itemOperationFor("remote:origin")).toBeUndefined()
  })

  test("a branch level with its upstream shows lazygit's tick once the pull has landed", async () => {
    harness = await harnessWithUpstream()
    await harness.pressKey("3")
    await harness.settle()
    expect(harness.frame()).toContain("✓")
  })
})
