import { describe, expect, test } from "bun:test"
import { getEffectiveHighlightAppearance, syntaxThemeForAppearance, syntaxHighlightThemeName } from "../../../src/ui/review-workspace/syntax-theme"

describe("syntax theme", () => {
  test("uses Hunk default syntax themes", () => {
    expect(syntaxThemeForAppearance("dark")).toBe("github-dark-default")
    expect(syntaxThemeForAppearance("light")).toBe("github-light-default")
    expect(syntaxHighlightThemeName("dark")).toBe("github-dark-default")
  })

  test("effective appearance defaults to dark and respects env", () => {
    const orig = process.env["GH_LIGHT_BG"]
    delete process.env["GH_LIGHT_BG"]
    expect(getEffectiveHighlightAppearance()).toBe("dark")
    process.env["GH_LIGHT_BG"] = "light"
    expect(getEffectiveHighlightAppearance()).toBe("light")
    if (orig === undefined) delete process.env["GH_LIGHT_BG"]
    else process.env["GH_LIGHT_BG"] = orig
  })

  test("highlight payload byte length bounded for large diff (guard)", async () => {
    const { loadHighlightForPatch } = await import("../../../src/review/git/highlight/highlight-adapter")
    const largePatch = `diff --git a/big.ts b/big.ts\n--- a/big.ts\n+++ b/big.ts\n@@ -1,0 +1,10001 @@\n${Array.from({ length: 10001 }, (_, i) => `+const a${i} = ${i}`).join("\n")}\n`
    const payload = await loadHighlightForPatch(largePatch, "big.ts", "dark")
    expect(payload).toBeNull()
  })
})
