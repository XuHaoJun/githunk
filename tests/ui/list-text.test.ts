import { describe, expect, test } from "bun:test"
import { TextAttributes, TextRenderable, type CapturedSpan } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import { createListState, expandListRangeSelection, moveListSelection, renderListRows, toggleListRangeSelection, type ListRow } from "../../src/ui/list-view"
import { installListText, releaseListText } from "../../src/ui/panes/list-text"
import { ANSI_GREEN } from "../../src/ui/theme"
import { cellWidth } from "../../src/domain/diff/cell-width"
/** Commit-style rows: a styled hash, a flex subject, a segmented marker, and a dim age. */
function rows(count: number): ListRow[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `commit:${index}`,
    columns: [
      { text: `c${String(index).padStart(4, "0")}`, priority: 1, style: "green" as const },
      { text: `subject ${index} 中文`, priority: 2, flex: true },
      {
        text: "●○",
        priority: 0,
        segments: [{ text: "●", color: ANSI_GREEN }, { text: "○" }]
      },
      { text: "2d ago", priority: 4, style: "dim" as const }
    ]
  }))
}

const WIDTH = 100

type Span = CapturedSpan

async function textWith(
  width = WIDTH,
  height = 40
): Promise<{
  text: TextRenderable
  flush: () => Promise<void>
  destroy: () => void
  spans: () => readonly (readonly Span[])[]
}> {
  const setup = await createTestRenderer({ width: width + 2, height: height + 2 })
  const text = new TextRenderable(setup.renderer, {
    id: "list-text",
    content: "",
    width,
    height,
    selectable: true
  })
  setup.renderer.root.add(text)
  text.wrapMode = "none"
  return {
    text,
    flush: () => setup.flush(),
    destroy: () => setup.renderer.destroy(),
    spans: () => setup.captureSpans().lines.map((line) => line.spans)
  }
}

function hasSelectionBackground(spans: readonly Span[]): boolean {
  return spans.some((span) => span.bg.intent !== "default" && span.bg.a > 0)
}

describe("list text installation", () => {
  test("installs the row text the StyledText renderer produces", async () => {
    const pane = await textWith()
    try {
      const state = createListState(rows(3))
      installListText(pane.text, { state, width: WIDTH, focused: true })
      await pane.flush()
      const expected = renderListRows(state, true, WIDTH)
        .chunks.map((chunk) => chunk.text)
        .join("")
      expect(pane.text.plainText).toBe(expected)
      const installed = expected.split("\n")
      // The selected row is padded to the visible width in display cells (wide CJK counts double)
      // so its background reaches the right edge; no row is wider than the width it was laid out for.
      expect(cellWidth(installed[0]!), "selected row width").toBe(WIDTH)
      for (const [index, row] of installed.entries()) {
        expect(cellWidth(row), `row ${index} width`).toBeLessThanOrEqual(WIDTH)
      }
    } finally {
      pane.destroy()
    }
  })

  test("paints selection, segment colours, and hover", async () => {
    const pane = await textWith()
    try {
      const state = createListState(rows(5))
      installListText(pane.text, { state, width: WIDTH, focused: true, hoveredId: "commit:2" })
      await pane.flush()
      const spans = pane.spans()
      // Selected row carries a background; its green stays green, as in `highlightChunk`.
      expect(hasSelectionBackground(spans[0]!)).toBe(true)
      expect(spans[0]!.some((span) => span.fg.intent === "indexed" && span.fg.slot === 2)).toBe(true)
      // Unselected rows keep the base colour: green hash, default background.
      expect(hasSelectionBackground(spans[1]!)).toBe(false)
      expect(spans[1]!.some((span) => span.fg.intent === "indexed" && span.fg.slot === 2)).toBe(true)
      const moved = moveListSelection(state, "next")
      installListText(pane.text, { state: moved, width: WIDTH, focused: true, hoveredId: "commit:2" })
      await pane.flush()
      const after = pane.spans()
      expect(hasSelectionBackground(after[0]!)).toBe(false)
      expect(hasSelectionBackground(after[1]!)).toBe(true)
      expect(hasSelectionBackground(after[2]!)).toBe(true)
    } finally {
      pane.destroy()
    }
  })
  test("selected styling wins over hover styling on the same row", async () => {
    const pane = await textWith()
    try {
      const state = createListState(rows(3))
      installListText(pane.text, { state, width: WIDTH, focused: true, hoveredId: "commit:0" })
      await pane.flush()
      const spans = pane.spans()
      // Hovered-but-selected row paints as selected: its own fg plus bold.
      const hash = spans[0]!.find((span) => span.text.includes("c0000"))!
      expect(hash.fg.intent).toBe("indexed")
      expect(hash.fg.slot).toBe(2)
      expect(hash.attributes & TextAttributes.BOLD).toBe(TextAttributes.BOLD)
      expect(hasSelectionBackground(spans[1]!)).toBe(false)
    } finally {
      pane.destroy()
    }
  })

  test("paints a keyboard range and follows its endpoint", async () => {
    const pane = await textWith()
    try {
      const state = createListState(rows(6))
      const ranged = expandListRangeSelection(toggleListRangeSelection(state), "next")
      installListText(pane.text, { state: ranged, width: WIDTH, focused: true })
      await pane.flush()
      const spans = pane.spans()
      expect(hasSelectionBackground(spans[0]!)).toBe(true)
      expect(hasSelectionBackground(spans[1]!)).toBe(true)
      expect(hasSelectionBackground(spans[2]!)).toBe(false)
      // Range rows keep the base foreground with no brightening or bold.
      const rangedHash = spans[0]!.find((span) => span.text.includes("c0000"))!
      expect(rangedHash.fg.intent).toBe("indexed")
      expect(rangedHash.fg.slot).toBe(2)
      expect(rangedHash.attributes & TextAttributes.BOLD).toBe(0)
      const grown = expandListRangeSelection(ranged, "next")
      installListText(pane.text, { state: grown, width: WIDTH, focused: true })
      await pane.flush()
      const after = pane.spans()
      expect(hasSelectionBackground(after[2]!)).toBe(true)
      expect(hasSelectionBackground(after[3]!)).toBe(false)
    } finally {
      pane.destroy()
    }
  })
  test("repaints same-text colour changes", async () => {
    const pane = await textWith()
    try {
      const state = createListState(rows(3))
      installListText(pane.text, { state, width: WIDTH, focused: false })
      await pane.flush()
      const before = pane.spans()
      expect(before[1]!.some((span) => span.fg.intent === "indexed" && span.fg.slot === 2)).toBe(true)
      const yellowRows = rows(3).map((row) => ({
        ...row,
        columns: row.columns.map((column, index) => (index === 0 ? { ...column, style: "yellow" as const } : column))
      }))
      const recoloured = createListState(yellowRows)
      installListText(pane.text, { state: recoloured, width: WIDTH, focused: false })
      await pane.flush()
      const after = pane.spans()
      expect(after[1]!.some((span) => span.fg.intent === "indexed" && span.fg.slot === 3)).toBe(true)
    } finally {
      pane.destroy()
    }
  })

  test("re-installing unchanged rows writes nothing", async () => {
    const pane = await textWith()
    try {
      const state = createListState(rows(5))
      installListText(pane.text, { state, width: WIDTH, focused: true })
      await pane.flush()
      const installed = pane.text.content
      installListText(pane.text, { state, width: WIDTH, focused: true })
      expect(pane.text.content).toBe(installed)
      // A row that changes visual state without changing text is a different install.
      installListText(pane.text, { state: moveListSelection(state, "next"), width: WIDTH, focused: true })
      expect(pane.text.content).not.toBe(installed)
    } finally {
      pane.destroy()
    }
  })

  test("release forgets the installed rows", async () => {
    const pane = await textWith()
    try {
      const state = createListState(rows(3))
      installListText(pane.text, { state, width: WIDTH, focused: true })
      await pane.flush()
      expect(hasSelectionBackground(pane.spans()[0]!)).toBe(true)
      const installed = pane.text.content
      releaseListText(pane.text)
      installListText(pane.text, { state, width: WIDTH, focused: true })
      await pane.flush()
      expect(pane.text.content).not.toBe(installed)
      expect(hasSelectionBackground(pane.spans()[0]!)).toBe(true)
    } finally {
      pane.destroy()
    }
  })

  test("a 20k-row cursor move re-encodes the list in bounded time", async () => {
    const pane = await textWith()
    try {
      const state = createListState(rows(20_000))
      installListText(pane.text, { state, width: WIDTH, focused: true })
      await pane.flush()
      const started = performance.now()
      let current = state
      for (let step = 0; step < 3; step++) {
        current = moveListSelection(current, "next")
        installListText(pane.text, { state: current, width: WIDTH, focused: true })
      }
      const elapsed = performance.now() - started
      // Three encodes of 20000 padded rows: measured ~11 ms each on 0.6.2. The bound is loose
      // enough for scheduler jitter but still fails if a move starts costing the document per row.
      expect(elapsed, `three 20k-row moves took ${elapsed.toFixed(0)}ms`).toBeLessThan(1500)
      await pane.flush()
      const spans = pane.spans()
      expect(hasSelectionBackground(spans[3]!)).toBe(true)
      expect(hasSelectionBackground(spans[2]!)).toBe(false)
    } finally {
      pane.destroy()
    }
  })
})
