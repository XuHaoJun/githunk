import { describe, expect, test } from "bun:test"
import { parseDiff } from "../../../src/domain/diff/parse"
import { buildPartialPatch } from "../../../src/domain/diff/transform"

function transformed(text: string, selectedRaw: readonly string[], options: { reverse?: boolean; wholeFile?: boolean; pathOverride?: string } = {}): string {
  const document = parseDiff(text)
  const indexes = document.lines.flatMap((line, index) => selectedRaw.includes(line.raw) ? [index] : [])
  return buildPartialPatch(document, indexes, {
    reverse: options.reverse ?? false,
    wholeFile: options.wholeFile ?? false,
    ...(options.pathOverride === undefined ? {} : { pathOverride: options.pathOverride }),
  })
}

describe("buildPartialPatch", () => {
  test("keeps selected additions and drops unselected additions", () => {
    const patch = "diff --git a/file.txt b/file.txt\n--- a/file.txt\n+++ b/file.txt\n@@ -1,1 +1,3 @@\n old\n+one\n+two\n"
    expect(transformed(patch, ["+one\n"])).toBe(
      "diff --git a/file.txt b/file.txt\n--- a/file.txt\n+++ b/file.txt\n@@ -1,1 +1,2 @@\n old\n+one\n",
    )
  })

  test("turns unselected deletions into context", () => {
    const patch = "diff --git a/file.txt b/file.txt\n--- a/file.txt\n+++ b/file.txt\n@@ -1,3 +1,1 @@\n-one\n-two\n keep\n"
    expect(transformed(patch, ["-one\n"])).toBe(
      "diff --git a/file.txt b/file.txt\n--- a/file.txt\n+++ b/file.txt\n@@ -1,3 +1,2 @@\n-one\n two\n keep\n",
    )
  })

  test("recalculates adjacent hunk offsets and preserves mixed ordering", () => {
    const patch = "diff --git a/file.txt b/file.txt\n--- a/file.txt\n+++ b/file.txt\n@@ -1,3 +1,3 @@\n-one\n+ONE\n same\n@@ -6,2 +6,3 @@\n-old\n+new\n tail\n"
    expect(transformed(patch, ["+ONE\n", "+new\n"])).toBe(
      "diff --git a/file.txt b/file.txt\n--- a/file.txt\n+++ b/file.txt\n@@ -1,2 +1,3 @@\n+ONE\n one\n same\n@@ -6,2 +7,3 @@\n+new\n old\n tail\n",
    )
  })

  test("reverse mode keeps selected additions and makes unselected additions context", () => {
    const patch = "diff --git a/file.txt b/file.txt\n--- a/file.txt\n+++ b/file.txt\n@@ -1,2 +1,3 @@\n old\n+one\n+two\n"
    expect(transformed(patch, ["+one\n"], { reverse: true })).toBe(
      "diff --git a/file.txt b/file.txt\n--- a/file.txt\n+++ b/file.txt\n@@ -1,2 +1,3 @@\n old\n+one\n two\n",
    )
  })

  test("whole file preserves metadata, CRLF, and no-newline marker", () => {
    const patch = "diff --git a/old name.txt b/new name.txt\r\nrename from old name.txt\r\nrename to new name.txt\r\n--- a/old name.txt\r\n+++ b/new name.txt\r\n@@ -1,1 +1,1 @@\r\n-old\r\n\\ No newline at end of file\r\n+new\r\n\\ No newline at end of file\r\n"
    expect(transformed(patch, [], { wholeFile: true })).toBe(patch)
  })

  test("partial rename strips rename metadata and applies path override", () => {
    const patch = "diff --git a/old.txt b/new.txt\nsimilarity index 90%\nrename from old.txt\nrename to new.txt\n--- a/old.txt\n+++ b/new.txt\n@@ -1,1 +1,1 @@\n-old\n+new\n"
    expect(transformed(patch, ["+new\n"], { pathOverride: "new.txt" })).toBe(
      "diff --git a/new.txt b/new.txt\n--- a/new.txt\n+++ b/new.txt\n@@ -1,1 +1,2 @@\n+new\n old\n",
    )
  })

  test("new and deleted files remain complete valid patches", () => {
    const added = "diff --git a/new.txt b/new.txt\nnew file mode 100644\n--- /dev/null\n+++ b/new.txt\n@@ -0,0 +1,2 @@\n+one\n+two\n"
    expect(transformed(added, ["+one\n"])).toBe(
      "diff --git a/new.txt b/new.txt\nnew file mode 100644\n--- /dev/null\n+++ b/new.txt\n@@ -0,0 +1 @@\n+one\n",
    )
    const deleted = "diff --git a/old.txt b/old.txt\ndeleted file mode 100644\n--- a/old.txt\n+++ /dev/null\n@@ -1,2 +1,0 @@\n-one\n-two\n"
    expect(transformed(deleted, ["-one\n"])).toBe(
      "diff --git a/old.txt b/old.txt\ndeleted file mode 100644\n--- a/old.txt\n+++ /dev/null\n@@ -1,2 +1 @@\n-one\n two\n",
    )
  })
})
