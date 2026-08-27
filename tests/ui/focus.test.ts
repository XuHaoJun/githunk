import { describe, expect, test } from "bun:test"
import { FocusManager, FOCUS_IDS, focusIdForKey } from "../../src/ui/focus"

describe("focus navigation", () => {
  test("maps numbered keys to Main and left panes", () => {
    expect(FOCUS_IDS).toEqual(["main", "status", "files", "branches", "commits", "stash"])
    expect(focusIdForKey("0")).toBe("main")
    expect(focusIdForKey("1")).toBe("status")
    expect(focusIdForKey("5")).toBe("stash")
    expect(focusIdForKey("9")).toBeUndefined()
  })

  /**
   * lazygit's `@` opens a menu (pkg/gui/keybindings.go:171-174 ->
   * pkg/gui/extras_panel.go:12-38); it never toggles directly. FocusManager therefore knows nothing
   * about `@` any more — RootView owns the menu.
   */
  test("FocusManager does not handle @", () => {
    const manager = new FocusManager()
    expect(manager.handleKey("@")).toBe(false)
    expect(manager.logVisible).toBe(false)
    expect(manager.active).toBe("main")
  })

  test("still handles the numbered focus keys", () => {
    const manager = new FocusManager()
    expect(manager.handleKey("2")).toBe(true)
    expect(manager.active).toBe("files")
  })

  /** `handleFocusCommandLog` forces the window visible before focusing (extras_panel.go:40-46). */
  test("focusing the command log requires it to be visible", () => {
    const manager = new FocusManager()
    manager.focus("command-log")
    expect(manager.active).toBe("main")
    manager.logVisible = true
    manager.focus("command-log")
    expect(manager.active).toBe("command-log")
  })

  /**
   * `setLogVisible` is the visibility half of what the old direct `@` cycle did in one
   * `handleKey` call — it must still fire `onChange` the way `focus()` does, so RootView's
   * cascade (re-arming the command log, closing the filter, etc.) runs on a visibility change
   * even when `active` does not move.
   */
  test("setLogVisible fires onChange like focus() does", () => {
    const manager = new FocusManager()
    let calls = 0
    manager.onChange = () => { calls += 1 }
    manager.setLogVisible(true)
    expect(manager.logVisible).toBe(true)
    expect(manager.active).toBe("main")
    expect(calls).toBe(1)
    manager.setLogVisible(false)
    expect(manager.logVisible).toBe(false)
    expect(calls).toBe(2)
  })

  test("0 returns to Main without recreating focus state", () => {
    const focus = new FocusManager()
    focus.focus("files")
    expect(focus.handleKey("0")).toBe(true)
    expect(focus.active).toBe("main")
  })

  test("tracks lastSide and updates before onChange", () => {
    const focus = new FocusManager()
    expect(focus.lastSide).toBe("files")
    focus.focus("branches")
    expect(focus.lastSide).toBe("branches")
    focus.focus("main")
    expect(focus.lastSide).toBe("branches")
    let seenLast: string | undefined
    focus.onChange = () => { seenLast = focus.lastSide }
    focus.focus("stash")
    expect(seenLast).toBe("stash")
  })

  test("lastSide does not change when focusing main or command-log", () => {
    const focus = new FocusManager()
    focus.focus("commits")
    expect(focus.lastSide).toBe("commits")
    focus.focus("main")
    expect(focus.lastSide).toBe("commits")
    focus.logVisible = true
    focus.focus("command-log")
    expect(focus.lastSide).toBe("commits")
  })
})
