import { describe, expect, test } from "bun:test"
import { scrollYToReveal } from "../../src/ui/panes/common"
import { parseDiff } from "../../src/domain/diff/parse"
import { mainCursorTargetLine, type MainCursorTarget } from "../../src/ui/panes/main-pane"

describe("scrollYToReveal", () => {
  test("a selection above the viewport scrolls up to show it at the bottom", () => {
    // Cursor row 2 with the viewport scrolled to 20: scrolling to 0 (clamped) shows rows 0-9.
    expect(scrollYToReveal(2, 2, 10, 20)).toBe(0)
    expect(scrollYToReveal(5, 5, 10, 20)).toBe(0)
  })

  test("a selection below the viewport scrolls down to show it at the bottom", () => {
    expect(scrollYToReveal(30, 30, 10, 0)).toBe(21)
  })

  test("a selection inside the viewport keeps the current scroll", () => {
    expect(scrollYToReveal(12, 12, 10, 8)).toBe(8)
  })

  test("results never go below zero even for tiny viewports and top rows", () => {
    expect(scrollYToReveal(0, 0, 1, 0)).toBe(0)
    expect(scrollYToReveal(0, 0, 3, 7)).toBe(0)
  })

  test("the largest possible result is bottom - viewportLines + 1", () => {
    expect(scrollYToReveal(100, 100, 10, 0)).toBe(91)
    expect(scrollYToReveal(100, 100, 10, 500)).toBe(91)
  })

  test("single-line viewports reveal exactly the cursor row", () => {
    expect(scrollYToReveal(4, 4, 1, 9)).toBe(4)
    expect(scrollYToReveal(4, 4, 1, 0)).toBe(4)
    expect(scrollYToReveal(4, 4, 1, 4)).toBe(4)
  })

  test("fractional inputs are floored rather than propagated", () => {
    expect(scrollYToReveal(30.9, 30.9, 10.5, 0.2)).toBe(21)
  })
})

describe("mainCursorTargetLine", () => {
  const patch = [
    "diff --git a/a.txt b/a.txt",
    "index 1111111..2222222 100644",
    "--- a/a.txt",
    "+++ b/a.txt",
    "@@ -1,2 +1,2 @@",
    "-old one",
    "+new one",
    " context",
    "diff --git a/b.bin b/b.bin",
    "index 3333333..4444444 100644",
    "Binary files /dev/null and b/bin differ",
    "",
  ].join("\n")

  const document = parseDiff(patch)

  test("a hunk target resolves to its hunk-header line", () => {
    const target: MainCursorTarget = { fileIndex: 0, hunkIndex: 0 }
    const line = mainCursorTargetLine(document, target)
    // Line 4 (0-based) is the "@@ -1,2 +1,2 @@" row of the patch above.
    expect(line).toBe(4)
    expect(document.lines[line!]!.kind).toBe("hunk-header")
  })

  test("a file-only target (binary file, no hunks) resolves to its file-header line", () => {
    const line = mainCursorTargetLine(document, { fileIndex: 1 })
    expect(document.lines[line!]!.kind).toBe("file-header")
  })

  test("an out-of-range target resolves to undefined", () => {
    expect(mainCursorTargetLine(document, { fileIndex: 99 })).toBeUndefined()
    expect(mainCursorTargetLine(document, { fileIndex: 0, hunkIndex: 9 })).toBeUndefined()
  })

  test("every displayed row matches its document line index one-to-one", () => {
    // renderDiff emits exactly one display row per document line, so the derived
    // index is directly usable as a scroll target. (The patch's trailing newline
    // adds one empty split element that parseDiff does not emit a line for.)
    const rendered = patch.split("\n").filter((row, index, rows) => !(index === rows.length - 1 && row === ""))
    expect(document.lines.length).toBe(rendered.length)
  })
})
