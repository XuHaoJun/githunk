import { describe, expect, test } from "bun:test"
import { createTestRenderer } from "@opentui/core/testing"
import { createPane } from "../../src/ui/panes/common"
import { paneTextBuffer } from "../../src/ui/panes/pane-text"

/**
 * `paneTextBuffer().setText` must not retain native memory per write.
 *
 * OpenTUI 0.5.11 never frees the parsed content a write replaced: `UnifiedTextBuffer.setTextInternal`
 * (`packages/native/src/text-buffer.zig`) hands the segments to `UnifiedRope.setSegments`
 * (`packages/native/src/rope.zig`), which builds a fresh leaf node per segment and overwrites the
 * rope's root — the previous tree is dropped, not freed — and `clear()` cannot reclaim it. Only
 * `reset()` (arena reset + memory-registry clear + fresh rope) reuses that capacity.
 *
 * The observable is native RSS, because the JS heap stays flat throughout: 12000 Files-panel moves
 * in a real app run cost 61 MB of RSS with 15 MB of heap. An absolute bound would measure the
 * machine, so this asserts the *shape* instead — after the first writes, more of them must not keep
 * costing memory. Without the reclaim every window costs the same (linear, ~70 KB of RSS per 10 KB
 * written); with it, only the first window pays and the rest ride the arena's retained capacity.
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

      // Whatever the reclaim did to the buffer's internals, the last text is the installed one.
      expect(pane.text.plainText.length).toBe(bodies[(writes - 1) % bodies.length]!.length)
      expect(second).toBeLessThan(Math.max(first * 5, 20_000_000))
    } finally {
      setup.renderer.destroy()
    }
  })
})
