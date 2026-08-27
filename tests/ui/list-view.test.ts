import { describe, expect, test } from "bun:test"
import { RGBA, TextAttributes, type TextChunk } from "@opentui/core"
import { computeColumnLayout, createListState, listRowAtPoint, moveListSelection, renderListRows, selectListRow, setListRows } from "../../src/ui/list-view"
import { FILE_STAGED_FG, REFLOG_HASH_FG, SELECTED_LINE_BG } from "../../src/ui/theme"

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
