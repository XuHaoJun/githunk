import { describe, expect, test } from "bun:test"
import { loadHighlightForPatch } from "../../../src/review/git/highlight/highlight-adapter"
describe("highlight-adapter", () => {
  test("highlights a TS patch and returns token spans without leaking Pierre types", async () => {
    const patch = `diff --git a/foo.ts b/foo.ts
index 111..222 100644
--- a/foo.ts
+++ b/foo.ts
@@ -1,1 +1,1 @@
-const x: number = 1
+const y: string = "hi"
`
    const payload = await loadHighlightForPatch(patch, "foo.ts", "dark")
    expect(payload).not.toBeNull()
    expect(payload!.additionLines.length).toBeGreaterThan(0)
    const hasFg = payload!.additionLines.some((line) => line !== null && line.some((t) => t.fg !== undefined))
    expect(hasFg).toBe(true)
    expect(JSON.stringify(payload)).not.toContain("HastNode")
  })

  test("returns null for binary patch", async () => {
    const patch = "Binary files a/foo.png and b/foo.png differ\n"
    expect(await loadHighlightForPatch(patch, "foo.png")).toBeNull()
  })

  test("returns null for empty patch", async () => {
    expect(await loadHighlightForPatch("", "empty.txt")).toBeNull()
  })

  test("handles large diff guard - skips highlight when too many lines", async () => {
    // MAX 10k lines; generate patch with 10_001 additions
    const largePatch = `diff --git a/big.ts b/big.ts
--- a/big.ts
+++ b/big.ts
@@ -1,0 +1,10001 @@
${Array.from({ length: 10001 }, (_, i) => `+const a${i} = ${i}`).join("\n")}
`
    const payload = await loadHighlightForPatch(largePatch, "big.ts", "dark")
    expect(payload).toBeNull()
  })
})
