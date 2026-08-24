import { describe, expect, test } from "bun:test"
import { normalizeKey } from "../../src/ui/keymap"

describe("context-aware keymap", () => {
  test("normalizes physical uppercase names to lowercase plus Shift", () => {
    expect(normalizeKey({ name: "P" })).toMatchObject({ name: "p", shift: true })
    expect(normalizeKey({ name: "p", shift: true })).toMatchObject({ name: "p", shift: true })
  })

  test("aliases OpenTUI's carriage-return name to githunk's canonical enter", () => {
    expect(normalizeKey({ name: "return" })).toMatchObject({ name: "enter" })
  })

  test("leaves an already-canonical enter alone", () => {
    expect(normalizeKey("enter")).toMatchObject({ name: "enter" })
  })

  test("does not alias linefeed, a distinct key from return", () => {
    expect(normalizeKey({ name: "linefeed" })).toMatchObject({ name: "linefeed" })
  })

  test("preserves modifiers on a return key across the rename", () => {
    expect(normalizeKey({ name: "return", ctrl: true })).toMatchObject({ name: "enter", ctrl: true })
  })
})
