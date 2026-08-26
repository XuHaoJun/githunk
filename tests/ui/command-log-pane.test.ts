import { describe, expect, test } from "bun:test"
import { createTestRenderer } from "@opentui/core/testing"
import { createCommandLogPane } from "../../src/ui/panes/command-log-pane"
import type { CommandLogLine } from "../../src/domain/command"

/**
 * `CommandLogPaneHandle.update()` has no direct test elsewhere: it is exercised only incidentally,
 * via tests/ui/mouse-parity.integration.test.ts:158-165 constructing the pane with an empty log.
 * These cover its two jobs — flattening a line's spans (and lines) into the plain text
 * `installCommandLogText` installs, and the now-reachable empty-log path (the pane used to fall
 * back to a "No commands recorded" placeholder; it now installs "").
 */
describe("command log pane", () => {
  test("flattens a multi-span line's spans, and lines, in order", async () => {
    const setup = await createTestRenderer({ width: 80, height: 24 })
    try {
      const lines: readonly CommandLogLine[] = [
        { id: 1, spans: [{ text: "Stage file", style: "action" }] },
        { id: 2, spans: [{ text: "  git add -- a.ts", style: "command" }] },
        { id: 3, spans: [{ text: "Random tip: ", style: "tip-label" }, { text: "press '@' to hide this panel", style: "tip" }] },
      ]
      const pane = createCommandLogPane(setup.renderer, lines)
      expect(pane.text.plainText).toBe("Stage file\n  git add -- a.ts\nRandom tip: press '@' to hide this panel")
    } finally {
      setup.renderer.destroy()
    }
  })

  test("installs empty text for an empty log, rather than a placeholder string", async () => {
    const setup = await createTestRenderer({ width: 80, height: 24 })
    try {
      const pane = createCommandLogPane(setup.renderer, [])
      expect(pane.text.plainText).toBe("")
    } finally {
      setup.renderer.destroy()
    }
  })

  test("update() is a no-op when the line count and newest line are unchanged", async () => {
    const setup = await createTestRenderer({ width: 80, height: 24 })
    try {
      const lines: readonly CommandLogLine[] = Array.from({ length: 6 }, (_unused, index) => ({
        id: index + 1,
        spans: [{ text: `  git add -- ${index}.ts`, style: "command" as const }],
      }))
      const pane = createCommandLogPane(setup.renderer, lines)
      // Resized so the log is taller than the viewport on purpose: without it `maxScrollY` is 1 and
      // this test would discriminate only by accident. Six lines in a three-row viewport gives a
      // scrolled-up position that a stray `scrollY = maxScrollY` would visibly undo.
      pane.resize(40, 5)
      expect(pane.maxScrollY()).toBeGreaterThan(1)
      pane.scrollBy(-2)
      const scrollBefore = pane.text.scrollY
      expect(scrollBefore).toBeLessThan(pane.maxScrollY())
      // Same array reference and same content: CommandLog.lines() hands back the same backing
      // array it appends to, so this is the shape a real refresh sees before a new line lands.
      pane.update(lines)
      expect(pane.text.scrollY).toBe(scrollBefore)
      expect(pane.text.plainText).toBe(lines.map((entry) => entry.spans[0]!.text).join("\n"))
    } finally {
      setup.renderer.destroy()
    }
  })

  test("update() re-flattens and scrolls to the bottom when a new line is appended", async () => {
    const setup = await createTestRenderer({ width: 80, height: 24 })
    try {
      const first: readonly CommandLogLine[] = Array.from({ length: 6 }, (_unused, index) => ({
        id: index + 1,
        spans: [{ text: `  git add -- ${index}.ts`, style: "command" as const }],
      }))
      const pane = createCommandLogPane(setup.renderer, first)
      pane.resize(40, 5)
      pane.scrollBy(-3)
      expect(pane.text.scrollY).toBeLessThan(pane.maxScrollY())
      const second: readonly CommandLogLine[] = [...first, { id: 7, spans: [{ text: "  git commit", style: "command" }] }]
      pane.update(second)
      expect(pane.text.plainText).toBe(second.map((entry) => entry.spans[0]!.text).join("\n"))
      // lazygit's extras view is created with `Autoscroll = true` (pkg/gui/views.go:149), so a new
      // line must pull the viewport back to the bottom.
      expect(pane.maxScrollY()).toBeGreaterThan(0)
      expect(pane.text.scrollY).toBe(pane.maxScrollY())
    } finally {
      setup.renderer.destroy()
    }
  })
})
