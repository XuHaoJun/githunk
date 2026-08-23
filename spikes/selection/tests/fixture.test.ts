import { describe, expect, test } from "bun:test"
import {
  LEFT_FIXTURE,
  PATCH_FIXTURE,
  PATCH_SENTINELS,
} from "../src/fixtures/patch"

describe("selection spike fixtures", () => {
  test("left fixture is dense enough to expose row contamination", () => {
    expect(LEFT_FIXTURE.length).toBeGreaterThanOrEqual(40)
    expect(LEFT_FIXTURE.some((line) => line.includes("中文"))).toBe(true)
    expect(LEFT_FIXTURE.some((line) => line.includes("🚀"))).toBe(true)
  })

  test("patch fixture contains every hostile selection case", () => {
    expect(PATCH_FIXTURE).toContain("@@ -120,8 +120,14 @@")
    expect(PATCH_FIXTURE).toContain("中文審查")
    expect(PATCH_FIXTURE).toContain("🚀")
    expect(PATCH_FIXTURE).toContain("\t")
    expect(PATCH_FIXTURE).toContain("e\u0301")
    expect(PATCH_FIXTURE).toContain("const intentionallyLongLine")
    for (const sentinel of PATCH_SENTINELS) {
      expect(PATCH_FIXTURE).toContain(sentinel)
      expect(LEFT_FIXTURE.join("\n")).not.toContain(sentinel)
    }
  })
})
