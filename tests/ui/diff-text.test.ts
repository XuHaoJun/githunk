import { describe, expect, test } from "bun:test"
import { TextRenderable } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import { parseDiff } from "../../src/domain/diff/parse"
import { renderDiff } from "../../src/domain/diff/render"
import { installDiffText } from "../../src/ui/panes/diff-text"
import { paneTextBuffer } from "../../src/ui/panes/pane-text"

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

/**
 * Average wall time of one width-change frame — a horizontal splitter drag — with the painter
 * installed or with the same text written straight into the buffer and nothing following the
 * viewport.
 */
async function millisecondsPerDragFrame(lines: number, painted: boolean): Promise<number> {
  const setup = await createTestRenderer({ width: 120, height: 40 })
  try {
    const text = new TextRenderable(setup.renderer, { id: "main-text", content: "", width: 118, height: 38, selectable: true })
    setup.renderer.root.add(text)
    text.wrapMode = "char"
    const rendered = renderDiff(parseDiff(patchText(lines)))
    if (painted) installDiffText(text, { preamble: "", body: rendered.displayText, displayLines: rendered.displayLines })
    else paneTextBuffer(text)!.setText(rendered.displayText)
    await setup.flush()
    const steps = 20
    const started = performance.now()
    for (let step = 0; step < steps; step++) {
      text.width = 118 - step
      await setup.flush()
    }
    return (performance.now() - started) / steps
  } finally {
    setup.renderer.destroy()
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

      // A no-op re-install should cost microseconds (an early-return content check, nothing more),
      // so 20 of them finishing well under a real install's own budget (250ms above) still catches
      // a regression that made re-installing redo the paint: that would cost on the order of a
      // single full install per repeat, i.e. tens of ms *each*, blowing past this by 10x or more.
      // The bare `< 20` bound this replaced failed spuriously twice across ~22 full-suite runs —
      // scheduler/GC jitter, not a regression — which is exactly what CLAUDE.md's "never commit
      // red" gate should not tolerate from a flake.
      expect(elapsed, `20 re-installs took ${elapsed.toFixed(1)}ms`).toBeLessThan(150)
      expect(pane.text.scrollY).toBe(500)
    } finally {
      pane.destroy()
    }
  })
  test("colours stat graphs and binary sizes without matching commit text", async () => {
    const setup = await createTestRenderer({ width: 120, height: 20 })
    try {
      const text = new TextRenderable(setup.renderer, { id: "main-text", content: "", width: 118, height: 18, selectable: true })
      setup.renderer.root.add(text)
      text.wrapMode = "char"
      const preamble = [
        "commit abc",
        "",
        "    release | 1 +-",
        "",
        "---",
        " src/中.txt | 2 +-",
        " data.bin | Bin 9 -> 16 bytes",
        " mode.bin | Bin",
        " 3 files changed, 1 insertion(+), 1 deletion(-)",
        "",
      ].join("\n")
      const rendered = renderDiff(parseDiff(patchText(1)))
      installDiffText(text, { preamble, body: rendered.displayText, displayLines: rendered.displayLines })
      await setup.flush()

      const frame = setup.captureSpans()
      const spanWith = (row: number, needle: string) => frame.lines[row]!.spans.find((span) => span.text.includes(needle))
      expect(frame.lines[2]!.spans.some((span) => span.fg.intent === "indexed")).toBe(false)
      const statAddition = spanWith(5, "+")
      expect(statAddition).toBeDefined()
      expect(statAddition!.fg.intent).toBe("indexed")
      expect(statAddition!.fg.slot).toBe(2)
      const statDeletion = spanWith(5, "-")
      expect(statDeletion).toBeDefined()
      expect(statDeletion!.fg.intent).toBe("indexed")
      expect(statDeletion!.fg.slot).toBe(1)
      const binaryOld = spanWith(6, "9")
      expect(binaryOld).toBeDefined()
      expect(binaryOld!.fg.intent).toBe("indexed")
      expect(binaryOld!.fg.slot).toBe(1)
      const binaryNew = spanWith(6, "16")
      expect(binaryNew).toBeDefined()
      expect(binaryNew!.fg.intent).toBe("indexed")
      expect(binaryNew!.fg.slot).toBe(2)
      expect(frame.lines[7]!.spans.some((span) => span.fg.intent === "indexed")).toBe(false)
    } finally {
      setup.renderer.destroy()
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

describe("diff text under a splitter drag", () => {
  test("a drag frame costs no more with the painter than without one", async () => {
    // The width guard in ./viewport-highlights re-materialises the row-to-line map once per distinct
    // width, which during a drag is once per frame. What this measures is whether the *document*
    // enters that per-frame cost: a painter repainting all 20k lines would cost ~1s a frame, orders
    // of magnitude over the baseline. What it deliberately does not resolve is the map itself —
    // OpenTUI re-wraps the whole document on a width change either way, and at 60fps the renderer's
    // own frame cadence is ~16ms, so the map's few milliseconds are invisible here. That cost is
    // known, accepted and documented at the guard; this test is the bound on the rest.
    const plain = await millisecondsPerDragFrame(20000, false)
    const withPainter = await millisecondsPerDragFrame(20000, true)
    expect(withPainter, `${withPainter.toFixed(1)}ms per drag frame painted vs ${plain.toFixed(1)}ms plain`).toBeLessThan(plain * 2 + 6)
  })
})
