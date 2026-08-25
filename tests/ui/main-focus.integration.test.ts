import { afterEach, describe, expect, test } from "bun:test"
import { createShellHarness, type ShellHarness } from "../helpers/shell-harness"
import { getMainDocument } from "../../src/ui/panes/main-pane"

/**
 * Panel 0 (`focusMainView`) is lazygit's `SwitchToFocusedMainViewController`: it clears the
 * search string and pushes `Contexts().Normal`, a `MainContext` that renders nothing on focus
 * (pkg/gui/context/main_context.go). Pushing a MAIN context keeps the side context underneath
 * on the stack (pkg/gui/context.go `pushToContextStack`), so Escape's `Pop()` returns to the
 * pane the main view was focused from.
 */
describe("panel 0 keeps the main pane's content", () => {
  let harness: ShellHarness | undefined

  afterEach(async () => {
    await harness?.cleanup()
    harness = undefined
  })

  test("focusing main from commits keeps the selected commit's diff", async () => {
    harness = await createShellHarness()
    const view = harness.app.view!

    await harness.pressKey("4")
    await harness.pressKey("j")
    await harness.settle()
    await view.whenPreviewSettled().catch(() => {})
    const selectedOid = view.commitsSelectedOid
    expect(selectedOid).toBeDefined()
    expect(view.mainContent?.source).toBe("commit")
    expect(view.mainContent?.stableId).toBe(selectedOid)

    await harness.pressKey("0")
    await harness.settle()
    await view.whenPreviewSettled().catch(() => {})

    expect(view.focusManager.active).toBe("main")
    // The commit diff survives the focus change — no snap back to the working-tree files diff.
    expect(view.mainContent?.source).toBe("commit")
    expect(view.mainContent?.stableId).toBe(selectedOid)
    expect(getMainDocument(view.mainPane)).toBeDefined()
  })

  test("focusing main from files still shows the working-tree files diff", async () => {
    harness = await createShellHarness()
    const view = harness.app.view!

    await harness.pressKey("4")
    await harness.settle()
    await view.whenPreviewSettled().catch(() => {})
    expect(view.mainContent?.source).toBe("commit")

    await harness.pressKey("2")
    await harness.settle()
    expect(view.mainContent?.source).toBe("files")

    await harness.pressKey("0")
    await harness.settle()
    expect(view.focusManager.active).toBe("main")
    expect(view.mainContent?.source).toBe("files")
  })

  test("escape from the focused main pane returns to the side pane it came from", async () => {
    harness = await createShellHarness()
    const view = harness.app.view!

    await harness.pressKey("4")
    await harness.settle()
    await harness.pressKey("0")
    await harness.settle()
    expect(view.focusManager.active).toBe("main")

    await harness.pressKey("ESCAPE")
    await harness.settle()
    expect(view.focusManager.active).toBe("commits")

    // …and the same from the files pane, which is the side context underneath at startup.
    await harness.pressKey("2")
    await harness.pressKey("0")
    await harness.settle()
    expect(view.focusManager.active).toBe("main")
    await harness.pressKey("ESCAPE")
    await harness.settle()
    expect(view.focusManager.active).toBe("files")
  })

  test("focusing main while a commit preview is in flight still lands that preview", async () => {
    harness = await createShellHarness()
    const view = harness.app.view!

    await harness.pressKey("4")
    await harness.settle()
    await view.whenPreviewSettled().catch(() => {})
    const firstOid = view.commitsSelectedOid

    // No settle between the two presses: the `j` preview request is (very likely) still
    // awaiting its git subprocess when `0` arrives, so this exercises the in-flight path.
    await harness.pressKey("j")
    await harness.pressKey("0")
    const secondOid = view.commitsSelectedOid
    expect(secondOid).not.toBe(firstOid)
    await harness.settle()
    await view.whenPreviewSettled().catch(() => {})

    expect(view.focusManager.active).toBe("main")
    expect(view.mainContent?.source).toBe("commit")
    expect(view.mainContent?.stableId).toBe(secondOid)
  })
})
