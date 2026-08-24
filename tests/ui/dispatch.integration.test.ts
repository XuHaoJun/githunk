import { afterEach, describe, expect, test } from "bun:test"
import { createShellHarness, type ShellHarness } from "../helpers/shell-harness"
import { getMainCursorTarget } from "../../src/ui/panes/main-pane"
import { branchPaneItems } from "../../src/ui/panes/branches-pane"
import { createTempRepository } from "../helpers/temp-repository"

describe("root view dispatch", () => {
  let harness: ShellHarness | undefined
  afterEach(async () => {
    await harness?.cleanup()
    harness = undefined
  })

  test("h and l move focus between panes", async () => {
    harness = await createShellHarness()
    const view = harness.app.view
    expect(view).toBeDefined()

    await harness.pressKey("2")
    expect(view!.focusManager.active).toBe("files")
    await harness.pressKey("l")
    expect(view!.focusManager.active).toBe("branches")
    await harness.pressKey("l")
    expect(view!.focusManager.active).toBe("commits")
    await harness.pressKey("h")
    expect(view!.focusManager.active).toBe("branches")
  })

  test("tab and shift+tab cycle panes in the same order as l and h", async () => {
    harness = await createShellHarness()
    const view = harness.app.view!

    await harness.pressKey("2")
    await harness.pressKey("TAB")
    expect(view.focusManager.active).toBe("branches")
    await harness.pressKey("TAB", { shift: true })
    expect(view.focusManager.active).toBe("files")
  })

  test("j and k move the commits cursor over real commits", async () => {
    harness = await createShellHarness({ commits: ["alpha commit", "beta commit", "gamma commit"] })

    await harness.pressKey("4")
    expect(harness.frame()).toContain("gamma commit")
    await harness.pressKey("j")
    expect(harness.frame()).toContain("beta commit")
  })

  test("bracket keys change the main scope and tab no longer does", async () => {
    harness = await createShellHarness()

    await harness.pressKey("0")
    const before = harness.app.controller.state.title
    await harness.pressKey("TAB")
    expect(harness.app.controller.state.title).toBe(before)
    // Tab now also cycles pane focus (this task's new pane-next binding), so return to
    // main before checking that the bracket keys — not tab — are what move the scope.
    await harness.pressKey("0")
    await harness.pressKey("]")
    await harness.settle()
    expect(harness.app.controller.state.title).not.toBe(before)
  })

  test("[ moves the scope the opposite way from ]", async () => {
    harness = await createShellHarness()

    await harness.pressKey("0")
    const initial = harness.app.controller.state.title
    await harness.pressKey("]")
    await harness.settle()
    const afterNext = harness.app.controller.state.title
    expect(afterNext).not.toBe(initial)
    await harness.pressKey("[")
    await harness.settle()
    // If scope-next and scope-previous were bound the wrong way around, "[" after "]" would
    // advance to a third scope instead of returning to the first.
    expect(harness.app.controller.state.title).toBe(initial)
  })

  test("every declared action has a handler", async () => {
    // RootView calls assertHandlersCover in its constructor, so construction
    // failing at all is the assertion. An explicit case documents the intent.
    harness = await createShellHarness()
    expect(harness.app.view).toBeDefined()
  })

  test("a remote-tracking mismatch modal does not let d delete an unrelated local branch", async () => {
    harness = await createShellHarness()
    const bare = await createTempRepository()
    try {
      await bare.git(["config", "core.bare", "true"])
      await harness.repository.git(["remote", "add", "origin", bare.path])
      await harness.repository.git(["push", "origin", "HEAD:refs/heads/feature"])
      // A local branch of the same name that does NOT track origin/feature: this is exactly what
      // makes checkoutRemoteTracking report a "mismatch" instead of switching cleanly.
      await harness.repository.git(["branch", "feature"])
      await harness.repository.git(["fetch", "origin"])
      await harness.app.refresh()

      // The branches pane loads a remote's branches lazily, normally via pressing enter (the
      // "inspect" action) on the remote itself. Load it directly here so the test is about the
      // exploit, not about driving that unrelated drill-down through simulated keys.
      await harness.app.controller.browseRemote("origin")
      harness.app.view!.update(harness.app.controller.state)

      await harness.pressKey("3") // focus branches
      const items = branchPaneItems(harness.app.controller.state)
      const targetIndex = items.findIndex((item) => item.kind === "remote-branch" && item.remote === "origin" && item.name === "feature")
      expect(targetIndex).toBeGreaterThanOrEqual(0)
      for (let i = 0; i < targetIndex; i++) await harness.pressKey("j")

      // Starts the remote-tracking checkout; it reports a mismatch and leaves a pending
      // confirmation modal open, with the remote-branch item still selected.
      await harness.pressKey(" ")
      await harness.settle()

      // The exploit this guards against: with the mismatch modal pending, `d` used to call
      // actionBranchDelete directly, using the still-selected remote-branch item's `name` —
      // which happens to equal the *local* branch "feature" — bypassing the "only a local
      // branch is deletable" predicate entirely. Two presses would delete "feature" even
      // though the user never selected a local branch at all.
      await harness.pressKey("d")
      await harness.pressKey("d")
      await harness.settle()

      const stillThere = await harness.repository.git(["branch", "--list", "feature"])
      expect(stillThere.stdout).toContain("feature")
    } finally {
      await bare.cleanup()
    }
  })

  test("file discard requires two presses; the first does not mutate", async () => {
    harness = await createShellHarness()
    const path = `${harness.repository.path}/b.txt`
    expect(await Bun.file(path).exists()).toBe(true)

    await harness.pressKey("2") // focus files; b.txt is the only (untracked) entry
    await harness.pressKey("d") // first press: arms the confirmation only
    expect(await Bun.file(path).exists()).toBe(true)

    await harness.pressKey("d") // second press: confirms
    await harness.settle()
    expect(await Bun.file(path).exists()).toBe(false)
  })

  test("branch delete requires two presses; the first does not mutate", async () => {
    harness = await createShellHarness()
    await harness.repository.git(["branch", "throwaway"])
    await harness.app.refresh()

    await harness.pressKey("3") // focus branches
    const items = branchPaneItems(harness.app.controller.state)
    const targetIndex = items.findIndex((item) => item.kind === "local" && item.name === "throwaway")
    expect(targetIndex).toBeGreaterThanOrEqual(0)
    for (let i = 0; i < targetIndex; i++) await harness.pressKey("j")

    await harness.pressKey("d") // first press: arms the confirmation only
    let listing = await harness.repository.git(["branch", "--list", "throwaway"])
    expect(listing.stdout).toContain("throwaway")

    await harness.pressKey("d") // second press: confirms
    await harness.settle()
    listing = await harness.repository.git(["branch", "--list", "throwaway"])
    expect(listing.stdout).not.toContain("throwaway")
  })

  test("stash drop requires two presses; the first does not mutate", async () => {
    harness = await createShellHarness({ stash: true })
    await harness.pressKey("5") // focus stash

    let listing = await harness.repository.git(["stash", "list"])
    expect(listing.stdout.trim().length).toBeGreaterThan(0)

    await harness.pressKey("d") // first press: arms the confirmation only
    listing = await harness.repository.git(["stash", "list"])
    expect(listing.stdout.trim().length).toBeGreaterThan(0)

    await harness.pressKey("d") // second press: confirms
    await harness.settle()
    listing = await harness.repository.git(["stash", "list"])
    expect(listing.stdout.trim().length).toBe(0)
  })

  test("escape from the files pane cancels a pending file discard", async () => {
    harness = await createShellHarness()
    const path = `${harness.repository.path}/b.txt`

    await harness.pressKey("2") // focus files; b.txt is the only (untracked) entry
    await harness.pressKey("d") // arm the confirmation
    await harness.pressKey("ESCAPE") // cancel it — files has no commit-back available, so this
    // falls through from the (unavailable) context binding to the global "back" binding.

    // If escape had not cancelled the pending discard, this single press would be the
    // *confirming* second press and would delete the file immediately.
    await harness.pressKey("d")
    expect(await Bun.file(path).exists()).toBe(true)

    await harness.pressKey("d")
    await harness.settle()
    expect(await Bun.file(path).exists()).toBe(false)
  })

  test("ctrl+c quits even while a modal state is active", async () => {
    harness = await createShellHarness()
    await harness.pressKey("3") // focus branches
    await harness.pressKey("/") // open the branch filter: a modal input state
    expect(harness.quitCalled).toBe(false)

    await harness.pressKey("c", { ctrl: true })
    expect(harness.quitCalled).toBe(true)
  })
})
