import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { parseReviewPatch } from "../../../src/review/git/patch-adapter"
import { sha256Tuple } from "../../../src/review/core/identity"

function fixture(name: string): string {
  return readFileSync(join(import.meta.dir, "../../fixtures/review", name), "utf8")
}

describe("parseReviewPatch Pierre boundary", () => {
  test("modified patch handles modified, added, deleted, mode-only, no-newline and multiple files", () => {
    const patch = fixture("modified.patch")
    const files = parseReviewPatch(patch)
    // Expect 5 files: src/foo.ts, new.txt, old.txt, mode.txt, nonewline.txt
    expect(files.length).toBe(5)

    const byPath = new Map(files.map((f) => [f.path, f]))

    const modified = byPath.get("src/foo.ts")!
    expect(modified).toBeDefined()
    expect(modified.hunks.length).toBe(1)
    expect(modified.hunks[0]!.oldStart).toBe(1)
    expect(modified.hunks[0]!.newStart).toBe(1)
    expect(modified.hunks[0]!.lines).toEqual([" line1", "-old line", "+new line", " line3"])
    expect(modified.isBinary).toBe(false)
    expect(modified.patchDigest).toBe(sha256Tuple([modified.patch]))
    expect(modified.normalizedHunkBody).toBe(modified.hunks.flatMap((h) => h.lines).join("\n") + "\n")

    const added = byPath.get("new.txt")!
    expect(added.hunks.length).toBe(1)
    expect(added.patch).toContain("new file mode")
    expect(added.isBinary).toBe(false)

    const deleted = byPath.get("old.txt")!
    expect(deleted.hunks.length).toBe(1)
    expect(deleted.patch).toContain("deleted file mode")

    const modeOnly = byPath.get("mode.txt")!
    // mode-only has no hunks but patch contains mode lines
    expect(modeOnly.hunks.length).toBe(0)
    expect(modeOnly.patch).toContain("old mode")
    expect(modeOnly.patch).toContain("new mode")

    const noNewline = byPath.get("nonewline.txt")!
    expect(noNewline.hunks.length).toBe(1)
    // The "\ No newline" marker should not appear in hunk lines
    for (const h of noNewline.hunks) {
      for (const line of h.lines) expect(line.startsWith("\\")).toBe(false)
    }
    expect(noNewline.isBinary).toBe(false)
  })

  test("rename patch handles pure rename, rename with edits, and copy", () => {
    const files = parseReviewPatch(fixture("rename.patch"))
    expect(files.length).toBe(3)
    const byPath = new Map(files.map((f) => [f.path, f]))

    const pure = byPath.get("newname.txt")!
    expect(pure.previousPath).toBe("oldname.txt")
    expect(pure.hunks.length).toBe(0)
    expect(pure.isBinary).toBe(false)

    const withEdits = byPath.get("new2.txt")!
    expect(withEdits.previousPath).toBe("old2.txt")
    expect(withEdits.hunks.length).toBe(1)
    expect(withEdits.hunks[0]!.lines).toContain("-old2")
    expect(withEdits.hunks[0]!.lines).toContain("+new2 changed")

    const copy = byPath.get("copy.txt")!
    expect(copy.previousPath).toBe("original.txt")
    expect(copy.hunks.length).toBe(0)
  })

  test("binary patch detected", () => {
    const files = parseReviewPatch(fixture("binary.patch"))
    expect(files.length).toBe(1)
    const f = files[0]!
    expect(f.path).toBe("image.png")
    expect(f.isBinary).toBe(true)
    expect(f.hunks.length).toBe(0)
    expect(f.patch).toContain("GIT binary patch")
    expect(f.patchDigest).toBe(sha256Tuple([f.patch]))
    expect(f.normalizedHunkBody).toBe("")
  })

  test("awkward path handles quoted, non-ASCII, and CRLF content with normalization", () => {
    const files = parseReviewPatch(fixture("awkward-path.patch"))
    expect(files.length).toBe(3)
    const byPath = new Map(files.map((f) => [f.path, f]))

    const space = byPath.get("space file.txt")!
    expect(space).toBeDefined()
    expect(space.path).toBe("space file.txt")
    expect(space.hunks[0]!.lines).toEqual(["-old", "+new"])

    const unicode = byPath.get("ünicode.txt")!
    expect(unicode).toBeDefined()
    expect(unicode.path).toBe("ünicode.txt")
    // CRLF normalization: lines should not contain \r
    for (const h of unicode.hunks) for (const line of h.lines) expect(line.includes("\r")).toBe(false)

    const crlf = byPath.get("crlf.txt")!
    expect(crlf.hunks[0]!.lines).toEqual([" line1", "-old crlf", "+new crlf"])
    for (const h of crlf.hunks) for (const line of h.lines) expect(line.includes("\r")).toBe(false)
    expect(crlf.patch.includes("\r")).toBe(false)
  })

  test("multiple files ordering is preserved", () => {
    const files = parseReviewPatch(fixture("modified.patch"))
    expect(files.map((f) => f.path)).toEqual(["src/foo.ts", "new.txt", "old.txt", "mode.txt", "nonewline.txt"])
  })

  test("patchDigest hashes normalized complete per-file patch", () => {
    const patch = `diff --git a/a.txt b/a.txt
index abc..def 100644
--- a/a.txt
+++ b/a.txt
@@ -1 +1 @@
-old
+new
`
    const files = parseReviewPatch(patch)
    expect(files[0]!.patchDigest).toBe(sha256Tuple([files[0]!.patch]))
    // Different line ending normalization should give same digest
    const crlfPatch = patch.replaceAll("\n", "\r\n")
    const files2 = parseReviewPatch(crlfPatch)
    expect(files2[0]!.patchDigest).toBe(files[0]!.patchDigest)
  })

  test("never leaks Pierre objects — only core hunks with digest", () => {
    const files = parseReviewPatch(fixture("modified.patch"))
    for (const f of files) {
      for (const h of f.hunks) {
        // Check hunk has digest and core fields, not Pierre's additionLines etc
        expect((h as unknown as { additionLines?: unknown }).additionLines).toBeUndefined()
        expect(typeof h.digest).toBe("string")
        expect(h.digest.length).toBe(64)
      }
    }
  })

  test("ANSI-colored patch still parses (terminal control stripped)", () => {
    const colored = `\u001b[31mdiff --git a/a.txt b/a.txt\u001b[0m
index abc..def 100644
--- a/a.txt
+++ b/a.txt
@@ -1 +1 @@
-old
+new
`
    const files = parseReviewPatch(colored)
    expect(files.length).toBe(1)
    expect(files[0]!.hunks.length).toBe(1)
  })
})
