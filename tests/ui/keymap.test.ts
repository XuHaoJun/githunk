import { describe, expect, test } from "bun:test"
import { CORE_KEYMAP, createKeymap, normalizeKey } from "../../src/ui/keymap"

describe("context-aware keymap", () => {
  test("normalizes physical uppercase names to lowercase plus Shift", () => {
    expect(normalizeKey({ name: "P" })).toMatchObject({ name: "p", shift: true })
    expect(normalizeKey({ name: "p", shift: true })).toMatchObject({ name: "p", shift: true })
  })

  test("detects collisions in a single context before dispatch", () => {
    expect(() => createKeymap({ global: [{ key: "x", action: "one" }, { key: "x", action: "two" }] })).toThrow(/collision/i)
    expect(() => createKeymap({ contexts: { files: [{ key: "shift+x", action: "one" }, { key: "X", action: "two" }] } })).toThrow(/files/)
  })

  test("modal bindings win over focused and global bindings", () => {
    const keymap = createKeymap({
      global: [{ key: "escape", action: "global" }],
      contexts: { files: [{ key: "escape", action: "pane" }] },
      modal: [{ key: "escape", action: "modal" }],
    })
    expect(keymap.dispatch({ name: "escape" }, { context: "files", modal: true })).toBe("modal")
    expect(keymap.dispatch({ name: "q" }, { context: "files", modal: true })).toBeUndefined()
    expect(keymap.dispatch({ name: "escape" }, { context: "files" })).toBe("pane")
    expect(keymap.dispatch({ name: "escape" })).toBe("global")
  })

  test("declares the core navigation and review shortcuts", () => {
    const keymap = createKeymap(CORE_KEYMAP)
    expect(keymap.dispatch({ name: "j" }, { context: "panes" })).toBe("next")
    expect(keymap.dispatch({ name: "P" })).toBe("push")
    expect(keymap.dispatch({ name: "o", ctrl: true })).toBe("copy-exact")
    expect(keymap.dispatch({ name: "c", ctrl: true })).toBe("quit")
  })
})
