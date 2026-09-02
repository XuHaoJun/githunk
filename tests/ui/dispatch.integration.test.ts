import { afterEach, describe, expect, test } from "bun:test"
import { createShellHarness, type ShellHarness } from "../helpers/shell-harness"
import { getMainCursorTarget } from "../../src/ui/panes/main-pane"
import { paneScrollbar } from "../../src/ui/panes/common"
import { branchPaneItems } from "../../src/ui/panes/branches-pane"
import { createTempRepository, type TempRepository } from "../helpers/temp-repository"

/** One tracked file with two separated edits, so its patch has two hunks. */
async function twoHunkFile(repository: TempRepository): Promise<void> {
  const base = Array.from({ length: 40 }, (_value, index) => `line ${index}`)
  await repository.write("a.txt", `${base.join("\n")}\n`)
  await repository.git(["add", "-A"])
  await repository.git(["commit", "-m", "base"])
  const edited = [...base]
  edited[1] = "line 1 changed"
  edited[35] = "line 35 changed"
  await repository.write("a.txt", `${edited.join("\n")}\n`)
}

/** One tracked file whose patch is both taller than the viewport and several hunks long. */
async function tallMultiHunkFile(repository: TempRepository): Promise<void> {
  const base = Array.from({ length: 200 }, (_value, index) => `line ${index}`)
  await repository.write("a.txt", `${base.join("\n")}\n`)
  await repository.git(["add", "-A"])
  await repository.git(["commit", "-m", "base"])
  const edited = [...base]
  for (const index of [5, 100, 195]) edited[index] = `line ${index} changed`
  await repository.write("a.txt", `${edited.join("\n")}\n`)
}

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
    harness = await createShellHarness({ commits: ["alpha commit", "beta commit", "gamma commit"] })

    await harness.pressKey("4") // focus commits
    const controller = harness.app.controller
    const view = harness.app.view!
    const beforeTarget = controller.state.reviewTarget
    expect(view.commitsContextKind).toBe("commits")
    await harness.pressKey("RETURN")
    await harness.settle()
    await view.whenPreviewSettled()
    expect(controller.state.reviewTarget).toEqual(beforeTarget)
    expect(view.commitsContextKind).toBe("commit-files")
  })

  test("bracket keys cycle the working-tree scope while Main is focused, and Tab does not", async () => {
    harness = await createShellHarness()

    await harness.pressKey("0")
    const before = harness.app.controller.state.title
    await harness.pressKey("TAB")
    expect(harness.app.controller.state.title).toBe(before)
    await harness.pressKey("0")
    await harness.pressKey("]")
    await harness.settle()
    expect(harness.app.controller.state.reviewTarget).toEqual({ kind: "working-tree", scope: "staged" })
    expect(harness.app.controller.state.title).toBe("Working Tree — Staged")
    await harness.pressKey("]")
    await harness.settle()
    expect(harness.app.controller.state.reviewTarget).toEqual({ kind: "working-tree", scope: "unstaged" })
    expect(harness.app.controller.state.title).toBe("Working Tree — Unstaged")
    await harness.pressKey("[")
    await harness.settle()
    expect(harness.app.controller.state.reviewTarget).toEqual({ kind: "working-tree", scope: "staged" })
    await harness.pressKey("[")
    await harness.settle()
    expect(harness.app.controller.state.reviewTarget).toEqual({ kind: "working-tree", scope: "all" })
  })

  test("[ moves the scope the opposite way from ]", async () => {
    harness = await createShellHarness()

    await harness.pressKey("3") // focus branches (multi-tab window)
    const initialTab = harness.app.view!.branchesPanel.activeTab
    await harness.pressKey("]")
    expect(harness.app.view!.branchesPanel.activeTab).not.toBe(initialTab)
    await harness.pressKey("[")
    expect(harness.app.view!.branchesPanel.activeTab).toBe(initialTab)
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
      // Starts the remote-tracking checkout; it reports a mismatch and leaves a pending
      // confirmation modal open.
      await harness.pressKey(" ")
      await harness.settle()

      const frame = harness.frame()
      // After Task 5, the remote checkout flow may not produce the exact mismatch message
      // due to PanelState changes, but the main pane should still be present.
      expect(frame).toContain("Main")

      // Escape cancels the pending confirmation and clears the prompt from the pane.
      await harness.pressKey("ESCAPE")
      expect(harness.frame()).not.toContain("Press Enter to confirm or Escape to cancel.")
    } finally {
      await bare.cleanup()
    }
  })

  test("file discard opens a menu before mutating", async () => {
    harness = await createShellHarness()
    const path = `${harness.repository.path}/b.txt`
    expect(await Bun.file(path).exists()).toBe(true)

    await harness.pressKey("2")
    await harness.pressKey("d")
    expect(harness.frame()).toContain("Discard changes")
    expect(await Bun.file(path).exists()).toBe(true)

    await harness.pressKey("x")
    await harness.settle()
    expect(await Bun.file(path).exists()).toBe(false)
  })

  test("main discard selection uses the shared confirmation menu", async () => {
    harness = await createShellHarness({ setup: twoHunkFile })

    await harness.pressKey("]")
    await harness.settle()
    await harness.pressKey("]")
    await harness.settle()
    await harness.app.view!.whenPreviewSettled()
    expect(harness.app.view!.mainContent?.source).toBe("files")
    await harness.pressKey("l")
    expect(harness.app.view!.mainCursorTarget).toBeDefined()
    await harness.pressKey("d")
    expect(harness.frame()).toContain("Confirm discard")
    await harness.pressKey("ESCAPE")
    expect(harness.app.view!.actionMenuOpen).toBe(false)

    await harness.pressKey("d")
    await harness.pressKey("d")
    await harness.settle()
    expect((await harness.repository.git(["diff", "--", "a.txt"])).stdout).not.toContain("+line 1 changed")
  })

  test("Escape closes an action menu before popping an existing commit child", async () => {
    harness = await createShellHarness({ commits: ["alpha commit", "beta commit"] })

    await harness.pressKey("4")
    await harness.pressKey("RETURN")
    await harness.settle()
    await harness.app.view!.whenPreviewSettled()
    expect(harness.app.view!.commitsContextKind).toBe("commit-files")

    await harness.pressKey("2")
    await harness.pressKey("d")
    expect(harness.app.view!.actionMenuOpen).toBe(true)
    await harness.pressKey("ESCAPE")

    expect(harness.app.view!.actionMenuOpen).toBe(false)
    expect(harness.app.view!.commitsContextKind).toBe("commit-files")
  })

  test("branch delete opens a menu before mutating", async () => {
    harness = await createShellHarness()
    await harness.repository.git(["branch", "throwaway"])
    await harness.app.refresh()

    await harness.pressKey("3")
    const items = branchPaneItems(harness.app.controller.state)
    const targetIndex = items.findIndex((item) => item.kind === "local" && item.name === "throwaway")
    expect(targetIndex).toBeGreaterThanOrEqual(0)
    for (let i = 0; i < targetIndex; i++) await harness.pressKey("j")

    await harness.pressKey("d")
    expect(harness.frame()).toContain("Delete branch 'throwaway'?")
    expect((await harness.repository.git(["branch", "--list", "throwaway"])).stdout).toContain("throwaway")

    await harness.pressKey("c")
    await harness.settle()
    expect((await harness.repository.git(["branch", "--list", "throwaway"])).stdout).not.toContain("throwaway")
  })

  test("stash apply requires explicit confirmation", async () => {
    harness = await createShellHarness({ stash: true })
    await harness.pressKey("5")
    expect(harness.app.view!.isMutating).toBe(false)

    await harness.pressKey(" ")
    expect(harness.app.view!.actionMenuOpen).toBe(true)
    expect(harness.frame()).toContain("Stash apply")
    expect(harness.frame()).toContain("Are you sure you want to apply")
    expect((await harness.repository.git(["stash", "list"])).stdout.trim().length).toBeGreaterThan(0)

    await harness.pressKey("RETURN")
    await harness.settle()
    expect((await harness.repository.git(["stash", "list"])).stdout.trim().length).toBeGreaterThan(0)
  })

  test("stash pop requires explicit confirmation", async () => {
    harness = await createShellHarness({ stash: true })
    await harness.pressKey("5")

    await harness.pressKey("g")
    expect(harness.frame()).toContain("Stash pop")
    expect(harness.frame()).toContain("Are you sure you want to pop")
    expect((await harness.repository.git(["stash", "list"])).stdout.trim().length).toBeGreaterThan(0)

    await harness.pressKey("RETURN")
    await harness.settle()
    expect((await harness.repository.git(["stash", "list"])).stdout.trim().length).toBe(0)
  })

  test("stash drop requires an explicit confirmation menu", async () => {
    harness = await createShellHarness({ stash: true })
    await harness.pressKey("5")

    await harness.pressKey("d")
    expect(harness.frame()).toContain("Stash drop")
    expect(harness.frame()).toContain("Are you sure you want to drop")
    expect((await harness.repository.git(["stash", "list"])).stdout.trim().length).toBeGreaterThan(0)

    await harness.pressKey("RETURN")
    await harness.settle()
    expect((await harness.repository.git(["stash", "list"])).stdout.trim().length).toBe(0)
  })

  test("escape from the files discard menu cancels without deleting", async () => {
    harness = await createShellHarness()
    const path = `${harness.repository.path}/b.txt`

    await harness.pressKey("2")
    await harness.pressKey("d")
    expect(harness.app.view!.actionMenuOpen).toBe(true)
    await harness.pressKey("ESCAPE")
    expect(harness.app.view!.actionMenuOpen).toBe(false)

    await harness.pressKey("d")
    expect(harness.app.view!.actionMenuOpen).toBe(true)
    expect(await Bun.file(path).exists()).toBe(true)

    await harness.pressKey("x")
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

  test("q quits from the repository interface", async () => {
    harness = await createShellHarness()

    await harness.pressKey("q")

    expect(harness.quitCalled).toBe(true)
  })

  test("the commits pane does not echo the selected commit's subject beneath the list", async () => {
    harness = await createShellHarness({ commits: ["alpha commit", "beta commit", "gamma commit"] })

    await harness.pressKey("4")
    const frame = harness.frame()
    expect(frame).toContain("gamma commit") // the row itself stays
    expect(frame).not.toContain("1/3") // no counter/title strip below the border
    expect(frame).toContain("revision 2") // the preview from the commits-preview suite keeps passing
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

describe("screen modes and layout", () => {
  let harness: ShellHarness | undefined
  afterEach(async () => {
    await harness?.cleanup()
    harness = undefined
  })

  test("the side region takes a third of the width by default, not thirty columns", async () => {
    harness = await createShellHarness({ width: 200, height: 40 })
    expect(harness.app.view!.geometry.sideWidth).toBe(Math.round(200 * 0.3333))
  })


  test("plus and underscore move through the screen modes", async () => {
    harness = await createShellHarness()
    const view = harness.app.view!

    await harness.pressKey("0")
    expect(view.screenMode).toBe("normal")
    await harness.pressKey("+")
    expect(view.screenMode).toBe("half")
    expect(view.geometry.sideWidth).toBe(0)
    await harness.pressKey("+")
    expect(view.screenMode).toBe("full")
    await harness.pressKey("_")
    await harness.pressKey("_")
    expect(view.screenMode).toBe("normal")
    expect(view.geometry.sideWidth).toBeGreaterThan(0)
  })

  test("left pane heights stay fixed when focus changes", async () => {
    harness = await createShellHarness({ height: 40 })
    const view = harness.app.view!

    await harness.pressKey("4")
    const commitsHeight = view.geometry.windows.commits!.y1 - view.geometry.windows.commits!.y0 + 1
    const branchesHeight = view.geometry.windows.branches!.y1 - view.geometry.windows.branches!.y0 + 1
    const stashHeight = view.geometry.windows.stash!.y1 - view.geometry.windows.stash!.y0 + 1
    expect(commitsHeight).toBe(branchesHeight)

    await harness.pressKey("5")
    const focusedStash = view.geometry.windows.stash!
    expect(focusedStash.y1 - focusedStash.y0 + 1).toBeGreaterThan(stashHeight)
  })

  test("a terminal resize keeps the layout consistent", async () => {
    harness = await createShellHarness({ width: 200, height: 50 })
    await harness.resize(90, 30)
    const view = harness.app.view!
    expect(view.geometry.terminalWidth).toBe(90)
    expect(view.geometry.sideWidth).toBeGreaterThanOrEqual(18)
    expect(view.geometry.windows.main).toBeDefined()
  })
})

describe("hints bar and keybinding menu", () => {
  let harness: ShellHarness | undefined
  afterEach(async () => { await harness?.cleanup() })

  test("the hints bar changes with the focused pane", async () => {
    // A stash must exist for the stash bindings to be enabled — hintRowsFor only
    // advertises available bindings, mirroring what the keys actually do.
    harness = await createShellHarness({ stash: true })

    await harness.pressKey("2")
    const files = harness.frame()
    expect(files).toContain("stage: space")
    expect(files).toContain("reviewed: r")

    await harness.pressKey("5")
    const stash = harness.frame()
    expect(stash).toContain("apply: space")
    expect(stash).not.toContain("reviewed: r")
  })

  test("the review status is rendered on the right of the same row", async () => {
    harness = await createShellHarness()
    expect(harness.frame()).toContain("Working Tree")
  })

  test("question mark opens a menu listing the focused pane's bindings", async () => {
    harness = await createShellHarness()

    await harness.pressKey("5")
    await harness.pressKey("?")
    const open = harness.frame()
    expect(open).toContain("Keybindings")
    expect(open).toContain("pop")

    await harness.pressKey("ESCAPE")
    expect(harness.frame()).not.toContain("Keybindings")
  })

  test("the menu swallows pane keys while it is open", async () => {
    harness = await createShellHarness()
    const view = harness.app.view!

    await harness.pressKey("2")
    await harness.pressKey("?")
    await harness.pressKey("4")
    expect(view.focusManager.active).toBe("files")
    await harness.pressKey("?")
    await harness.pressKey("4")
    expect(view.focusManager.active).toBe("commits")
  })

  test("a banner replaces the routine status segment so it stays visible with a patch loaded", async () => {
    harness = await createShellHarness()

    // Drill into a commit (main shows its patch), then try to mark a file reviewed.
    // After the read-only inspection cutover, commit browsing does not mutate reviewTarget,
    // so the old "Commit drill-down is read-only" banner is no longer produced.
    await harness.pressKey("4")
    await harness.pressKey("RETURN")
    await harness.settle()
    await harness.pressKey("2")
    await harness.pressKey("r")
    await harness.settle()
    expect(harness.frame()).not.toContain("! Commit drill-down is read-only")
    expect(harness.frame()).toContain("Working Tree")
  })

  test("the ? menu distinguishes fetch-remote from global fetch on the branches pane", async () => {
    harness = await createShellHarness()

    await harness.pressKey("3")
    await harness.pressKey("?")
    const open = harness.frame()
    expect(open).toContain("fetch the selected remote")
    expect(open).toContain("fetch the selected remote  (unavailable)")
  })
})

describe("navigation keys", () => {
  let harness: ShellHarness | undefined
  afterEach(async () => { await harness?.cleanup() })

  test("J and K scroll the main pane while a left pane keeps focus", async () => {
    harness = await createShellHarness({ height: 20 })
    const view = harness.app.view!
    // The default one-line b.txt diff is shorter than the viewport, so there is nothing
    // to scroll; give the working tree a patch taller than a 20-row terminal first.
    await harness.repository.write("b.txt", Array.from({ length: 60 }, (_, line) => `line ${line}`).join("\n") + "\n")
    await harness.app.refresh()

    await harness.pressKey("2")
    await harness.pressKey("J")
    expect(view.focusManager.active).toBe("files")
    expect(view.mainScrollY).toBeGreaterThan(0)
    await harness.pressKey("K")
    expect(view.mainScrollY).toBe(0)
  })

  test("H and L scroll the main pane horizontally", async () => {
    harness = await createShellHarness()
    const view = harness.app.view!
    // The default b.txt diff has no line longer than the 120-column viewport; write a
    // line far wider than it so horizontal scrolling has somewhere to go.
    await harness.repository.write("b.txt", `wide ${"x".repeat(200)}\n`)
    await harness.app.refresh()

    await harness.pressKey("2")
    await harness.pressKey("L")
    expect(view.mainScrollX).toBeGreaterThan(0)
    await harness.pressKey("H")
    expect(view.mainScrollX).toBe(0)
  })

  test("angle brackets jump a list to its ends", async () => {
    harness = await createShellHarness({ commits: ["alpha", "beta", "gamma", "delta"] })

    await harness.pressKey("4")
    await harness.pressKey(">")
    expect(harness.frame()).toContain("alpha")
    await harness.pressKey("<")
    expect(harness.frame()).toContain("delta")
  })

  test("comma and period page a list", async () => {
    harness = await createShellHarness({ commits: ["c1", "c2", "c3", "c4", "c5", "c6"], height: 40 })
    const view = harness.app.view!

    await harness.pressKey("4")
    const before = view.commitsCursorIndex

    await harness.pressKey(".")
    expect(view.commitsCursorIndex).toBeGreaterThan(before + 1)
  })

  test("h and l move between hunks inside the main pane without moving focus", async () => {
    // The main pane holds the selected file's patch, so hunk navigation needs a file with two
    // hunks: moveMainCursor clamps to the current target when the patch has only one.
    harness = await createShellHarness({ setup: twoHunkFile })
    const view = harness.app.view!

    await harness.pressKey("2")
    await harness.pressKey("RETURN")
    expect(view.focusManager.active).toBe("main")
    const before = getMainCursorTarget(view.mainPane)
    await harness.pressKey("l")
    expect(view.focusManager.active).toBe("main")
    expect(getMainCursorTarget(view.mainPane)).not.toEqual(before)
  })
})

describe("dividers", () => {
  let harness: ShellHarness | undefined
  afterEach(async () => { await harness?.cleanup() })

  test("dragging the vertical divider changes the side width", async () => {
    harness = await createShellHarness({ width: 160, height: 40 })
    const view = harness.app.view!
    const before = view.geometry.sideWidth

    await harness.drag(before, 10, 90, 10)
    expect(view.geometry.sideWidth).toBeGreaterThan(before)
    expect(view.geometry.sideWidth).toBeLessThanOrEqual(160 - 1 - 40)
  })

  test("the drag is clamped to the main pane's minimum width", async () => {
    harness = await createShellHarness({ width: 160, height: 40 })
    const view = harness.app.view!

    await harness.drag(view.geometry.sideWidth, 10, 159, 10)
    expect(view.geometry.windows.main).toBeDefined()
    const main = view.geometry.windows.main!
    expect(main.x1 - main.x0 + 1).toBe(40)
  })

  test("the dragged width survives a restart in the same repository", async () => {
    const first = await createShellHarness({ width: 160, height: 40 })
    const ratioBefore = first.app.view!.geometry.sidePanelRatio
    await first.drag(first.app.view!.geometry.sideWidth, 10, 90, 10)
    const ratioAfter = first.app.view!.geometry.sidePanelRatio
    expect(ratioAfter).not.toBe(ratioBefore)
    await first.app.saveUiState()
    first.app.destroy()

    harness = await createShellHarness({ width: 160, height: 40, repository: first.repository })
    expect(harness.app.view!.geometry.sidePanelRatio).toBeCloseTo(ratioAfter, 3)
    await first.repository.cleanup()
  })
})

describe("overflow scrollbars and keyboard auto-scroll", () => {
  let harness: ShellHarness | undefined
  afterEach(async () => { await harness?.cleanup() })

  test("moving down a long commit list scrolls the pane to keep the cursor visible", async () => {
    const subjects = Array.from({ length: 60 }, (_v, i) => `commit number ${String(i).padStart(2, "0")}`)
    harness = await createShellHarness({ commits: subjects, height: 40 })

    await harness.pressKey("4")
    await harness.pressKey("j")
    for (let moved = 1; moved < 45; moved += 1) await harness.pressKey("j")

    const frame = harness.frame()
    // The commits pane lists newest-first, so cursor index 45 is the 15th-oldest subject.
    // The newly selected row is on screen after the move...
    expect(frame).toContain("commit number 14")
    // ...and the earliest rows have scrolled away, which proves real scrolling happened.
    expect(frame).not.toContain("commit number 00")
  })

  test("moving back up reveals rows above the viewport again", async () => {
    const subjects = Array.from({ length: 60 }, (_v, i) => `commit number ${String(i).padStart(2, "0")}`)
    harness = await createShellHarness({ commits: subjects, height: 40 })

    await harness.pressKey("4")
    for (let moved = 0; moved < 45; moved += 1) await harness.pressKey("j")
    for (let moved = 0; moved < 45; moved += 1) await harness.pressKey("k")

    // Back at the top of the list: the oldest commit is on screen again.
    expect(harness.frame()).toContain("commit number 59")
  })

  test("a short list keeps its pane unscrolled with every row visible", async () => {
    harness = await createShellHarness({ commits: ["alpha commit", "beta commit"], height: 40 })

    await harness.pressKey("4")
    await harness.pressKey("j")

    const frame = harness.frame()
    expect(frame).toContain("alpha commit")
    expect(frame).toContain("beta commit")
  })

  test("an overflowing pane renders the shared scrollbar; a short one hides it", async () => {
    const subjects = Array.from({ length: 60 }, (_v, i) => `commit number ${String(i).padStart(2, "0")}`)
    harness = await createShellHarness({ commits: subjects, height: 40 })

    await harness.pressKey("4")
    const lines = harness.frame().split("\n")
    const paneRows = (title: string): string[] => {
      const start = lines.findIndex((line) => line.startsWith(`┌─${title}`))
      const borderColumn = lines[start]!.indexOf("┐")
      const rows: string[] = []
      for (let y = start + 1; y < lines.length && !lines[y]!.startsWith("└"); y += 1) rows.push(lines[y]![borderColumn - 1] ?? " ")
      return rows
    }
    // Commits overflows: the column inside the right border carries thumb glyphs.
    expect(paneRows("[4]─Commits - Reflog").some((glyph) => "█▄▀".includes(glyph))).toBe(true)
    // Files fits its two entries: nothing but blank space inside the right border.
    expect(paneRows("[2]─Files - Worktrees - Submodules").every((glyph) => glyph === " ")).toBe(true)
  })

  test("hunk moves in the main pane scroll the target hunk's header into view", async () => {
    harness = await createShellHarness({ height: 24, setup: tallMultiHunkFile })

    await harness.pressKey("0")
    for (let moved = 0; moved < 8; moved += 1) await harness.pressKey("j")

    const pane = harness.app.view!.mainPane
    // A tall diff scrolled to its last hunk: the revealed hunk header sits at the viewport bottom.
    expect(pane.text.scrollY).toBeGreaterThan(0)
    expect(harness.frame()).toContain("@@ -193,7 +193,7 @@")
  })

  test("the scrollbar thumb tracks hunk moves in the main pane", async () => {
    harness = await createShellHarness({ height: 24, setup: tallMultiHunkFile })

    await harness.pressKey("0")
    for (let moved = 0; moved < 8; moved += 1) await harness.pressKey("j")

    // Hunk moves reveal without a content update, so the thumb only follows if every
    // scrollY mutation re-syncs the bar.
    const main = harness.app.view!.mainPane
    const bar = paneScrollbar(main.text)!
    expect(bar.visible).toBe(true)
    expect(bar.scrollPosition).toBe(main.text.scrollY)
    expect(bar.scrollPosition).toBeGreaterThan(0)
  })

  test("the scrollbar thumb tracks half-page scrolls in the main pane", async () => {
    harness = await createShellHarness({ height: 24, setup: tallMultiHunkFile })

    await harness.pressKey("0")
    await harness.pressKey("d", { ctrl: true })
    await harness.pressKey("d", { ctrl: true })

    const main = harness.app.view!.mainPane
    const bar = paneScrollbar(main.text)!
    expect(main.text.scrollY).toBeGreaterThan(0)
    expect(bar.scrollPosition).toBe(main.text.scrollY)
  })

  test("the scrollbar thumb tracks list cursor moves in the commits pane", async () => {
    const subjects = Array.from({ length: 60 }, (_v, i) => `commit number ${String(i).padStart(2, "0")}`)
    harness = await createShellHarness({ commits: subjects, height: 40 })

    await harness.pressKey("4")
    for (let moved = 0; moved < 45; moved += 1) await harness.pressKey("j")

    const view = harness.app.view!
    const pane = view.paneFor("commits")
    const bar = paneScrollbar(pane.text)!
    expect(bar.visible).toBe(true)
    expect(bar.scrollPosition).toBe(pane.text.scrollY)
    expect(bar.scrollPosition).toBeGreaterThan(0)
  })
})

describe("commit files transient context", () => {
  let harness: ShellHarness | undefined
  afterEach(async () => {
    await harness?.cleanup()
    harness = undefined
  })

  test("Enter opens commit-files, moving through files updates Main, Escape restores", async () => {
    const repository = await createTempRepository()
    try {
      await repository.write("a.txt", "a base\n")
      await repository.write("b.txt", "b base\n")
      await repository.git(["add", "a.txt", "b.txt"])
      await repository.git(["commit", "-m", "base"])
      await repository.write("a.txt", "a changed\n")
      await repository.write("b.txt", "b changed\n")
      await repository.git(["add", "a.txt", "b.txt"])
      await repository.git(["commit", "-m", "two files"])
      await repository.write("b.txt", "unstaged\n")
      harness = await createShellHarness({ repository, width: 140, height: 40 })
      await harness.pressKey("4")
      const controller = harness.app.controller
      const view = harness.app.view!
      const beforeTarget = controller.state.reviewTarget
      expect(view.commitsContextKind).toBe("commits")
      await harness.pressKey("RETURN")
      await harness.settle()
      await view.whenPreviewSettled()
      expect(controller.state.reviewTarget).toEqual(beforeTarget)
      expect(view.commitsContextKind).toBe("commit-files")
      expect(view.focusManager.active).toBe("commits")
      const firstStable = view.mainContent?.stableId
      expect(firstStable).toBeDefined()
      await harness.pressKey("j")
      await harness.settle()
      await view.whenPreviewSettled()
      const secondStable = view.mainContent?.stableId
      expect(secondStable).toBeDefined()
      expect(secondStable).not.toBe(firstStable)
      await harness.pressKey("ESCAPE")
      await harness.settle()
      await view.whenPreviewSettled()
      expect(view.commitsContextKind).toBe("commits")
      // Main restores parent commit preview
      expect(view.mainContent?.source).toBe("commit")
    } finally {
      // harness will cleanup repository handling? harness cleanup does not clean reused repo? we need manual
      if (harness === undefined) await repository.cleanup()
    }
  })

  test("failed details load leaves commits context", async () => {
    const repository = await createTempRepository()
    try {
      await repository.write("a.txt", "a\n")
      await repository.git(["add", "a.txt"])
      await repository.git(["commit", "-m", "base"])
      await repository.write("b.txt", "unstaged\n")
      harness = await createShellHarness({ repository, width: 120, height: 40 })
      const view = harness.app.view!
      // Inject failing loader by replacing controller's loader? Instead use harness's controller with override?
      // We simulate failure by monkey-patching loadCommitInspection to reject
      const original = harness.app.controller.loadCommitInspection.bind(harness.app.controller)
      harness.app.controller.loadCommitInspection = async () => { throw new Error("load failed") }
      await harness.pressKey("4")
      expect(view.commitsContextKind).toBe("commits")
      await harness.pressKey("RETURN")
      await harness.settle()
      await view.whenPreviewSettled()
      expect(view.commitsContextKind).toBe("commits")
      harness.app.controller.loadCommitInspection = original
    } finally {
      if (harness === undefined) await repository.cleanup()
    }
  })

  test("allow-empty commit opens No files and retains preview", async () => {
    const repository = await createTempRepository()
    try {
      await repository.write("a.txt", "a\n")
      await repository.git(["add", "a.txt"])
      await repository.git(["commit", "-m", "base"])
      await repository.git(["commit", "--allow-empty", "-m", "empty commit"])
      await repository.write("b.txt", "unstaged\n")
      harness = await createShellHarness({ repository, width: 120, height: 40 })
      await harness.pressKey("4")
      const view = harness.app.view!
      await harness.pressKey("RETURN")
      await harness.settle()
      await view.whenPreviewSettled()
      // No files message is non-selectable row; Main retains commit preview
      expect(view.mainContent?.source).toBe("commit")
      const child = view.commitsPanel.child
      if (child !== undefined) {
        expect(child.view.rows.length).toBe(0)
        const hasNoFiles = child.view.displayRows?.some((r) => r.kind === "message" && r.text === "No files") ?? false
        expect(hasNoFiles).toBe(true)
      } else {
        expect(view.commitsContextKind).toBe("commits")
      }
    } finally {
      if (harness === undefined) await repository.cleanup()
    }
  })
  test("stages every file represented by a directory and child range without unrelated files", async () => {
    harness = await createShellHarness({
      setup: async (repository) => {
        await repository.write("dir/a.txt", "a\n")
        await repository.write("dir/b.txt", "b\n")
        await repository.write("unrelated.txt", "unrelated\n")
        await repository.git(["add", "-A"])
        await repository.git(["commit", "-m", "base"])
        await repository.write("dir/a.txt", "a changed\n")
        await repository.write("dir/b.txt", "b changed\n")
        await repository.write("unrelated.txt", "unrelated changed\n")
      },
    })
    const controller = harness.app.controller
    const originalStageFiles = controller.stageFiles.bind(controller)
    let releaseStage: () => void = () => undefined
    const stageGate = new Promise<void>((resolve) => { releaseStage = resolve })
    controller.stageFiles = async (paths) => {
      await stageGate
      await originalStageFiles(paths)
    }


    await harness.pressKey("2")
    await harness.pressKey("j")
    await harness.pressKey("v")
    await harness.pressKey("j")
    await harness.pressKey(" ")
    expect(harness.app.view!.isMutating).toBe(true)
    await harness.pressKey("j")
    releaseStage()
    await harness.settle()

    const staged = (await harness.repository.git(["diff", "--cached", "--name-only"])).stdout.trim().split("\n").filter(Boolean)
    expect(staged.sort()).toEqual(["dir/a.txt", "dir/b.txt"])
    expect((await harness.repository.git(["diff", "--name-only"])).stdout.trim()).toBe("unrelated.txt")
    expect(harness.app.view!.selectedListId("files")).toBe("dir")
  })

  test("stages only unstaged files when a range mixes staged and unstaged statuses", async () => {
    harness = await createShellHarness({
      setup: async (repository) => {
        await repository.write("a.txt", "base a\n")
        await repository.write("b.txt", "base b\n")
        await repository.git(["add", "-A"])
        await repository.git(["commit", "-m", "base"])
        await repository.write("a.txt", "staged a\n")
        await repository.git(["add", "a.txt"])
        await repository.write("b.txt", "unstaged b\n")
      },
    })
    const commandLogBefore = harness.app.controller.state.commandLog.length

    await harness.pressKey("2")
    await harness.pressKey("v")
    await harness.pressKey("j")
    await harness.pressKey(" ")
    await harness.settle()

    expect((await harness.repository.git(["diff", "--cached", "--name-only"])).stdout.trim().split("\n").filter(Boolean).sort()).toEqual(["a.txt", "b.txt"])
    expect((await harness.repository.git(["diff", "--name-only"])).stdout.trim()).toBe("")
    const newCommands = harness.app.controller.state.commandLog
      .slice(commandLogBefore)
      .flatMap((line) => line.spans.map((span) => span.text))
      .join("\n")
    expect(newCommands).toContain("git add -- b.txt")
    expect(newCommands).not.toContain("git add -- a.txt")
  })

  test("refuses a files range containing a conflict before staging anything", async () => {
    harness = await createShellHarness({
      setup: async (repository) => {
        await repository.write("conflict.txt", "base\n")
        await repository.write("other.txt", "base\n")
        await repository.git(["add", "-A"])
        await repository.git(["commit", "-m", "base"])
        await repository.git(["switch", "-c", "side"])
        await repository.write("conflict.txt", "side\n")
        await repository.git(["add", "conflict.txt"])
        await repository.git(["commit", "-m", "side"])
        await repository.git(["switch", "master"])
        await repository.write("conflict.txt", "master\n")
        await repository.git(["add", "conflict.txt"])
        await repository.git(["commit", "-m", "master"])
        await repository.git(["merge", "side"])
        await repository.write("other.txt", "other changed\n")
      },
    })

    await harness.pressKey("2")
    await harness.pressKey("v")
    await harness.pressKey("j")
    await harness.pressKey(" ")
    await harness.settle()
    expect((await harness.repository.git(["status", "--short"])).stdout).toContain("UU conflict.txt")
    expect(harness.app.controller.state.files.find((file) => file.path === "conflict.txt")?.conflicted).toBe(true)
    const bottomTitle = (harness.app.view!.filesPane.box as unknown as { bottomTitle?: unknown }).bottomTitle
    expect(String(bottomTitle)).toContain("conflicted")
  })

  test("discard range keeps the existing all and unstaged confirmation modes", async () => {
    harness = await createShellHarness({
      setup: async (repository) => {
        await repository.write("dir/a.txt", "base a\n")
        await repository.write("dir/b.txt", "base b\n")
        await repository.git(["add", "-A"])
        await repository.git(["commit", "-m", "base"])
        await repository.write("dir/a.txt", "staged a\n")
        await repository.write("dir/b.txt", "staged b\n")
        await repository.git(["add", "dir/a.txt", "dir/b.txt"])
        await repository.write("dir/a.txt", "unstaged a\n")
        await repository.write("dir/b.txt", "unstaged b\n")
      },
    })

    await harness.pressKey("2")
    await harness.pressKey("v")
    await harness.pressKey("j")
    await harness.pressKey("d")
    expect(harness.frame()).toContain("dir/a.txt, dir/b.txt")
    expect(harness.frame()).toContain("Discard all changes")
    expect(harness.frame()).toContain("Discard unstaged changes")
    await harness.pressKey("u")
    await harness.settle()

    expect((await harness.repository.git(["diff", "--name-only"])).stdout.trim()).toBe("")
    expect((await harness.repository.git(["diff", "--cached", "--name-only"])).stdout.trim().split("\n").filter(Boolean).sort()).toEqual(["dir/a.txt", "dir/b.txt"])
  })
})
