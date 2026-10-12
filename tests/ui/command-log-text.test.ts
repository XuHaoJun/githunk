import { describe, expect, test } from "bun:test"
import { TextRenderable, type RGBA } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import { installCommandLogText } from "../../src/ui/panes/command-log-text"
import type { CommandLogLine } from "../../src/domain/command"

function line(id: number, ...spans: readonly (readonly [string, CommandLogLine["spans"][number]["style"]])[]): CommandLogLine {
  return { id, spans: spans.map(([text, style]) => ({ text, style })) }
}

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
 * The log is encoded as styled chunks, one per span, so a span's colour survives OpenTUI's own
 * wrapping — a line that wraps onto several visual rows keeps its style on every one of them, and the
 * random tip's label/tip boundary needs no column arithmetic at all. These tests exercise that
 * against a real wrapped render.
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
        { id: 3, spans: [{ text: "Push branch", style: "action" }] }
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
      const lines: readonly CommandLogLine[] = [
        {
          id: 1,
          spans: [
            { text: label, style: "tip-label" },
            { text: tip, style: "tip" }
          ]
        }
      ]
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
        installCommandLogText(text, [
          {
            id: 1,
            spans: [
              { text: label, style: "tip-label" },
              { text: "GREEN", style: "tip" }
            ]
          }
        ])
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

  test("a shorter log leaves nothing painted past its end", async () => {
    // A shorter log replaces a longer one by rewriting the pane's whole content, so the rows the
    // longer log used to occupy hold nothing at all.
    const setup = await createTestRenderer({ width: 30, height: 8 })
    try {
      const text = new TextRenderable(setup.renderer, { id: "log-text", content: "", width: 24, height: 6, selectable: false, wrapMode: "char" })
      setup.renderer.root.add(text)
      installCommandLogText(text, [line(1, ["Stage file", "action"]), line(2, ["  git add -- a.txt", "command"]), line(3, ["Push branch", "action"])])
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
