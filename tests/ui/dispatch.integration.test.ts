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

  test("Enter in the files pane opens the selected file in the main pane", async () => {
    // Regression test: OpenTUI reports a physical Enter keypress as key.name === "return", not
    // "enter". Press the real carriage return via KeyCodes.RETURN (not a synthetic { name:
    // "enter" } key object) so this exercises the actual terminal parse path, through
    // normalizeKey's return -> enter alias, rather than assuming the harness already hands
    // handlers a pre-normalized name.
    harness = await createShellHarness()

    await harness.pressKey("2") // focus files
    expect(harness.app.view!.focusManager.active).toBe("files")
    await harness.pressKey("RETURN")
    expect(harness.app.view!.focusManager.active).toBe("main")
  })

  test("Enter in the commits pane drills into the selected commit", async () => {
    // Same physical-Enter regression as above, exercised against the commits pane's
    // commit-drilldown binding.
    harness = await createShellHarness({ commits: ["alpha commit", "beta commit", "gamma commit"] })

    await harness.pressKey("4") // focus commits
    expect(harness.app.controller.state.reviewTarget.kind).not.toBe("commit")
    await harness.pressKey("RETURN")
    await harness.settle()
    expect(harness.app.controller.state.reviewTarget.kind).toBe("commit")
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

  test("a remote-tracking mismatch shows a confirmation prompt on the branches pane", async () => {
    // Regression for the mismatch branch of runRemoteCheckout leaving pendingRemoteMismatch set
    // (which makes modalInputActive() swallow every key but escape/d/enter) with no bottomTitle
    // ever set on the branches pane — a modal lockout with nothing on screen explaining it. Wide
    // enough that the branches pane has room to show the message without truncating it away.
    harness = await createShellHarness({ width: 600 })
    const bare = await createTempRepository()
    try {
      await bare.git(["config", "core.bare", "true"])
      await harness.repository.git(["remote", "add", "origin", bare.path])
      await harness.repository.git(["push", "origin", "HEAD:refs/heads/feature"])
      // Same setup as the exploit test above: a local branch of the same name that does NOT
      // track origin/feature, which is exactly what makes checkoutRemoteTracking report a
      // "mismatch" instead of switching cleanly.
      await harness.repository.git(["branch", "feature"])
      await harness.repository.git(["fetch", "origin"])
      await harness.app.refresh()

      await harness.app.controller.browseRemote("origin")
      harness.app.view!.update(harness.app.controller.state)

      await harness.pressKey("3") // focus branches
      const items = branchPaneItems(harness.app.controller.state)
      const targetIndex = items.findIndex((item) => item.kind === "remote-branch" && item.remote === "origin" && item.name === "feature")
      expect(targetIndex).toBeGreaterThanOrEqual(0)
      for (let i = 0; i < targetIndex; i++) await harness.pressKey("j")

      // Starts the remote-tracking checkout; it reports a mismatch and leaves a pending
      // confirmation modal open.
      await harness.pressKey(" ")
      await harness.settle()

      const frame = harness.frame()
      expect(frame).toContain("local branch feature has no upstream")
      expect(frame).toContain("Press Enter to confirm or Escape to cancel.")

      // Escape cancels the pending confirmation and clears the prompt from the pane.
      await harness.pressKey("ESCAPE")
      expect(harness.frame()).not.toContain("Press Enter to confirm or Escape to cancel.")
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

  test("Shift+D force-deletes a branch, requiring two matching presses", async () => {
    harness = await createShellHarness()
    await harness.repository.git(["branch", "throwaway"])
    await harness.app.refresh()

    await harness.pressKey("3") // focus branches
    const items = branchPaneItems(harness.app.controller.state)
    const targetIndex = items.findIndex((item) => item.kind === "local" && item.name === "throwaway")
    expect(targetIndex).toBeGreaterThanOrEqual(0)
    for (let i = 0; i < targetIndex; i++) await harness.pressKey("j")

    await harness.pressKey("D", { shift: true }) // first press: arms the force-delete confirmation only
    let listing = await harness.repository.git(["branch", "--list", "throwaway"])
    expect(listing.stdout).toContain("throwaway")

    await harness.pressKey("D", { shift: true }) // second press: confirms
    await harness.settle()
    listing = await harness.repository.git(["branch", "--list", "throwaway"])
    expect(listing.stdout).not.toContain("throwaway")
  })

  test("a d press followed by a Shift+D press does not complete a branch deletion", async () => {
    // The important regression case: the two-press confirmation must require the *same* force
    // flag on both presses. Before Shift+D had a binding, this scenario couldn't even be
    // exercised through real keys; now that it can, `d` then `D` must re-arm (with the new force
    // flag, per the existing mismatch-rearms-instead-of-deleting behaviour) rather than delete.
    harness = await createShellHarness()
    await harness.repository.git(["branch", "throwaway"])
    await harness.app.refresh()

    await harness.pressKey("3") // focus branches
    const items = branchPaneItems(harness.app.controller.state)
    const targetIndex = items.findIndex((item) => item.kind === "local" && item.name === "throwaway")
    expect(targetIndex).toBeGreaterThanOrEqual(0)
    for (let i = 0; i < targetIndex; i++) await harness.pressKey("j")

    await harness.pressKey("d") // arms a non-force delete confirmation
    await harness.pressKey("D", { shift: true }) // mismatched force flag: must not complete
    await harness.settle()
    const listing = await harness.repository.git(["branch", "--list", "throwaway"])
    expect(listing.stdout).toContain("throwaway")
  })

  test("a Shift+D press followed by a d press does not complete a branch deletion", async () => {
    // The reverse order of the case above, exercised independently (rather than chained onto it)
    // so the second press's re-arming doesn't leave a matching pending state for a third press to
    // walk into.
    harness = await createShellHarness()
    await harness.repository.git(["branch", "throwaway"])
    await harness.app.refresh()

    await harness.pressKey("3") // focus branches
    const items = branchPaneItems(harness.app.controller.state)
    const targetIndex = items.findIndex((item) => item.kind === "local" && item.name === "throwaway")
    expect(targetIndex).toBeGreaterThanOrEqual(0)
    for (let i = 0; i < targetIndex; i++) await harness.pressKey("j")

    await harness.pressKey("D", { shift: true }) // arms a force-delete confirmation
    await harness.pressKey("d") // mismatched force flag: must not complete
    await harness.settle()
    const listing = await harness.repository.git(["branch", "--list", "throwaway"])
    expect(listing.stdout).toContain("throwaway")
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
    // Cancel it. With pendingFileDiscard set, modalInputActive() is true, so this escape never
    // reaches the registry at all — handleModalKey's unconditional `key.name === "escape"` branch
    // calls actionBack() directly, bypassing dispatch/resolve (and their availability predicates)
    // entirely.
    await harness.pressKey("ESCAPE")

    // If escape had not cancelled the pending discard, this single press would be the
    // *confirming* second press and would delete the file immediately.
    await harness.pressKey("d")
    expect(await Bun.file(path).exists()).toBe(true)

    await harness.pressKey("d")
    await harness.settle()
    expect(await Bun.file(path).exists()).toBe(false)
  })

  test("ctrl+c quits even while a modal state is active", async () => {
    // `quitCalled` is set by either of two independent mechanisms (see shell-harness.ts): the
    // renderer's own `destroy` event (from OpenTUI's `exitOnCtrlC` handling, which fires
    // regardless of RootView's key routing) and RootView's `onQuit` (reached only via the "quit"
    // action). Because the harness folds both into one flag, this test cannot distinguish "quit
    // fired because ctrl+c routed through RootView to the quit action" from "quit fired only
    // because the renderer's own ctrl+c handling tore it down" — it would pass even against a
    // RootView that swallowed ctrl+c entirely while a modal was open. It pins the user-visible
    // property (the process quits) rather than RootView's routing of the key.
    harness = await createShellHarness()
    await harness.pressKey("3") // focus branches
    await harness.pressKey("/") // open the branch filter: a modal input state
    expect(harness.quitCalled).toBe(false)

    await harness.pressKey("c", { ctrl: true })
    expect(harness.quitCalled).toBe(true)
  })
})

describe("commits pane drives the main pane like lazygit", () => {
  let harness: ShellHarness | undefined
  afterEach(async () => {
    await harness?.cleanup()
    harness = undefined
  })

  /** Preview loads run outside the mutation queue; RootView exposes their inflight promise. */
  async function pressKeyForPreview(key: string): Promise<void> {
    await harness!.pressKey(key)
    await harness!.app.view!.whenPreviewSettled()
  }

  test("focusing commits previews the selected commit without entering it", async () => {
    harness = await createShellHarness({ commits: ["alpha commit", "beta commit", "gamma commit"] })

    await pressKeyForPreview("4")
    const frame = harness.frame()
    expect(frame).toContain("revision 2") // the newest commit's a.txt content
    expect(frame).toContain("0 Main —")
    // Browsing must not switch the review target: side panels keep working-tree semantics.
    expect(frame).toContain("Target: Working Tree")
    expect(frame).toContain("b.txt")
  })

  test("j re-points the preview at the newly selected commit", async () => {
    harness = await createShellHarness({ commits: ["alpha commit", "beta commit", "gamma commit"] })

    await pressKeyForPreview("4")
    expect(harness.frame()).toContain("revision 2")
    await pressKeyForPreview("j")
    expect(harness.frame()).toContain("revision 1")
  })

  test("leaving the commits pane restores the working-tree patch", async () => {
    harness = await createShellHarness({ commits: ["alpha commit", "beta commit", "gamma commit"] })

    await pressKeyForPreview("4")
    expect(harness.frame()).toContain("revision 2")
    await harness.pressKey("2")
    await harness.app.view!.whenPreviewSettled()
    const frame = harness.frame()
    expect(frame).toContain("+unstaged")
    expect(frame).not.toContain("revision 2")
  })
})
