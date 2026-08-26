import { describe, expect, test } from "bun:test"
import { TextRenderable } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import { parseDiff } from "../../src/domain/diff/parse"
import { renderDiff } from "../../src/domain/diff/render"
import { installDiffText } from "../../src/ui/panes/diff-text"

/** A one-file patch with `lines` changed rows, as `git diff` would emit it. */
function patchText(lines: number): string {
  const body: string[] = []
  for (let index = 0; index < lines; index++) {
    body.push(index % 2 === 0 ? `-line ${index} before padding padding` : `+line ${index} after padding padding`)
  }
  return [
    "diff --git a/big.txt b/big.txt",
    "index 1111111..2222222 100644",
    "--- a/big.txt",
    "+++ b/big.txt",
    `@@ -1,${lines} +1,${lines} @@`,
    ...body,
    "",
  ].join("\n")
}

type Pane = {
  readonly text: TextRenderable
  install(): void
  flush(): Promise<void>
  destroy(): void
}

async function paneWith(lines: number): Promise<Pane> {
  const setup = await createTestRenderer({ width: 120, height: 40 })
  const text = new TextRenderable(setup.renderer, { id: "main-text", content: "", width: 118, height: 38, selectable: true })
  setup.renderer.root.add(text)
  text.wrapMode = "char"
  const rendered = renderDiff(parseDiff(patchText(lines)))
  return {
    text,
    install: () => installDiffText(text, { preamble: "", body: rendered.displayText, displayLines: rendered.displayLines }),
    flush: () => setup.flush(),
    destroy: () => setup.renderer.destroy(),
  }
}

/** Average wall time of one scroll-and-repaint step, frame pacing included. */
async function millisecondsPerScroll(lines: number): Promise<number> {
  const pane = await paneWith(lines)
  try {
    pane.install()
    await pane.flush()
    // Two rows a step, staying inside the shorter document's range so both do the same work.
    const steps = 30
    const started = performance.now()
    for (let step = 0; step < steps; step++) {
      pane.text.scrollY = step * 2
      await pane.flush()
    }
    return (performance.now() - started) / steps
  } finally {
    pane.destroy()
  }
}

describe("diff text installation", () => {
  test("installs a 20k-line patch in viewport time", async () => {
    const pane = await paneWith(20000)
    try {
      const started = performance.now()
      pane.install()
      const elapsed = performance.now() - started
      await pane.flush()
      expect(elapsed, `install took ${elapsed.toFixed(0)}ms`).toBeLessThan(250)
    } finally {
      pane.destroy()
    }
  })

  test("scrolling costs the viewport, not the document", async () => {
    // Measured as a ratio, because the wall time of one step is dominated by the renderer's frame
    // cadence either way. What must not happen is the *document* entering the per-scroll cost —
    // which it does the moment a repaint re-reads the whole row-to-line map, or repaints every row.
    const small = await millisecondsPerScroll(200)
    const large = await millisecondsPerScroll(20000)
    expect(large, `${large.toFixed(1)}ms per scroll at 20k lines vs ${small.toFixed(1)}ms at 200`).toBeLessThan(small * 2 + 6)
  })

  test("re-installing identical content does no work and keeps the viewport", async () => {
    const pane = await paneWith(20000)
    try {
      pane.install()
      await pane.flush()
      pane.text.scrollY = 500
      await pane.flush()

      const started = performance.now()
      for (let repeat = 0; repeat < 20; repeat++) pane.install()
      const elapsed = performance.now() - started

      expect(elapsed, `20 re-installs took ${elapsed.toFixed(1)}ms`).toBeLessThan(20)
      expect(pane.text.scrollY).toBe(500)
    } finally {
      pane.destroy()
    }
  })
})

/**
 * The band around the viewport is 32 logical lines wider than the viewport on each side, so on any
 * document shorter than that — or with a preamble ahead of the patch — it asks for lines the diff
 * does not describe: rows before `firstDiffRow` (a negative index into `displayLines`) and rows past
 * its end. `installDiffText`'s `paintLine` answers those with nothing rather than failing, which is
 * the only reason a short diff renders at all.
 */
describe("diff text band edges", () => {
  test("paints only the rows the diff describes when the band overruns both ends", async () => {
    const setup = await createTestRenderer({ width: 40, height: 14 })
    try {
      const text = new TextRenderable(setup.renderer, { id: "main-text", content: "", width: 34, height: 12, selectable: true })
      setup.renderer.root.add(text)
      text.wrapMode = "char"
      const rendered = renderDiff(parseDiff(patchText(2)))
      installDiffText(text, { preamble: "commit abcdef0\nAuthor: Ada\n", body: rendered.displayText, displayLines: rendered.displayLines })
      await setup.flush()

      const frame = setup.captureSpans()
      expect(text.plainText.split("\n").slice(0, 2)).toEqual(["commit abcdef0", "Author: Ada"])
      // The preamble carries no diff style: `displayLines[-2]` and `[-1]` are nothing to paint.
      expect(frame.lines[0]!.spans[0]!.fg.intent).toBe("rgb")
      expect(frame.lines[1]!.spans[0]!.fg.intent).toBe("rgb")
      // The patch's own rows are still coloured: hunk header cyan, then deletion red and addition
      // green after their dim gutters.
      expect(frame.lines[6]!.spans[0]!.fg.intent).toBe("indexed")
      expect(frame.lines[7]!.spans[1]!.fg.intent).toBe("indexed")
      expect(frame.lines[8]!.spans[1]!.fg.intent).toBe("indexed")
      expect(frame.lines[7]!.spans[1]!.fg.slot).not.toBe(frame.lines[8]!.spans[1]!.fg.slot)
      // And the band's other end — rows 9 through 40 do not exist.
      expect(frame.lines[9]!.spans[0]!.fg.intent).toBe("rgb")
    } finally {
      setup.renderer.destroy()
    }
  })
})
