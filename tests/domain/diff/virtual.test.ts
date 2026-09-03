import { describe, expect, test } from "bun:test"
import { parseDiff } from "../../../src/domain/diff/parse"
import { createVirtualDiffLayout } from "../../../src/domain/diff/virtual"

const diff = "diff --git a/a.txt b/a.txt\n@@ -1 +1 @@\n-old\n+new 🙂\n"

describe("virtual diff layout", () => {
  test("lays out preamble and exact diff rows", () => {
    const document = parseDiff(diff)
    const layout = createVirtualDiffLayout(document, "commit message\n")

    expect(layout.preambleRows).toBe(1)
    expect(layout.totalRows).toBe(5)
    expect(layout.rowAt(0)?.text).toBe("commit message")
    expect(layout.rowAt(1)?.text).toBe("diff --git a/a.txt b/a.txt")
    expect(layout.rowAt(1)?.style).toBe("plain")
    expect(layout.rowAt(2)?.style).toBe("hunk-header")
    expect(layout.rowAt(3)?.style).toBe("deletion")
    expect(layout.rowAt(4)?.style).toBe("addition")
    expect(layout.rowAt(3)?.gutterCols).toBe(4)
    expect(layout.rowAt(3)?.rawStartUtf16).toBe(document.lines[2]?.startUtf16)
    expect(layout.rowAt(3)?.rawEndUtf16).toBe(document.lines[2]?.endUtf16)
    expect(layout.rowAt(3)?.displayStartUtf16).toBeGreaterThan(layout.rowAt(2)?.displayStartUtf16 ?? 0)
    expect(layout.rowAt(layout.totalRows)).toBeUndefined()
  })

  test("clamps windows and bounds their inclusive size", () => {
    const layout = createVirtualDiffLayout(parseDiff(diff), "message")

    expect(layout.window(-10, 2, 1)).toEqual([0, 2])
    expect(layout.window(3, 2, 1)).toEqual([2, 4])
    expect(layout.window(100, 2, 1)).toEqual([2, 4])
    const [first, last] = layout.window(0, 100, 10)
    expect(first).toBe(0)
    expect(last).toBe(layout.totalRows - 1)
    expect(last - first + 1).toBeLessThanOrEqual(100 + 20)
  })

  test("reports raw and full-display offsets with preamble and fixed gutter", () => {
    const document = parseDiff(diff)
    const layout = createVirtualDiffLayout(document, "message")
    const offsets = layout.displayOffsetsForLines(0, document.lines.length)
    const addition = document.lines[3]!

    expect(offsets.rawStartUtf16).toBe(document.lines[0]?.startUtf16)
    expect(offsets.rawEndUtf16).toBe(addition.endUtf16)
    expect(offsets.displayStartUtf16).toBe("message\n".length)
    expect(offsets.displayEndUtf16 - offsets.displayStartUtf16).toBe(
      document.lines.reduce((total, line, index) => total + (layout.rowAt(index + 1)?.text.length ?? 0) + 1, 0),
    )
    expect(layout.contentWidth).toBeGreaterThan(0)
  })

  test("maps gutter and Unicode pointer columns to unsplit raw boundaries", () => {
    const document = parseDiff(diff)
    const layout = createVirtualDiffLayout(document, "message")
    const addition = layout.rowAt(4)!
    const rawStart = addition.rawStartUtf16!
    const emojiColumn = addition.gutterCols + 5

    expect(layout.rawOffsetAt(4, 0)).toBe(rawStart)
    expect(layout.rawOffsetAt(4, addition.gutterCols - 1)).toBe(rawStart)
    expect(layout.rawOffsetAt(4, addition.gutterCols + 1)).toBe(rawStart + 1)
    expect(layout.rawOffsetAt(4, emojiColumn)).toBe(rawStart + 5)
    expect(layout.rawOffsetAt(4, emojiColumn + 1)).toBe(rawStart + 7)
  })
})
