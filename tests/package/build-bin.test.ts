import { describe, expect, test } from "bun:test"
import { compileTargetForHost } from "../../scripts/build-bin"

describe("compileTargetForHost", () => {
  test("uses the baseline runtime on linux x64 glibc", () => {
    expect(compileTargetForHost("linux", "x64", () => false)).toBe("bun-linux-x64-baseline")
  })

  test("uses the musl baseline runtime on linux x64 musl", () => {
    expect(compileTargetForHost("linux", "x64", () => true)).toBe("bun-linux-x64-musl-baseline")
  })

  test("keeps the host runtime on arm64", () => {
    expect(compileTargetForHost("linux", "arm64")).toBeNull()
    expect(compileTargetForHost("darwin", "arm64")).toBeNull()
  })

  test("uses the baseline runtime on darwin and windows x64", () => {
    expect(compileTargetForHost("darwin", "x64")).toBe("bun-darwin-x64-baseline")
    expect(compileTargetForHost("win32", "x64")).toBe("bun-windows-x64-baseline")
  })
})
