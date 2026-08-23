import { describe, expect, test } from "bun:test"
import { parseDiff } from "../../../src/domain/diff/parse"
import { renderDiff } from "../../../src/domain/diff/render"

const fixture = [
  "diff --git a/space name.ts b/space name.ts\n",
  "similarity index 90%\n",
  "rename from space name.ts\n",
  "rename to space name.ts\n",
  "index 1111111..2222222 100644\n",
  "--- a/space name.ts\n",
  "+++ b/space name.ts\n",
  "@@ -1,3 +1,4 @@ function hello()\n",
  " const greeting = \"世界🙂\";\r\n",
  "-\told value\r\n",
  "+\tnew value\r\n",
  "+decomposed e\u0301 and wide 界\r\n",
  "\\ No newline at end of file\r\n",
  "@@ -9,2 +10,2 @@\n",
  " context with a very long wrapping line that remains exact\r\n",
  "-removed\r\n",
  "diff --git a/new file.txt b/new file.txt\n",
  "new file mode 100644\n",
  "--- /dev/null\n",
  "+++ b/new file.txt\n",
  "@@ -0,0 +1,2 @@\n",
  "+CJK 界\n",
  "+emoji 🚀\n",
  "diff --git a/deleted.bin b/deleted.bin\n",
  "deleted file mode 100644\n",
  "Binary files a/deleted.bin and /dev/null differ\n",
].join("")

describe("parseDiff hostile unified diff", () => {
  test("indexes exact UTF-16 offsets, files, hunks, metadata, and line numbers", () => {
    const document = parseDiff(fixture)
    expect(document.text).toBe(fixture)
    expect(document.files).toHaveLength(3)
    expect(document.files[0]?.hunks).toHaveLength(2)
    expect(document.files[1]?.hunks).toHaveLength(1)
    expect(document.lines.some((line) => line.kind === "metadata" && line.raw.includes("rename from"))).toBe(true)
    expect(document.lines.some((line) => line.kind === "no-newline")).toBe(true)
    expect(document.lines.some((line) => line.kind === "addition" && line.raw.includes("🚀"))).toBe(true)
    for (const line of document.lines) {
      expect(document.text.slice(line.startUtf16, line.endUtf16)).toBe(line.raw)
    }
    const addition = document.lines.find((line) => line.raw.includes("new value"))
    expect(addition).toMatchObject({ kind: "addition", newLine: 2 })
    expect(document.files[0]?.oldPath).toBe("space name.ts")
  })
  test("treats marker-looking hunk content as changes, not file headers", () => {
    const document = parseDiff("diff --git a/markers b/markers\n--- a/markers\n+++ b/markers\n@@ -1,2 +1,2 @@\n--- deleted marker\n+++ added marker\n")
    const deletion = document.lines.find((line) => line.raw === "--- deleted marker\n")
    const addition = document.lines.find((line) => line.raw === "+++ added marker\n")
    expect(deletion).toMatchObject({ kind: "deletion", oldLine: 1 })
    expect(addition).toMatchObject({ kind: "addition", newLine: 1 })
    expect(document.files[0]?.oldPath).toBe("markers")
    expect(document.files[0]?.newPath).toBe("markers")
  })
  test("parses quoted ambiguous old paths and unquoted new paths containing b/", () => {
    const quoted = parseDiff("diff --git \"a/dir b/old.bin\" \"b/dir b/old.bin\"\nBinary files a/dir b/old.bin and b/dir b/old.bin differ\n")
    expect(quoted.files[0]?.oldPath).toBe("dir b/old.bin")
    expect(quoted.files[0]?.newPath).toBe("dir b/old.bin")
    const unquoted = parseDiff("diff --git a/old.bin b/dir b/new.bin\nBinary files a/old.bin and b/dir b/new.bin differ\n")
    expect(unquoted.files[0]?.oldPath).toBe("old.bin")
    expect(unquoted.files[0]?.newPath).toBe("dir b/new.bin")
    expect(unquoted.files[0]?.hunks).toHaveLength(0)
  })

  test("render keeps source text selectable while exposing explicit display map", () => {
    const document = parseDiff(fixture)
    const rendered = renderDiff(document)
    expect(rendered.styledText.chunks.length).toBeGreaterThan(3)
    expect(rendered.displayText).toContain("new value")
    expect(rendered.displayText).not.toBe(document.text)
    expect(rendered.displayToRaw.length).toBeGreaterThan(0)
  })
})
