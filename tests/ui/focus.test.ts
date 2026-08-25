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

  test("shows the command log with @ and focuses it on a second @", () => {
    const focus = new FocusManager()
    expect(focus.active).toBe("main")
    expect(focus.logVisible).toBe(false)
    expect(focus.handleKey("@")).toBe(true)
    expect(focus.logVisible).toBe(true)
    expect(focus.active).toBe("main")
    expect(focus.handleKey("@")).toBe(true)
    expect(focus.active).toBe("command-log")
    expect(focus.handleKey("@")).toBe(true)
    expect(focus.logVisible).toBe(false)
    expect(focus.active).toBe("main")
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
