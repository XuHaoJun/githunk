import { afterEach, describe, expect, test } from "bun:test"
import { createShellHarness, type ShellHarness } from "../helpers/shell-harness"

/**
 * lazygit's `@` opens a menu (pkg/gui/keybindings.go:171-174 -> pkg/gui/extras_panel.go:12-38)
 * rather than toggling the command log directly. `tests/ui/focus.test.ts` and
 * `tests/ui/action-menu.test.ts` cover FocusManager and ActionMenuHandle as isolated units; this
 * drives real `@`, `t`, `f` and escape keypresses through RootView's own dispatch to prove the
 * wiring in src/ui/root-view.ts holds together: `modalInputActive()` gates every other key while
 * the menu is up, `handleModalKey()` routes into `ActionMenuHandle.handleKey()`, and the two
 * items reach `FocusManager` exactly as extras_panel.go's `OnPress` handlers do.
 */
describe("@ opens the command log menu", () => {
  let harness: ShellHarness | undefined

  afterEach(async () => {
    await harness?.cleanup()
    harness = undefined
  })

  test("@ opens a modal menu that swallows other keys", async () => {
    harness = await createShellHarness()
    const view = harness.app.view!
    expect(view.focusManager.logVisible).toBe(false)

    await harness.pressKey("@")
    await harness.flush()

    // The menu is modal: a numbered focus key that would normally move focus is swallowed by
    // handleModalKey instead of reaching handleAction's "focus-files" case.
    await harness.pressKey("2")
    await harness.flush()
    expect(view.focusManager.active).toBe("main")
    expect(view.focusManager.logVisible).toBe(false)
  })

  test("escape closes the menu without changing focus or visibility", async () => {
    harness = await createShellHarness()
    const view = harness.app.view!
    await harness.pressKey("@")
    await harness.flush()

    await harness.pressKey("ESCAPE")
    await harness.flush()
    expect(view.focusManager.logVisible).toBe(false)
    expect(view.focusManager.active).toBe("main")

    // The menu no longer intercepts keys once closed.
    await harness.pressKey("2")
    await harness.flush()
    expect(view.focusManager.active).toBe("files")
  })

  test("@ then t shows the log without focusing it (extras_panel.go's t item)", async () => {
    harness = await createShellHarness()
    const view = harness.app.view!
    await harness.pressKey("@")
    await harness.pressKey("t")
    await harness.flush()
    expect(view.focusManager.logVisible).toBe(true)
    expect(view.focusManager.active).toBe("main")
    expect(view.geometry.windows.log).not.toBeUndefined()
  })

  test("@ then t a second time hides it again", async () => {
    harness = await createShellHarness()
    const view = harness.app.view!
    await harness.pressKey("@")
    await harness.pressKey("t")
    await harness.flush()
    await harness.pressKey("@")
    await harness.pressKey("t")
    await harness.flush()
    expect(view.focusManager.logVisible).toBe(false)
    expect(view.geometry.windows.log).toBeUndefined()
  })

  test("@ then f shows and focuses the log even though it was hidden (extras_panel.go:40-46)", async () => {
    harness = await createShellHarness()
    const view = harness.app.view!
    await harness.pressKey("@")
    await harness.pressKey("f")
    await harness.flush()
    expect(view.focusManager.logVisible).toBe(true)
    expect(view.focusManager.active).toBe("command-log")
  })

  /**
   * extras_panel.go:20-23: "if the log is shown and focused, pop the context first" — hiding a
   * focused log must not leave focus pointing at a window that no longer exists.
   */
  test("@ then t pops focus back to the last side pane when the log was focused", async () => {
    harness = await createShellHarness()
    const view = harness.app.view!
    // Focus branches first so lastSide is deterministic, rather than relying on the default.
    await harness.pressKey("3")
    await harness.flush()
    expect(view.focusManager.lastSide).toBe("branches")

    await harness.pressKey("@")
    await harness.pressKey("f")
    await harness.flush()
    expect(view.focusManager.active).toBe("command-log")

    await harness.pressKey("@")
    await harness.pressKey("t")
    await harness.flush()
    expect(view.focusManager.logVisible).toBe(false)
    expect(view.focusManager.active).toBe("branches")
  })

  test("j/k move the selection inside the menu; the accelerator fires regardless of it", async () => {
    harness = await createShellHarness()
    const view = harness.app.view!
    await harness.pressKey("@")
    await harness.pressKey("j")
    await harness.flush()
    // Still open: j only moved the cursor, it is not one of the menu's own accelerators.
    await harness.pressKey("2")
    await harness.flush()
    expect(view.focusManager.active).toBe("main")

    // f fires from wherever the cursor is, the same as lazygit's MenuItem.Keys.
    await harness.pressKey("f")
    await harness.flush()
    expect(view.focusManager.logVisible).toBe(true)
    expect(view.focusManager.active).toBe("command-log")
  })
})
