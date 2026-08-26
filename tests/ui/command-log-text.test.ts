import { describe, expect, test } from "bun:test"
import { TextRenderable, type RGBA } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import { ROW_END_COLS, commandLogRowHighlights, installCommandLogText } from "../../src/ui/panes/command-log-text"
import type { CommandLogLine } from "../../src/domain/command"

function line(id: number, ...spans: readonly (readonly [string, CommandLogLine["spans"][number]["style"]])[]): CommandLogLine {
  return { id, spans: spans.map(([text, style]) => ({ text, style })) }
}

/**
 * The pane lets OpenTUI wrap and paints per *visual* row, so `lineSources` — OpenTUI's visual row →
 * logical line map (as src/ui/panes/diff-text.ts:104-108 uses it) — is the input. A single-span
 * line paints whole, which is why wide characters never need measuring here.
 */
describe("commandLogRowHighlights", () => {
  const lines: readonly CommandLogLine[] = [
    line(1, ["You can hide/focus this panel by pressing '@'", "intro"]),
    line(2),
    line(3, ["Random tip: ", "tip-label"], ["press '@' to hide this panel", "tip"]),
    line(4, ["Stage file", "action"]),
    line(5, ["  git add -- a.ts", "command"]),
  ]

  test("paints a single-span row across the whole row", () => {
    expect(commandLogRowHighlights(lines, [0, 1, 2, 3, 4], 0)).toEqual([
      { start: 0, end: ROW_END_COLS, style: "intro" },
    ])
    expect(commandLogRowHighlights(lines, [0, 1, 2, 3, 4], 3)).toEqual([
      { start: 0, end: ROW_END_COLS, style: "action" },
    ])
  })

  test("paints a blank line as nothing", () => {
    expect(commandLogRowHighlights(lines, [0, 1, 2, 3, 4], 1)).toEqual([])
  })

  test("splits the tip row at the label's code-point boundary", () => {
    expect(commandLogRowHighlights(lines, [0, 1, 2, 3, 4], 2)).toEqual([
      { start: 0, end: 12, style: "tip-label" },
      { start: 12, end: ROW_END_COLS, style: "tip" },
    ])
  })

  test("paints a continuation row of a single-span line in that line's style", () => {
    // Row 5 and row 6 both wrapped out of logical line index 4.
    expect(commandLogRowHighlights(lines, [0, 1, 2, 3, 4, 4], 5)).toEqual([
      { start: 0, end: ROW_END_COLS, style: "command" },
    ])
  })

  test("paints a continuation row of the tip line in the trailing span's style", () => {
    expect(commandLogRowHighlights(lines, [0, 1, 2, 2, 3, 4], 3)).toEqual([
      { start: 0, end: ROW_END_COLS, style: "tip" },
    ])
  })

  test("yields nothing for a row past the end of the map or the lines", () => {
    expect(commandLogRowHighlights(lines, [0, 1, 2, 3, 4], 9)).toEqual([])
    expect(commandLogRowHighlights(lines, [0, 1, 2, 3, 4, 5], 5)).toEqual([])
  })

  test("counts the label in code points, not UTF-16 units", () => {
    // "🎲 tip: " is 8 UTF-16 units (the die is a surrogate pair) but 7 code points — [...string]
    // walks code points, so a naive `.length` here would silently pass a UTF-16-counted brief and
    // fail this comment's own claim.
    const emoji: readonly CommandLogLine[] = [line(1, ["🎲 tip: ", "tip-label"], ["go", "tip"])]
    expect(commandLogRowHighlights(emoji, [0], 0)).toEqual([
      { start: 0, end: 7, style: "tip-label" },
      { start: 7, end: ROW_END_COLS, style: "tip" },
    ])
  })
})

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
 * produces `lineInfo`). `installCommandLogText`'s `paintWindow` therefore paints a logical line only
 * from its first visual row and walks a mid-wrap `from` back to that row — these tests exercise that
 * translation against a real wrapped render, the thing a pure test of `commandLogRowHighlights`
 * cannot see.
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
})
