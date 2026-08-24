import { describe, expect, test } from "bun:test"
import { normalizeKey } from "../../src/ui/keymap"

describe("context-aware keymap", () => {
  test("normalizes physical uppercase names to lowercase plus Shift", () => {
    expect(normalizeKey({ name: "P" })).toMatchObject({ name: "p", shift: true })
    expect(normalizeKey({ name: "p", shift: true })).toMatchObject({ name: "p", shift: true })
  })
})
