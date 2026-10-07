import { describe, expect, test } from "bun:test"
import { createTestRenderer } from "@opentui/core/testing"
import { createPane } from "../../src/ui/panes/common"
import { paneTextBuffer } from "../../src/ui/panes/pane-text"

/**
 * `paneTextBuffer().setText` must not retain native memory per write.
 *
 * OpenTUI 0.5.11 leaked the rope a write replaced — `UnifiedTextBuffer.setTextInternal`
 * (`packages/native/src/text-buffer.zig`) overwrote the rope's root without freeing the previous
 * tree, so rewriting a pane climbed in native RSS while the JS heap stayed flat. 0.5.13 released
 * replaced ropes (#1544), which is why `pane-text.ts` no longer calls the buffer's native
 * `reset()` before each write. This test remains the regression guard for the property itself,
 * because native RSS is exactly what such a leak hides from a heap assertion.
 *
 * An absolute bound would measure the machine, so this asserts the *shape* instead — after the
 * first writes, more of them must not keep costing memory. A regression to the 0.5.11 behavior
 * makes every window cost the same (linear, ~70 KB of RSS per 10 KB written); healthy, only the
 * first window pays and the rest ride the arena's retained capacity.
 */

/** Distinct texts, reused so the JS strings a write allocates stay out of the measurement. */
function texts(): readonly string[] {
  return Array.from({ length: 8 }, (_, pass) => Array.from({ length: 100 }, (_, index) => `row ${index} pass ${pass}`.padEnd(100, " ")).join("\n"))
}

describe("pane text buffer", () => {
  test("keeps the cost of rewriting text bounded instead of per write", async () => {
    const setup = await createTestRenderer({ width: 120, height: 40 })
    try {
      const pane = createPane(setup.renderer, "main", "memory", "", false)
      setup.renderer.root.add(pane.box)
      const buffer = paneTextBuffer(pane.text)
      expect(buffer).toBeDefined()
      const bodies = texts()
      let writes = 0
      const measure = (count: number): number => {
        Bun.gc(true)
        const before = process.memoryUsage().rss
        for (let index = 0; index < count; index++) buffer!.setText(bodies[writes++ % bodies.length]!)
        Bun.gc(true)
        return process.memoryUsage().rss - before
      }

      // The first window pays the arena's high-water for this text size; the second must not
      // repeat it. Linear growth would make the second window an order of magnitude larger; the
      // floor absorbs allocator steps that are not proportional to the write count.
      const first = measure(300)
      const second = measure(5000)

      // Whatever the buffer did internally, the last text is the installed one.
      expect(pane.text.plainText.length).toBe(bodies[(writes - 1) % bodies.length]!.length)
      expect(second).toBeLessThan(Math.max(first * 5, 20_000_000))
    } finally {
      setup.renderer.destroy()
    }
  })
})
