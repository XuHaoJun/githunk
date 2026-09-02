import { describe, expect, test } from "bun:test"
import { RGBA, TextAttributes, type TextChunk } from "@opentui/core"
import type { ListDisplayRow, ListRow } from "../../src/ui/list-view"
import { clearListRangeSelection, computeColumnLayout, createListState, expandListRangeSelection, getListSelectionRange, hasMultipleListRowsSelected, isListRangeActive, listRowAtPoint, moveListSelection, renderListRows, selectListRow, setListRangeSelection, setListRows, toggleListRangeSelection } from "../../src/ui/list-view"
import { FILE_STAGED_FG, REFLOG_HASH_FG, SELECTED_LINE_BG, DEFAULT_BACKGROUND } from "../../src/ui/theme"

const rows = [
  { id: "a", columns: [{ text: "alpha", priority: 0 }] },
  { id: "b", columns: [{ text: "beta", priority: 0 }] },
  { id: "c", columns: [{ text: "gamma", priority: 0 }] },
] as const

describe("stable list state", () => {
  test("preserves ID and clamps the previous numeric index when an item disappears", () => {
    let state = selectListRow(createListState(rows), "b")
    state = setListRows(state, [rows[0]!, rows[2]!])
    expect(state.selectedId).toBe("c")
    expect(state.selectedIndex).toBe(1)
  })

  test("maps a visible click through scrollY and rejects borders and blank rows", () => {
    const geometry = { screenX: 10, screenY: 5, width: 20, height: 2, scrollY: 1 }
    expect(listRowAtPoint(createListState(rows), geometry, 12, 5)?.id).toBe("b")
    expect(listRowAtPoint(createListState(rows), geometry, 12, 7)).toBeUndefined()
    expect(listRowAtPoint(createListState(rows), geometry, 9, 5)).toBeUndefined()
  })

  test("keyboard movement and direct selection share one state", () => {
    const selected = moveListSelection(selectListRow(createListState(rows), "a"), "next")
    expect(selected).toMatchObject({ selectedId: "b", selectedIndex: 1 })
  })
})

describe("list column layout", () => {
  const row = (id: string, marker: string, name: string, note: string) => ({
    id,
    columns: [
      { text: marker, priority: 1 },
      { text: name, priority: 2, flex: true },
      { text: note, priority: 4 },
    ],
  })

  test("sizes every column to the widest cell in the list, not the row", () => {
    const layout = computeColumnLayout([row("a", "M", "alpha", "n"), row("b", "", "beta-long", "note")], 40)
    expect(layout).toEqual({ indexes: [0, 1, 2], widths: [1, 9, 4] })
  })

  test("drops a column that is blank on every row", () => {
    const layout = computeColumnLayout([row("a", "", "alpha", "n"), row("b", "", "beta", "note")], 40)
    expect(layout.indexes).toEqual([1, 2])
  })

  test("shrinks the flex column first, then sheds the least important columns", () => {
    expect(computeColumnLayout([row("a", "M", "a-fairly-long-name", "note")], 26).widths).toEqual([1, 18, 4])
    // Once the flex column would fall below half the width, the low-priority note goes instead.
    expect(computeColumnLayout([row("a", "M", "a-fairly-long-name", "note")], 12)).toEqual({ indexes: [0, 1], widths: [1, 10] })
  })

  test("pads cells so following columns line up on every row", () => {
    const state = createListState([row("a", "M", "alpha", "n"), row("b", "", "beta-long", "note")])
    const lines = renderListRows(state, false, 40).chunks.map((c) => c.text).join("").split("\n")
    expect(lines).toEqual(["M alpha     n", "  beta-long note"])
  })
})

/**
 * lazygit brightens every base-ANSI foreground on a highlighted line, ORs in bold, and only then
 * swaps in the selection background — pkg/gocui/view.go:665-680 (`View.setCharacter`). The test
 * checks the indexed slots directly so terminal palette brightness remains terminal-owned.
 */
describe("selected row highlighting", () => {
  const highlightRows = [
    {
      id: "a",
      columns: [
        { text: "abc1234", priority: 0, color: REFLOG_HASH_FG },
        { text: "subject", priority: 1, flex: true },
        { text: "MM", priority: 2, segments: [{ text: "M", color: FILE_STAGED_FG }, { text: "M", color: "#1a2b3c" }] },
        { text: "tag", priority: 3, style: "cyan" as const },
        { text: "note", priority: 4, style: "green" as const },
      ],
    },
    {
      id: "b",
      columns: [
        { text: "def5678", priority: 0, color: REFLOG_HASH_FG },
        { text: "other", priority: 1, flex: true },
        { text: "MM", priority: 2, segments: [{ text: "M", color: FILE_STAGED_FG }, { text: "M", color: "#1a2b3c" }] },
        { text: "tag", priority: 3, style: "cyan" as const },
        { text: "note", priority: 4, style: "green" as const },
      ],
    },
  ]

  const isBold = (chunk: TextChunk) => ((chunk.attributes ?? 0) & TextAttributes.BOLD) === TextAttributes.BOLD
  const expectIndexed = (color: RGBA | undefined, slot: number) => {
    expect(color?.intent).toBe("indexed")
    expect(color?.slot).toBe(slot)
  }

  /** The chunks of one rendered row, split on the newline chunks `renderListRows` joins rows with. */
  const lineChunks = (chunks: readonly TextChunk[], line: number) => {
    const lines: TextChunk[][] = [[]]
    for (const chunk of chunks) {
      if (chunk.text === "\n") lines.push([])
      else lines[lines.length - 1]!.push(chunk)
    }
    expect(lines[line]).toBeDefined()
    return lines[line]!
  }
  const render = (line = 0) => {
    const state = selectListRow(createListState(highlightRows), "a")
    return lineChunks(renderListRows(state, true, 60).chunks, line)
  }
  const chunkFor = (chunks: readonly TextChunk[], text: string) => {
    const found = chunks.find((c) => c.text === text)
    expect(found).toBeDefined()
    return found!
  }

  test("brightens a base-ANSI foreground and bolds it over the selection background", () => {
    const hash = chunkFor(render(), "abc1234")
    expectIndexed(hash.bg, 4)
    expectIndexed(hash.fg, 12)
    expect(isBold(hash)).toBe(true)
  })

  test("leaves an uncoloured chunk terminal-default-coloured but still bolds it", () => {
    const subject = chunkFor(render(), "subject")
    expect(subject.fg).toBeUndefined()
    expectIndexed(subject.bg, 4)
    expect(isBold(subject)).toBe(true)
  })

  test("brightens per-character segments and semantic list styles alike", () => {
    const chunks = render()
    const staged = chunks.filter((c) => c.text === "M")
    expect(staged.length).toBe(2)
    expectIndexed(staged[0]!.fg, 10)
    expect(staged.every(isBold)).toBe(true)

    const note = chunkFor(chunks, "note")
    expectIndexed(note.fg, 10)
    expect(isBold(note)).toBe(true)

    const tag = chunkFor(chunks, "tag")
    expectIndexed(tag.fg, 14)
    expect(isBold(tag)).toBe(true)
  })

  test("preserves an unmapped truecolor foreground while still bolding it", () => {
    const truecolor = render().filter((c) => c.text === "M")[1]!
    expect(truecolor.fg?.intent).toBe("rgb")
    expect(truecolor.fg?.toInts()).toEqual([26, 43, 60, 255])
    expectIndexed(truecolor.bg, 4)
    expect(isBold(truecolor)).toBe(true)
  })

  test("leaves every unselected row exactly as it was", () => {
    const chunks = render(1)
    const hash = chunkFor(chunks, "def5678")
    expectIndexed(hash.fg, 4)
    expect(hash.bg).toBeUndefined()
    expect(isBold(hash)).toBe(false)
    const other = chunkFor(chunks, "other")
    expect(other.fg).toBeUndefined()
    expect(other.bg).toBeUndefined()
    expect(isBold(other)).toBe(false)
  })

  test("keeps the trailing padding chunk carrying the selection background", () => {
    // RootView.selectedRowHasBackground() looks for exactly this `bg` property.
    const chunks = render()
    const padding = chunks.filter((c) => c.text.trim().length === 0 && c.bg !== undefined)
    expect(padding.length).toBeGreaterThan(0)
    expect(padding.every((c) => c.bg?.intent === "indexed" && c.bg.slot === 4)).toBe(true)
  })

  test("an unfocused list gets no highlight at all", () => {
    const state = selectListRow(createListState(highlightRows), "a")
    const chunks = lineChunks(renderListRows(state, false, 60).chunks, 0)
    expect(chunks.every((c) => c.bg === undefined)).toBe(true)
    expect(chunks.every((c) => ((c.attributes ?? 0) & TextAttributes.BOLD) === 0)).toBe(true)
    expectIndexed(chunkFor(chunks, "abc1234").fg, 4)
  })
})

describe("hovered row highlighting", () => {
  const isBold = (chunk: TextChunk) => ((chunk.attributes ?? 0) & TextAttributes.BOLD) === TextAttributes.BOLD
  const hoverState = selectListRow(createListState([
    { id: "a", columns: [{ text: "alpha", priority: 0 }] },
    { id: "b", columns: [{ text: "beta", priority: 0 }] },
  ]), "a")

  const line = (chunks: readonly TextChunk[], index: number): TextChunk[] => {
    const lines: TextChunk[][] = [[]]
    for (const chunk of chunks) {
      if (chunk.text === "\n") lines.push([])
      else lines[lines.length - 1]!.push(chunk)
    }
    return lines[index]!
  }

  const colorDistance = (left: RGBA, right: RGBA): number => {
    const [lr, lg, lb] = left.toInts()
    const [rr, rg, rb] = right.toInts()
    return Math.abs(lr - rr) + Math.abs(lg - rg) + Math.abs(lb - rb)
  }

  test("renders a hovered row with a subdued full-width background", () => {
    const chunks = line(renderListRows(hoverState, false, 20, "a").chunks, 0)
    const hovered = chunks.find((chunk) => chunk.text === "alpha")!
    const defaultBackground = DEFAULT_BACKGROUND

    expect(hovered.bg).toBeDefined()
    expect(hovered.bg?.intent).toBe("rgb")
    expect(colorDistance(hovered.bg!, defaultBackground)).toBeLessThan(colorDistance(SELECTED_LINE_BG, defaultBackground))
    expect(chunks.filter((chunk) => chunk.bg !== undefined).length).toBeGreaterThan(1)
    expect(chunks.every((chunk) => ((chunk.attributes ?? 0) & TextAttributes.BOLD) === 0)).toBe(true)
  })

  test("selected styling wins over hover styling", () => {
    const chunks = line(renderListRows(hoverState, true, 20, "a").chunks, 0)
    const selected = chunks.find((chunk) => chunk.text === "alpha")!

    expect(selected.bg?.intent).toBe("indexed")
    expect(selected.bg?.slot).toBe(4)
    expect(isBold(selected)).toBe(true)
  })
})

describe("list range selection", () => {
  test("sticky range expands inclusively and v cancels it", () => {
    let state = selectListRow(createListState(rows), "b")
    state = toggleListRangeSelection(state)
    expect(state).toMatchObject({ rangeMode: "sticky", rangeStartId: "b" })
    state = moveListSelection(state, "next")
    expect(getListSelectionRange(state)).toEqual({ startIndex: 1, endIndex: 2 })
    state = toggleListRangeSelection(state)
    expect(state).toMatchObject({ rangeMode: "none", selectedId: "c" })
    expect(state.rangeStartId).toBeUndefined()
  })

  test("shift expansion starts non-sticky and ordinary navigation cancels it", () => {
    let state = selectListRow(createListState(rows), "b")
    state = expandListRangeSelection(state, "next")
    expect(state).toMatchObject({ rangeMode: "non-sticky", rangeStartId: "b", selectedId: "c" })
    state = moveListSelection(state, "previous")
    expect(state).toMatchObject({ rangeMode: "none", selectedId: "b" })
  })

  test("reverse ranges include both stable-id endpoints", () => {
    const state = setListRangeSelection(createListState(rows), "c", "a")
    expect(getListSelectionRange(state)).toEqual({ startIndex: 0, endIndex: 2 })
    expect(hasMultipleListRowsSelected(state)).toBe(true)
  })

  test("direct click clears active sticky range", () => {
    let state = selectListRow(createListState(rows), "a")
    state = toggleListRangeSelection(state)
    state = moveListSelection(state, "next")
    expect(isListRangeActive(state)).toBe(true)
    state = selectListRow(state, "c")
    expect(state).toMatchObject({ rangeMode: "none", selectedId: "c" })
    expect(state.rangeStartId).toBeUndefined()
    expect(isListRangeActive(state)).toBe(false)
    expect(hasMultipleListRowsSelected(state)).toBe(false)
    expect(getListSelectionRange(state)).toEqual({ startIndex: 2, endIndex: 2 })
  })

  test("direct click clears active non-sticky range", () => {
    let state = selectListRow(createListState(rows), "b")
    state = expandListRangeSelection(state, "next")
    expect(isListRangeActive(state)).toBe(true)
    state = selectListRow(state, "a")
    expect(state).toMatchObject({ rangeMode: "none", selectedId: "a" })
    expect(state.rangeStartId).toBeUndefined()
  })

  test("setListRows preserves range only when both endpoints remain", () => {
    let state = setListRangeSelection(createListState(rows), "a", "c")
    expect(isListRangeActive(state)).toBe(true)
    // both endpoints remain -> preserve
    let preserved = setListRows(state, rows)
    expect(preserved).toMatchObject({ rangeMode: "non-sticky", rangeStartId: "a", selectedId: "c" })
    expect(getListSelectionRange(preserved)).toEqual({ startIndex: 0, endIndex: 2 })
    // anchor missing -> clear
    const withoutAnchor = setListRows(state, [rows[1]!, rows[2]!])
    expect(withoutAnchor.rangeMode).toBe("none")
    expect(withoutAnchor.rangeStartId).toBeUndefined()
    expect(withoutAnchor.selectedId).toBe("c")
    // endpoint missing -> clear (selected fallback to remaining)
    const withoutEndpoint = setListRows(state, [rows[0]!, rows[1]!])
    expect(withoutEndpoint.rangeMode).toBe("none")
    expect(withoutEndpoint.rangeStartId).toBeUndefined()
    // sticky variant also clears when endpoint gone
    let sticky = selectListRow(createListState(rows), "b")
    sticky = toggleListRangeSelection(sticky)
    sticky = moveListSelection(sticky, "next")
    expect(sticky.rangeMode).toBe("sticky")
    const stickyCleared = setListRows(sticky, [rows[0]!, rows[1]!])
    expect(stickyCleared.rangeMode).toBe("none")
    expect(stickyCleared.rangeStartId).toBeUndefined()
  })

  test("empty list has no active range and single index", () => {
    const empty = createListState([])
    expect(empty.rangeMode).toBe("none")
    expect(empty.rangeStartId).toBeUndefined()
    expect(isListRangeActive(empty)).toBe(false)
    expect(hasMultipleListRowsSelected(empty)).toBe(false)
    expect(getListSelectionRange(empty)).toEqual({ startIndex: 0, endIndex: 0 })
    expect(toggleListRangeSelection(empty)).toMatchObject({ rangeMode: "none" })
    expect(expandListRangeSelection(empty, "next").rangeMode).toBe("none")
    expect(clearListRangeSelection(empty).rangeMode).toBe("none")
    expect(moveListSelection(empty, "next")).toBe(empty)
  })

  test("one-row boundaries clamp without multi-select", () => {
    const oneRow = [{ id: "solo", columns: [{ text: "only", priority: 0 }] }] as const
    let state = createListState(oneRow as unknown as typeof rows)
    expect(state.rangeMode).toBe("none")
    state = toggleListRangeSelection(state)
    expect(state).toMatchObject({ rangeMode: "sticky", rangeStartId: "solo" })
    expect(getListSelectionRange(state)).toEqual({ startIndex: 0, endIndex: 0 })
    expect(hasMultipleListRowsSelected(state)).toBe(false)
    const moved = moveListSelection(state, "next")
    expect(moved.selectedId).toBe("solo")
    expect(getListSelectionRange(moved)).toEqual({ startIndex: 0, endIndex: 0 })
    expect(hasMultipleListRowsSelected(moved)).toBe(false)
    const expanded = expandListRangeSelection(createListState(oneRow as unknown as typeof rows), "next")
    expect(expanded).toMatchObject({ rangeMode: "non-sticky", rangeStartId: "solo", selectedId: "solo" })
    expect(getListSelectionRange(expanded)).toEqual({ startIndex: 0, endIndex: 0 })
    expect(hasMultipleListRowsSelected(expanded)).toBe(false)
    // setListRangeSelection with same id is single
    const same = setListRangeSelection(createListState(oneRow as unknown as typeof rows), "solo", "solo")
    expect(getListSelectionRange(same)).toEqual({ startIndex: 0, endIndex: 0 })
    expect(hasMultipleListRowsSelected(same)).toBe(false)
  })

  test("clearListRangeSelection keeps selected and drops anchor", () => {
    let state = setListRangeSelection(createListState(rows), "a", "c")
    expect(isListRangeActive(state)).toBe(true)
    state = clearListRangeSelection(state)
    expect(state).toMatchObject({ rangeMode: "none", selectedId: "c" })
    expect(state.rangeStartId).toBeUndefined()
    expect(isListRangeActive(state)).toBe(false)
  })

  test("toggle from non-sticky clears the range", () => {
    let state = selectListRow(createListState(rows), "b")
    state = expandListRangeSelection(state, "next")
    expect(state.rangeMode).toBe("non-sticky")
    state = toggleListRangeSelection(state)
    expect(state).toMatchObject({ rangeMode: "none", selectedId: "c" })
    expect(state.rangeStartId).toBeUndefined()
  })

  test("setListRangeSelection with unknown ids does not activate", () => {
    const state = createListState(rows)
    const unknownAnchor = setListRangeSelection(state, "unknown", "a")
    expect(unknownAnchor.rangeMode).toBe("none")
    expect(isListRangeActive(unknownAnchor)).toBe(false)
    const unknownEndpoint = setListRangeSelection(state, "a", "unknown")
    expect(unknownEndpoint.rangeMode).toBe("none")
    expect(isListRangeActive(unknownEndpoint)).toBe(false)
  })

  test("sticky navigation retains anchor while non-sticky clears on ordinary move", () => {
    let sticky = selectListRow(createListState(rows), "a")
    sticky = toggleListRangeSelection(sticky)
    sticky = moveListSelection(sticky, "next")
    expect(sticky).toMatchObject({ rangeMode: "sticky", rangeStartId: "a", selectedId: "b" })
    sticky = moveListSelection(sticky, "next")
    expect(sticky).toMatchObject({ rangeMode: "sticky", rangeStartId: "a", selectedId: "c" })
    // reverse retains anchor
    sticky = moveListSelection(sticky, "previous")
    expect(sticky).toMatchObject({ rangeMode: "sticky", rangeStartId: "a", selectedId: "b" })

    let nonSticky = selectListRow(createListState(rows), "a")
    nonSticky = expandListRangeSelection(nonSticky, "next")
    expect(nonSticky.rangeMode).toBe("non-sticky")
    nonSticky = moveListSelection(nonSticky, "next")
    // non-sticky should clear before moving from current selected
    expect(nonSticky).toMatchObject({ rangeMode: "none", selectedId: "c" })
    expect(nonSticky.rangeStartId).toBeUndefined()
  })
})

describe("list range rendering", () => {
  const rangeRows = [
    { id: "a", columns: [{ text: "alpha", priority: 0 }] },
    { id: "b", columns: [{ text: "beta", priority: 0 }] },
    { id: "c", columns: [{ text: "gamma", priority: 0 }] },
  ] as const

  const isBold = (chunk: TextChunk) => ((chunk.attributes ?? 0) & TextAttributes.BOLD) === TextAttributes.BOLD
  const lineChunks = (chunks: readonly TextChunk[], line: number) => {
    const lines: TextChunk[][] = [[]]
    for (const chunk of chunks) {
      if (chunk.text === "\n") lines.push([])
      else lines[lines.length - 1]!.push(chunk)
    }
    return lines[line]!
  }

  test("paints every inclusive row in focused range and none when unfocused", () => {
    const ranged = setListRangeSelection(createListState(rangeRows), "a", "c")
    const focused = renderListRows(ranged, true, 20).chunks
    for (let i = 0; i < 3; i++) {
      const line = lineChunks(focused, i)
      const hasSelectedBg = line.some((c) => c.bg !== undefined && c.bg.intent === "indexed" && c.bg.slot === 4)
      expect(hasSelectedBg).toBe(true)
    }
    // only selectedId keeps bold/bright styling
    const focusedBoldLines = [0, 1, 2].map((i) => lineChunks(focused, i).some(isBold))
    expect(focusedBoldLines).toEqual([false, false, true])

    const unfocused = renderListRows(ranged, false, 20).chunks
    for (let i = 0; i < 3; i++) {
      const line = lineChunks(unfocused, i)
      expect(line.every((c) => c.bg === undefined)).toBe(true)
      expect(line.every((c) => !isBold(c))).toBe(true)
    }
  })

  test("single-row focused range still highlights exactly the selected row", () => {
    const single = setListRangeSelection(createListState(rangeRows), "b", "b")
    expect(hasMultipleListRowsSelected(single)).toBe(false)
    expect(isListRangeActive(single)).toBe(true)
    const focused = renderListRows(single, true, 20).chunks
    const lines = [0, 1, 2].map((i) => lineChunks(focused, i))
    expect(lines[0]!.every((c) => c.bg === undefined)).toBe(true)
    expect(lines[1]!.some((c) => c.bg !== undefined && c.bg.slot === 4)).toBe(true)
    expect(lines[2]!.every((c) => c.bg === undefined)).toBe(true)
    expect(lines[1]!.some(isBold)).toBe(true)
    expect(lines[0]!.some(isBold)).toBe(false)
  })

  test("range derived from stable ids highlights by row order even with headers", () => {
    const rowsWithHeaders = [
      { id: "a", columns: [{ text: "alpha", priority: 0 }] },
      { id: "b", columns: [{ text: "beta", priority: 0 }] },
      { id: "c", columns: [{ text: "gamma", priority: 0 }] },
    ] as const
    const displayRows = [
      { kind: "header" as const, text: "Header" },
      { kind: "item" as const, id: "c" },
      { kind: "item" as const, id: "a" },
      { kind: "item" as const, id: "b" },
      { kind: "message" as const, text: "footer" },
    ]
    const state = setListRangeSelection(createListState(rowsWithHeaders, displayRows), "a", "c")
    // rows indexes: a=0,c=2 -> range 0-2 includes all three items, header/message must stay unhighlighted
    expect(getListSelectionRange(state)).toEqual({ startIndex: 0, endIndex: 2 })
    const focused = renderListRows(state, true, 30).chunks
    // displayRows order: 0 header, 1 c, 2 a, 3 b, 4 message
    const headerLine = lineChunks(focused, 0)
    expect(headerLine.every((c) => c.bg === undefined)).toBe(true)
    const cLine = lineChunks(focused, 1)
    expect(cLine.some((c) => c.bg !== undefined && c.bg.slot === 4)).toBe(true)
    const aLine = lineChunks(focused, 2)
    expect(aLine.some((c) => c.bg !== undefined && c.bg.slot === 4)).toBe(true)
    const bLine = lineChunks(focused, 3)
    expect(bLine.some((c) => c.bg !== undefined && c.bg.slot === 4)).toBe(true)
    const msgLine = lineChunks(focused, 4)
    expect(msgLine.every((c) => c.bg === undefined)).toBe(true)
    // unknown ids are left unhighlighted: add an unknown item row
    const withUnknownDisplay: readonly ListDisplayRow[] = [...displayRows, { kind: "item" as const, id: "unknown" }]
    const stateWithUnknown = setListRangeSelection(createListState(rowsWithHeaders, withUnknownDisplay), "a", "c")
    const focused2 = renderListRows(stateWithUnknown, true, 30).chunks
    const unknownLine = lineChunks(focused2, 5)
    expect(unknownLine.every((c) => c.bg === undefined)).toBe(true)
  })

  test("empty and one-row ranges render without crashing and follow focused contract", () => {
    const empty = createListState([])
    expect(renderListRows(empty, true, 20).chunks.length).toBe(0)
    expect(renderListRows(empty, false, 20).chunks.length).toBe(0)
    const oneRow: readonly ListRow[] = [{ id: "solo", columns: [{ text: "only", priority: 0 }] }]
    const rangedOne = setListRangeSelection(createListState(oneRow), "solo", "solo")
    const focusedOne = renderListRows(rangedOne, true, 20).chunks
    expect(lineChunks(focusedOne, 0).some((c) => c.bg !== undefined && c.bg.slot === 4)).toBe(true)
    const unfocusedOne = renderListRows(rangedOne, false, 20).chunks
    expect(lineChunks(unfocusedOne, 0).every((c) => c.bg === undefined)).toBe(true)
  })
})
