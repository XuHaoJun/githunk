import { describe, expect, test } from "bun:test"
import type { TerminalCapabilities } from "@opentui/core"
import { shouldQueryTerminalPalette } from "../../src/main"

const capabilities = (multiplexer: TerminalCapabilities["multiplexer"]): Pick<TerminalCapabilities, "multiplexer"> => ({ multiplexer })

describe("startup terminal palette query", () => {
  test("never queries through zellij environment", () => {
    expect(shouldQueryTerminalPalette({ ZELLIJ: "0" }, undefined)).toBe(false)
    expect(shouldQueryTerminalPalette({ ZELLIJ_SESSION_NAME: "githunk" }, undefined)).toBe(false)
    expect(shouldQueryTerminalPalette({ TERM_PROGRAM: "zellij" }, undefined)).toBe(false)
  })

  test("never queries when OpenTUI identifies zellij", () => {
    expect(shouldQueryTerminalPalette({}, capabilities("zellij"))).toBe(false)
  })

  test("allows palette queries on a direct terminal", () => {
    expect(shouldQueryTerminalPalette({}, capabilities("none"))).toBe(true)
  })
})
