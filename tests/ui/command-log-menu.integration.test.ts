import { afterEach, describe, expect, test } from "bun:test"
import { createShellHarness, type ShellHarness } from "../helpers/shell-harness"
import type { UiState as PersistedUiState } from "../../src/ui/ui-state-store"

/**
 * lazygit's `@` opens a menu (pkg/gui/keybindings.go:171-174 -> pkg/gui/extras_panel.go:12-38)
 * rather than toggling the command log directly. `tests/ui/focus.test.ts` and
 * `tests/ui/action-menu.test.ts` cover FocusManager and ActionMenuHandle as isolated units; this
 * drives real `@`, `t`, `f` and escape keypresses through RootView's own dispatch to prove the
 * wiring in src/ui/root-view.ts holds together: `modalInputActive()` gates every other key while
 * the menu is up, `handleModalKey()` routes into `ActionMenuHandle.handleKey()`, and the two
 * items reach `FocusManager` exactly as extras_panel.go's `OnPress` handlers do.
 *
 * Every harness below states `logVisible: false` explicitly: these tests are about the show/hide
 * transition itself (Task 10 made the log start shown by default, `Gui.ShowCommandLog: true`,
 * pkg/config/user_config.go:901), so their toggles need a known starting state rather than one
 * that silently flips meaning if the default changes again.
 */
describe("@ opens the command log menu", () => {
  let harness: ShellHarness | undefined

  afterEach(async () => {
    await harness?.cleanup()
    harness = undefined
  })

  test("@ opens a modal menu that swallows other keys", async () => {
    harness = await createShellHarness({ logVisible: false })
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
    harness = await createShellHarness({ logVisible: false })
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
    harness = await createShellHarness({ logVisible: false })
    const view = harness.app.view!
    await harness.pressKey("@")
    await harness.pressKey("t")
    await harness.flush()
    expect(view.focusManager.logVisible).toBe(true)
    expect(view.focusManager.active).toBe("main")
    expect(view.geometry.windows.log).not.toBeUndefined()
  })

  test("@ then t a second time hides it again", async () => {
    harness = await createShellHarness({ logVisible: false })
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
    harness = await createShellHarness({ logVisible: false })
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
    harness = await createShellHarness({ logVisible: false })
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
    harness = await createShellHarness({ logVisible: false })
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

  /**
   * `t`'s `OnPress` (extras_panel.go:19-29) assigns `gui.c.GetAppState().HideCommandLog = !show`
   * and calls `SaveAppStateAndLogError()` — the persisted choice a later launch reads back.
   * `RootView.onGeometryChange` (root-view.ts:113) is githunk's equivalent write path;
   * `create-app.ts` forwards every call to `UiStateStore.save`, and now also to a caller-supplied
   * observer so a test can see exactly what would have been persisted.
   */
  test("@ then t persists the new visibility (extras_panel.go:24-27's SaveAppStateAndLogError)", async () => {
    const geometryChanges: PersistedUiState[] = []
    harness = await createShellHarness({ logVisible: false, onGeometryChange: (state) => geometryChanges.push(state) })
    const view = harness.app.view!
    expect(view.focusManager.logVisible).toBe(false)
    expect(geometryChanges).toHaveLength(0)

    await harness.pressKey("@")
    await harness.pressKey("t")
    await harness.flush()

    expect(view.focusManager.logVisible).toBe(true)
    expect(geometryChanges.length).toBeGreaterThan(0)
    expect(geometryChanges.at(-1)?.commandLogVisible).toBe(true)
  })

  /**
   * `handleFocusCommandLog` (extras_panel.go:40-46), which `f`'s `OnPress` is, never assigns
   * `HideCommandLog` and never calls `SaveAppStateAndLogError()` — unlike `t`'s `OnPress`
   * (:24-27). So `f` must show and focus the log for this session without writing anything to
   * persisted UI state; the next launch should still read back whatever `t` last chose. Before the
   * fix, `f`'s `onPress` called `this.notifyGeometry()` after `setLogVisible(true)`, which would
   * have made this test fail with `geometryChanges` non-empty and `commandLogVisible: true`.
   */
  test("@ then f shows and focuses the log WITHOUT persisting it (extras_panel.go:40-46 has no SaveAppStateAndLogError)", async () => {
    const geometryChanges: PersistedUiState[] = []
    harness = await createShellHarness({ logVisible: false, onGeometryChange: (state) => geometryChanges.push(state) })
    const view = harness.app.view!

    await harness.pressKey("@")
    await harness.pressKey("f")
    await harness.flush()

    expect(view.focusManager.logVisible).toBe(true)
    expect(view.focusManager.active).toBe("command-log")
    expect(geometryChanges).toHaveLength(0)
  })
})
