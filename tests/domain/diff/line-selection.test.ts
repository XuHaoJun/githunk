import { describe, expect, test } from "bun:test"
import { parseDiff } from "../../../src/domain/diff/parse"
import {
  changedIndexesInDiffLineRange,
  clearDiffLineRange,
  createDiffLineRangeState,
  diffLineSelectionRange,
  expandDiffLineRange,
  moveDiffLineSelection,
  toggleDiffLineRange,
} from "../../../src/domain/diff/line-selection"

describe("diff line range selection", () => {
  const document = parseDiff("diff --git a/a.txt b/a.txt\n@@ -1,2 +1,3 @@\n keep\n-old\n+new\n")

  test("initializes at the first addition or deletion", () => {
    const state = createDiffLineRangeState(document)
    expect(state).toEqual({ lineCount: document.lines.length, selectedIndex: 3, rangeMode: "none" })
  })

  test("sticky mode expands inclusively and v cancels it", () => {
    let state = toggleDiffLineRange(createDiffLineRangeState(document))
    expect(state).toMatchObject({ rangeMode: "sticky", rangeStartIndex: 3, selectedIndex: 3 })
    state = moveDiffLineSelection(state, "next")
    expect(diffLineSelectionRange(state)).toEqual({ startIndex: 3, endIndex: 4 })
    state = toggleDiffLineRange(state)
    expect(state).toMatchObject({ rangeMode: "none", selectedIndex: 4 })
    expect(state.rangeStartIndex).toBeUndefined()
  })

  test("shift expansion starts non-sticky and ordinary navigation cancels it", () => {
    let state = expandDiffLineRange(createDiffLineRangeState(document), "next")
    expect(state).toMatchObject({ rangeMode: "non-sticky", rangeStartIndex: 3, selectedIndex: 4 })
    state = moveDiffLineSelection(state, "previous")
    expect(state).toMatchObject({ rangeMode: "none", selectedIndex: 3 })
    expect(state.rangeStartIndex).toBeUndefined()
  })

  test("returns only additions and deletions from an inclusive reverse range", () => {
    const state = expandDiffLineRange(expandDiffLineRange(createDiffLineRangeState(document), "next"), "next")
    expect(changedIndexesInDiffLineRange(document, state).every((index) => ["addition", "deletion"].includes(document.lines[index]!.kind))).toBe(true)
    expect(changedIndexesInDiffLineRange(document, state)).toEqual([3, 4])

    const reverse = moveDiffLineSelection(toggleDiffLineRange(createDiffLineRangeState(document)), "previous")
    expect(diffLineSelectionRange(reverse)).toEqual({ startIndex: 2, endIndex: 3 })
  })

  test("clamps empty and no-change documents", () => {
    const empty = createDiffLineRangeState(parseDiff(""))
    expect(empty).toEqual({ lineCount: 0, selectedIndex: 0, rangeMode: "none" })
    expect(diffLineSelectionRange(empty)).toEqual({ startIndex: 0, endIndex: 0 })
    expect(changedIndexesInDiffLineRange(parseDiff(""), empty)).toEqual([])

    const metadata = parseDiff("diff --git a/a.txt b/a.txt\n")
    const state = createDiffLineRangeState(metadata)
    expect(state).toEqual({ lineCount: metadata.lines.length, selectedIndex: 0, rangeMode: "none" })
    expect(changedIndexesInDiffLineRange(metadata, state)).toEqual([])
    expect(clearDiffLineRange(moveDiffLineSelection(state, "next"))).toEqual(state)
  })
})
