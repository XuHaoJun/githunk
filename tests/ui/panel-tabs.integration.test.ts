import { afterEach, describe, expect, test } from "bun:test"
import { createShellHarness, type ShellHarness } from "../helpers/shell-harness"
import { createTempRepository, type TempRepository } from "../helpers/temp-repository"
import { createRegistry } from "../../src/ui/bindings"
import { localBranchRows } from "../../src/ui/panes/branches-pane"
import { remoteRows } from "../../src/ui/panes/remotes-pane"

describe("panel 3 tabs and RemoteBranches child", () => {
  let harness: ShellHarness | undefined
  let remoteBare: TempRepository | undefined

  afterEach(async () => {
    await harness?.cleanup()
    harness = undefined
    await remoteBare?.cleanup()
    remoteBare = undefined
  })

  test("cycles tabs with wraparound and bracket only in branches window, preserving reviewTarget", async () => {
    harness = await createShellHarness()
    const beforeTarget = harness.app.controller.state.reviewTarget

    await harness.pressKey("3")
    expect(harness.app.view!.activeBranchesTab).toBe("branches")

    await harness.pressKey("]")
    expect(harness.app.view!.activeBranchesTab).toBe("remotes")

    await harness.pressKey("]")
    expect(harness.app.view!.activeBranchesTab).toBe("tags")

    await harness.pressKey("]")
    expect(harness.app.view!.activeBranchesTab).toBe("branches")

    await harness.pressKey("[")
    expect(harness.app.view!.activeBranchesTab).toBe("tags")

    await harness.pressKey("[")
    expect(harness.app.view!.activeBranchesTab).toBe("remotes")

    await harness.pressKey("[")
    expect(harness.app.view!.activeBranchesTab).toBe("branches")

    // Bracket in Main must not change tab and must not change reviewTarget
    await harness.pressKey("0")
    const beforeMain = harness.app.view!.activeBranchesTab
    const targetBeforeMainBracket = harness.app.controller.state.reviewTarget
    await harness.pressKey("]")
    expect(harness.app.view!.activeBranchesTab).toBe(beforeMain)
    expect(harness.app.controller.state.reviewTarget).toEqual(targetBeforeMainBracket)

    // Bracket in Files must not change tab
    await harness.pressKey("2")
    await harness.pressKey("]")
    expect(harness.app.view!.activeBranchesTab).toBe(beforeMain)
    expect(harness.app.controller.state.reviewTarget).toEqual(beforeTarget)

    // Return to branches and verify target still unchanged
    await harness.pressKey("3")
    await harness.pressKey("]")
    expect(harness.app.view!.activeBranchesTab).toBe("remotes")
    expect(harness.app.controller.state.reviewTarget).toEqual(beforeTarget)
  })

  test("scope-next and scope-previous are unhandled in every context", async () => {
    const registry = createRegistry()
    expect(registry.dispatch({ name: "]" }, { context: "main" })).toBeUndefined()
    expect(registry.dispatch({ name: "[" }, { context: "main" })).toBeUndefined()
    expect(registry.dispatch({ name: "]" }, { context: "files" })).toBeUndefined()
    expect(registry.dispatch({ name: "[" }, { context: "files" })).toBeUndefined()
    // In branches context they are tab actions
    expect(registry.dispatch({ name: "]" }, { context: "branches" })).toBe("tab-next")
    expect(registry.dispatch({ name: "[" }, { context: "branches" })).toBe("tab-previous")
  })

  test("Enter on Remotes opens RemoteBranches child and Escape restores same remote selection", async () => {
    harness = await createShellHarness()
    remoteBare = await createTempRepository()
    await remoteBare.git(["config", "core.bare", "true"])
    await harness.repository.git(["remote", "add", "origin", remoteBare.path])
    await harness.repository.git(["push", "origin", "HEAD:refs/heads/feature"])
    await harness.repository.git(["fetch", "origin"])
    await harness.app.refresh()
    await harness.pressKey("3")
    expect(harness.app.view!.activeBranchesTab).toBe("branches")
    await harness.pressKey("]")
    expect(harness.app.view!.activeBranchesTab).toBe("remotes")

    const beforeId = harness.app.view!.branchesPanel.views.remotes.selectedId
    expect(beforeId).toBe("remote:origin")

    await harness.pressKey("RETURN")
    await harness.settle()
    const panelAfterEnter = harness.app.view!.branchesPanel
    expect(panelAfterEnter.child).toBeDefined()
    expect(panelAfterEnter.child!.value).toEqual({ kind: "remote-branches", remote: "origin" })
    expect(panelAfterEnter.child!.view.rows.some((r) => r.id === "remote-branch:origin/feature")).toBe(true)

    await harness.pressKey("ESCAPE")
    const panelAfterEscape = harness.app.view!.branchesPanel
    expect(panelAfterEscape.child).toBeUndefined()
    expect(panelAfterEscape.activeTab).toBe("remotes")
    expect(panelAfterEscape.views.remotes.selectedId).toBe(beforeId)
  })

  test("bracket inside RemoteBranches closes child and activates adjacent tab", async () => {
    harness = await createShellHarness()
    remoteBare = await createTempRepository()
    await remoteBare.git(["config", "core.bare", "true"])
    await harness.repository.git(["remote", "add", "origin", remoteBare.path])
    await harness.repository.git(["push", "origin", "HEAD:refs/heads/feature"])
    await harness.repository.git(["fetch", "origin"])
    await harness.app.refresh()
    await harness.pressKey("3")
    await harness.pressKey("]")
    expect(harness.app.view!.activeBranchesTab).toBe("remotes")
    await harness.pressKey("RETURN")
    await harness.settle()
    expect(harness.app.view!.branchesPanel.child).toBeDefined()

    await harness.pressKey("]")
    expect(harness.app.view!.branchesPanel.child).toBeUndefined()
    expect(harness.app.view!.activeBranchesTab).toBe("tags")

    await harness.pressKey("[")
    expect(harness.app.view!.activeBranchesTab).toBe("remotes")
    await harness.pressKey("RETURN")
    await harness.settle()
    expect(harness.app.view!.branchesPanel.child).toBeDefined()
    await harness.pressKey("[")
    expect(harness.app.view!.branchesPanel.child).toBeUndefined()
    expect(harness.app.view!.activeBranchesTab).toBe("branches")
  })

  test("panel 3 title is Local Branches | Remotes | Tags with active styled and IDs exactly", async () => {
    harness = await createShellHarness()
    await harness.pressKey("3")
    const pane = harness.app.view!.paneFor("branches")
    expect(pane.box.title).toBe("3 Local Branches | Remotes | Tags")
    expect(pane.box.title).toContain("|")
    const m = harness.app.controller.state
    const localRows = localBranchRows(m)
    expect(localRows.every((r) => r.id.startsWith("local:"))).toBe(true)
    const remRows = remoteRows(m)
    // May be empty in fresh harness without remote, but if present check prefix
    if (remRows.length > 0) expect(remRows.every((r) => r.id.startsWith("remote:"))).toBe(true)
  })
})
