import { describe, expect, test } from "bun:test"
import { TextRenderable, type RGBA } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import { LINE_END_COLS, commandLogLineHighlights, installCommandLogText } from "../../src/ui/panes/command-log-text"
import type { CommandLogLine } from "../../src/domain/command"

function line(id: number, ...spans: readonly (readonly [string, CommandLogLine["spans"][number]["style"]])[]): CommandLogLine {
  return { id, spans: spans.map(([text, style]) => ({ text, style })) }
}

/**
 * The pane lets OpenTUI wrap and paints whole *logical* lines — the unit
 * `PaneTextBuffer.addHighlight` addresses — so a line, not a visual row, is the input. A single-span
 * line paints whole, which is why only the random tip's label/tip boundary needs measuring.
 */
describe("commandLogLineHighlights", () => {
  test("paints a single-span line across the whole line", () => {
    expect(commandLogLineHighlights(line(1, ["You can hide/focus this panel by pressing '@'", "intro"]))).toEqual([
      { start: 0, end: LINE_END_COLS, style: "intro" },
    ])
    expect(commandLogLineHighlights(line(4, ["Stage file", "action"]))).toEqual([
      { start: 0, end: LINE_END_COLS, style: "action" },
    ])
  })

  test("paints a blank line as nothing", () => {
    expect(commandLogLineHighlights(line(2))).toEqual([])
  })

  test("splits the tip line at the label's boundary", () => {
    const tip = line(3, ["Random tip: ", "tip-label"], ["press '@' to hide this panel", "tip"])
    expect(commandLogLineHighlights(tip)).toEqual([
      { start: 0, end: 12, style: "tip-label" },
      { start: 12, end: LINE_END_COLS, style: "tip" },
    ])
  })

  test("measures the label in display cells, not code points or UTF-16 units", () => {
    // `addHighlight`'s columns are display cells. Probed against OpenTUI 0.5.6 directly: with
    // `"中 tip: GREEN"` installed, highlighting `[0, 8)` came back as `"中 tip: "` — 7 code points
    // and 7 UTF-16 units, but 8 cells, because 中 occupies two columns. `"🎲 tip: GREEN"` behaves
    // the same way (7 code points, 8 UTF-16 units, 8 cells). Code points end either label at column
    // 7 and hand its trailing space to the tip's colour; UTF-16 units do that to 中's label and only
    // coincide with cells for the emoji's, which is why both labels are asserted here. The
    // render-level test below pins the same thing end to end.
    expect(commandLogLineHighlights(line(1, ["🎲 tip: ", "tip-label"], ["go", "tip"]))).toEqual([
      { start: 0, end: 8, style: "tip-label" },
      { start: 8, end: LINE_END_COLS, style: "tip" },
    ])
    expect(commandLogLineHighlights(line(2, ["中 tip: ", "tip-label"], ["go", "tip"]))).toEqual([
      { start: 0, end: 8, style: "tip-label" },
      { start: 8, end: LINE_END_COLS, style: "tip" },
    ])
  })
})

/**
 * A `command`/`output` row is *unobservable* as painted: lazygit's `theme.DefaultTextColor` is
 * `style.FgDefault` (pkg/theme/theme.go:11), so the style those rows carry resolves to the very
 * colour the renderable already has, and a correctly painted row is byte-identical to an unpainted
 * one. What this still discriminates is the failure that matters here — a row painted with the
 * *wrong* style, which comes back `indexed` rather than `default`.
 */
function expectDefault(color: RGBA): void {
  expect(color.intent).toBe("default")
}

function expectIndexed(color: RGBA, slot: number): void {
  expect(color.intent).toBe("indexed")
  expect(color.slot).toBe(slot)
}

/**
 * `OpenTUI`'s `TextBuffer.addHighlight` addresses a *logical* (pre-wrap) line, not the visual row
 * `lineInfo.lineSources` is indexed by (confirmed against 0.5.6: `TextBufferRenderable` keeps a
 * pre-wrap `textBuffer` the highlight calls hit, separate from the wrapped `textBufferView` that
 * produces `lineInfo`), and its columns are display cells. `installCommandLogText` therefore paints
 * per logical line, in that line's own cell columns — these tests exercise that against a real
 * wrapped render, the thing a pure test of `commandLogLineHighlights` cannot see.
 */
describe("installCommandLogText", () => {
  test("colours every logical line correctly when an earlier line wraps", async () => {
    const setup = await createTestRenderer({ width: 20, height: 20 })
    try {
      const text = new TextRenderable(setup.renderer, { id: "log-text", content: "", width: 12, height: 10, selectable: false, wrapMode: "char" })
      setup.renderer.root.add(text)
      const lines: readonly CommandLogLine[] = [
        { id: 1, spans: [{ text: "Stage file", style: "action" }] },
        // 24 columns at width 12 wraps into exactly two visual rows, shifting every row after it.
        { id: 2, spans: [{ text: `  ${"a".repeat(22)}`, style: "command" }] },
        { id: 3, spans: [{ text: "Push branch", style: "action" }] },
      ]
      installCommandLogText(text, lines)
      ;(text as unknown as { requestRender?: () => void }).requestRender?.()
      await setup.flush()

      const frame = setup.captureSpans()
      // Row 0: "Stage file" (action, yellow).
      expectIndexed(frame.lines[0]!.spans[0]!.fg, 3)
      // Rows 1-2: the wrapped command line (default foreground) — not shifted into the wrong style.
      expectDefault(frame.lines[1]!.spans[0]!.fg)
      expectDefault(frame.lines[2]!.spans[0]!.fg)
      // Row 3: "Push branch" must still be action-yellow, not whatever colour a naive visual-row ==
      // logical-line index would have picked up two rows further down the document.
      expectIndexed(frame.lines[3]!.spans[0]!.fg, 3)
    } finally {
      setup.renderer.destroy()
    }
  })

  test("splits the random-tip line at the label even when it wraps", async () => {
    const setup = await createTestRenderer({ width: 20, height: 20 })
    try {
      const text = new TextRenderable(setup.renderer, { id: "log-text", content: "", width: 10, height: 10, selectable: false, wrapMode: "char" })
      setup.renderer.root.add(text)
      const label = "Random tip: "
      const tip = "this tip text is deliberately long enough to wrap across several rows"
      const lines: readonly CommandLogLine[] = [{ id: 1, spans: [{ text: label, style: "tip-label" }, { text: tip, style: "tip" }] }]
      installCommandLogText(text, lines)
      ;(text as unknown as { requestRender?: () => void }).requestRender?.()
      await setup.flush()

      const frame = setup.captureSpans()
      // Row 0 (width 10): "Random tip" — entirely inside the 12-column label, still yellow.
      expectIndexed(frame.lines[0]!.spans[0]!.fg, 3)
      // Row 1: ": " (still label, columns 10-12) then "this tip" (green) on the same visual row.
      const row1 = frame.lines[1]!.spans
      expect(row1[0]!.text).toBe(": ")
      expectIndexed(row1[0]!.fg, 3)
      expectIndexed(row1[1]!.fg, 2)
      // A later wrapped row stays green — the split at the label boundary was not repeated.
      expectIndexed(frame.lines[2]!.spans[0]!.fg, 2)
    } finally {
      setup.renderer.destroy()
    }
  })

  test("keeps a wide-character label's trailing space in the label's colour", async () => {
    // The production consequence of the column unit. `"🎲 tip: "` is 8 cells, 7 code points and 8
    // UTF-16 units; `"中 tip: "` is 8 cells, 7 code points and 7 UTF-16 units. A code-point count
    // ends either label a cell early and hands its trailing space to the tip's green; a UTF-16 count
    // does that to 中's label. Both labels are here so the two wrong units are ruled out together.
    for (const label of ["🎲 tip: ", "中 tip: "]) {
      const setup = await createTestRenderer({ width: 40, height: 6 })
      try {
        const text = new TextRenderable(setup.renderer, { id: "log-text", content: "", width: 30, height: 4, selectable: false, wrapMode: "char" })
        setup.renderer.root.add(text)
        installCommandLogText(text, [{ id: 1, spans: [{ text: label, style: "tip-label" }, { text: "GREEN", style: "tip" }] }])
        ;(text as unknown as { requestRender?: () => void }).requestRender?.()
        await setup.flush()

        const spans = setup.captureSpans().lines[0]!.spans
        expect(spans[0]!.text, `label ${JSON.stringify(label)}`).toBe(label)
        expectIndexed(spans[0]!.fg, 3)
        expect(spans[1]!.text.startsWith("GREEN")).toBe(true)
        expectIndexed(spans[1]!.fg, 2)
      } finally {
        setup.renderer.destroy()
      }
    }
  })

  test("asks for lines past the end of the log and paints nothing there", async () => {
    // The band is 32 logical lines wider than the viewport on each side, so on any log shorter than
    // that it asks for lines that do not exist — and after a *shorter* log replaces a longer one the
    // incremental path asks again, for the lines the previous band still covered. `paintLine`
    // answers those with nothing rather than failing, which is the only reason a short log renders.
    const setup = await createTestRenderer({ width: 30, height: 8 })
    try {
      const text = new TextRenderable(setup.renderer, { id: "log-text", content: "", width: 24, height: 6, selectable: false, wrapMode: "char" })
      setup.renderer.root.add(text)
      installCommandLogText(text, [
        line(1, ["Stage file", "action"]),
        line(2, ["  git add -- a.txt", "command"]),
        line(3, ["Push branch", "action"]),
      ])
      await setup.flush()
      installCommandLogText(text, [line(4, ["Stage file", "action"])])
      await setup.flush()

      const frame = setup.captureSpans()
      expect(text.plainText).toBe("Stage file")
      expectIndexed(frame.lines[0]!.spans[0]!.fg, 3)
      // Nothing was painted onto the rows the longer log used to occupy: a row carrying no
      // highlight at all comes back at the renderable's own `rgb` foreground, which is what
      // separates it from a painted `command` row's `default`.
      expect(frame.lines[1]!.spans[0]!.fg.intent).toBe("rgb")
    } finally {
      setup.renderer.destroy()
    }
  })
})
