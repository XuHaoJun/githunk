import { describe, expect, test } from "bun:test"
import { computeColumnLayout, createListState, listRowAtPoint, moveListSelection, renderListRows, selectListRow, setListRows } from "../../src/ui/list-view"

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
