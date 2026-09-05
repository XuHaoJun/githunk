import { describe, expect, test } from "bun:test"
import { parseCliArgs } from "../../src/cli/args"

describe("parseCliArgs update", () => {
  test("parses a bare update command", () => {
    expect(parseCliArgs(["update"])).toEqual({ kind: "update", check: false })
  })

  test("takes an explicit version", () => {
    expect(parseCliArgs(["update", "0.3.0"])).toEqual({ kind: "update", version: "0.3.0", check: false })
  })

  test("parses --check without downloading", () => {
    expect(parseCliArgs(["update", "--check"])).toEqual({ kind: "update", check: true })
  })

  test("combines an explicit version with --check", () => {
    expect(parseCliArgs(["update", "0.3.0", "--check"])).toEqual({
      kind: "update",
      version: "0.3.0",
      check: true,
    })
  })
})
