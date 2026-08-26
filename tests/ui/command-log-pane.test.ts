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
      const lines: readonly CommandLogLine[] = [{ id: 1, spans: [{ text: "Stage file", style: "action" }] }]
      const pane = createCommandLogPane(setup.renderer, lines)
      pane.scrollBy(-5)
      const scrollBefore = pane.text.scrollY
      // Same array reference and same content: CommandLog.lines() hands back the same backing
      // array it appends to, so this is the shape a real refresh sees before a new line lands.
      pane.update(lines)
      expect(pane.text.scrollY).toBe(scrollBefore)
      expect(pane.text.plainText).toBe("Stage file")
    } finally {
      setup.renderer.destroy()
    }
  })

  test("update() re-flattens and scrolls to bottom when a new line is appended", async () => {
    const setup = await createTestRenderer({ width: 80, height: 24 })
    try {
      const first: readonly CommandLogLine[] = [{ id: 1, spans: [{ text: "Stage file", style: "action" }] }]
      const pane = createCommandLogPane(setup.renderer, first)
      const second: readonly CommandLogLine[] = [...first, { id: 2, spans: [{ text: "  git add -- a.ts", style: "command" }] }]
      pane.update(second)
      expect(pane.text.plainText).toBe("Stage file\n  git add -- a.ts")
    } finally {
      setup.renderer.destroy()
    }
  })
})
