import { afterEach, describe, expect, test } from "bun:test"
import { TextAttributes } from "@opentui/core"
import { createShellHarness, type ShellHarness } from "../helpers/shell-harness"
import type { TempRepository } from "../helpers/temp-repository"

/** The main pane's spans on `row`, clipped to the pane's own text window, in paint order. */
function mainSpans(harness: ShellHarness, row: number): Array<{ text: string; fg: number[]; attributes: number }> {
  const geometry = harness.app.view!.paneTextGeometry("main")!
  const line = harness.captureSpans().lines[row]
  expect(line).toBeDefined()
  const out: Array<{ text: string; fg: number[]; attributes: number }> = []
  let x = 0
  for (const span of line!.spans) {
    const end = x + span.width - 1
    if (end >= geometry.screenX && x <= geometry.screenX + geometry.width - 1) {
      out.push({ text: span.text, fg: span.fg.toInts(), attributes: span.attributes })
    }
    x = end + 1
  }
  return out
}

/** The first span on `row` whose text is not blank padding. */
function mainSpanWith(harness: ShellHarness, row: number, needle: string): { text: string; fg: number[]; attributes: number } {
  const spans = mainSpans(harness, row)
  const found = spans.find((span) => span.text.includes(needle))
  expect(found, `no span containing ${JSON.stringify(needle)} on row ${row}: ${JSON.stringify(spans)}`).toBeDefined()
  return found!
}

const WHITE = [255, 255, 255, 255]
/** OpenTUI's `green(...)`: CSS `green`. */
const DIFF_ADDITION_FG = [0, 128, 0, 255]
/** OpenTUI's `red(...)`: CSS `red`. */
const DIFF_DELETION_FG = [255, 0, 0, 255]
/** OpenTUI's `cyan(...)`: CSS `cyan`. */
const DIFF_HUNK_HEADER_FG = [0, 255, 255, 255]

describe("main pane diff rendering", () => {
  let harness: ShellHarness | undefined
  afterEach(async () => {
    await harness?.cleanup()
    harness = undefined
  })

  test("paints lazygit's diff colours: dim gutter and metadata, cyan hunk header, green additions, red deletions", async () => {
    harness = await createShellHarness({
      width: 140,
      height: 30,
      setup: async (repository: TempRepository) => {
        await repository.write("a.txt", "one\ntwo\nthree\nfour\n")
        await repository.git(["add", "-A"])
        await repository.git(["commit", "-m", "base"])
        await repository.write("a.txt", "one\nTWO\nthree\n")
      },
    })
    await harness.pressKey("2")

    const top = harness.app.view!.paneTextGeometry("main")!.screenY
    // `diff --git` is a file header: default foreground, no attributes.
    const fileHeader = mainSpanWith(harness, top, "diff --git")
    expect(fileHeader.fg).toEqual(WHITE)
    expect(fileHeader.attributes).toBe(0)
    // `index …` is metadata: dim, default foreground.
    const metadata = mainSpanWith(harness, top + 1, "index ")
    expect(metadata.attributes & TextAttributes.DIM).toBe(TextAttributes.DIM)
    expect(metadata.fg).toEqual(WHITE)
    // The `@@` header is cyan.
    expect(mainSpanWith(harness, top + 4, "@@ -1,4 +1,3 @@").fg).toEqual(DIFF_HUNK_HEADER_FG)
    // Source lines carry a dim line-number gutter ahead of the diff body.
    expect(mainSpans(harness, top + 5)[0]!.attributes & TextAttributes.DIM).toBe(TextAttributes.DIM)
    expect(mainSpanWith(harness, top + 6, "-two").fg).toEqual(DIFF_DELETION_FG)
    expect(mainSpanWith(harness, top + 7, "+TWO").fg).toEqual(DIFF_ADDITION_FG)
    // A context line's body stays unstyled.
    const context = mainSpanWith(harness, top + 8, " three")
    expect(context.fg).toEqual(WHITE)
    expect(context.attributes).toBe(0)
  })

  test("offsets a commit preview's colours by its preamble", async () => {
    harness = await createShellHarness({
      width: 140,
      height: 30,
      setup: async (repository: TempRepository) => {
        await repository.write("a.txt", "one\ntwo\n")
        await repository.git(["add", "-A"])
        await repository.git(["commit", "-m", "base"])
        await repository.write("a.txt", "one\nTWO\nthree\n")
        await repository.git(["add", "-A"])
        await repository.git(["commit", "-m", "second change"])
      },
    })
    await harness.pressKey("4")
    await harness.app.view!.whenPreviewSettled()
    await harness.flush()

    const top = harness.app.view!.paneTextGeometry("main")!.screenY
    // `git show`'s header and stat come before the patch, and carry no diff styling.
    const header = mainSpanWith(harness, top, "commit ")
    expect(header.fg).toEqual(WHITE)
    expect(header.attributes).toBe(0)
    const stat = mainSpanWith(harness, top + 8, "a.txt |")
    expect(stat.attributes).toBe(0)
    // The patch's own rows are styled from `diff --git` on: 11 rows of preamble in this fixture.
    expect(mainSpanWith(harness, top + 12, "index ").attributes & TextAttributes.DIM).toBe(TextAttributes.DIM)
    expect(mainSpanWith(harness, top + 15, "@@ -1,2 +1,3 @@").fg).toEqual(DIFF_HUNK_HEADER_FG)
    expect(mainSpanWith(harness, top + 17, "-two").fg).toEqual(DIFF_DELETION_FG)
    expect(mainSpanWith(harness, top + 18, "+TWO").fg).toEqual(DIFF_ADDITION_FG)
    expect(mainSpans(harness, top + 18)[0]!.attributes & TextAttributes.DIM).toBe(TextAttributes.DIM)
  })

  test("keeps painting diff colours after scrolling deep into a long diff", async () => {
    harness = await createShellHarness({
      width: 140,
      height: 30,
      setup: async (repository: TempRepository) => {
        await repository.write("a.txt", Array.from({ length: 400 }, (_, i) => `line ${i}`).join("\n") + "\n")
        await repository.git(["add", "-A"])
        await repository.git(["commit", "-m", "base"])
        await repository.write("a.txt", Array.from({ length: 400 }, (_, i) => `line ${i} changed`).join("\n") + "\n")
      },
    })
    await harness.pressKey("2")
    await harness.pressKey("0")
    for (let page = 0; page < 12; page++) await harness.pressKey("d", { ctrl: true })
    expect(harness.app.view!.mainScrollY).toBeGreaterThan(100)

    // Every row of this diff body is an addition or a deletion, so the first row of the
    // viewport must be painted — a viewport-windowed renderer that forgot to follow the
    // scroll would leave it at the default foreground.
    const top = harness.app.view!.paneTextGeometry("main")!.screenY
    const body = mainSpans(harness, top).find((span) => span.text.startsWith("+") || span.text.startsWith("-"))
    expect(body).toBeDefined()
    expect([DIFF_ADDITION_FG, DIFF_DELETION_FG]).toContainEqual(body!.fg)
  })
})

describe("main pane install cost", () => {
  let harness: ShellHarness | undefined
  afterEach(async () => {
    await harness?.cleanup()
    harness = undefined
  })

  /** Focusing panel 2 re-renders the working-tree patch into the main pane. */
  test("focusing the files panel stays responsive on a multi-thousand-line diff", async () => {
    harness = await createShellHarness({
      width: 140,
      height: 40,
      setup: async (repository: TempRepository) => {
        for (let file = 0; file < 8; file++) {
          await repository.write(`src/file-${file}.ts`, Array.from({ length: 250 }, (_, i) => `const value${i} = ${i} // original padding padding`).join("\n") + "\n")
        }
        await repository.git(["add", "-A"])
        await repository.git(["commit", "-m", "base"])
        for (let file = 0; file < 8; file++) {
          await repository.write(`src/file-${file}.ts`, Array.from({ length: 250 }, (_, i) => `const value${i} = ${i} // ${i % 3 === 0 ? "changed" : "original"} padding padding`).join("\n") + "\n")
        }
      },
    })
    const view = harness.app.view!
    expect(harness.frame()).toContain("file-7.ts")

    const focus = (id: "files" | "stash"): number => {
      const started = performance.now()
      view.focusManager.focus(id)
      return performance.now() - started
    }

    // Warm both directions once, then measure. The budget is deliberately loose: the point is
    // that the cost no longer scales with the size of the patch (this diff took ~1.1s per
    // focus while the whole patch was pushed through OpenTUI as one chunk per rendered line).
    focus("files")
    focus("stash")
    const first = focus("files")
    focus("stash")
    const second = focus("files")
    const refocus = focus("files")

    expect(first).toBeLessThan(200)
    expect(second).toBeLessThan(200)
    expect(refocus).toBeLessThan(200)
  })

  /**
   * One big file is the case a per-file diff cannot make smaller, so every step that touches the
   * patch has to stay proportional to the viewport instead of the patch.
   */
  test("stays responsive on a single very large file", async () => {
    const lines = 20000
    harness = await createShellHarness({
      width: 140,
      height: 40,
      setup: async (repository: TempRepository) => {
        await repository.write("small.txt", "hello\n")
        await repository.write("big.txt", Array.from({ length: lines }, (_, i) => `line ${i} original content padding padding`).join("\n") + "\n")
        await repository.git(["add", "-A"])
        await repository.git(["commit", "-m", "base"])
        await repository.write("big.txt", Array.from({ length: lines }, (_, i) => `line ${i} ${i % 4 === 0 ? "CHANGED" : "original"} content padding padding`).join("\n") + "\n")
        await repository.write("small.txt", "hello world\n")
      },
    })
    const view = harness.app.view!
    await harness.pressKey("2")

    const measure = async (label: string, fn: () => unknown): Promise<number> => {
      const started = performance.now()
      await fn()
      const elapsed = performance.now() - started
      expect(elapsed, `${label} took ${elapsed.toFixed(0)}ms`).toBeLessThan(250)
      return elapsed
    }

    // A model update repaints every pane, so nothing it touches may walk the whole patch.
    await measure("view.update", () => { view.update(harness!.app.controller.state) })
    // Moving the cursor between files re-presents the main pane.
    await measure("select next file", () => harness!.pressKey("j"))
    await measure("select previous file", () => harness!.pressKey("k"))
    // Scroll cost is asserted in tests/ui/diff-text.test.ts, where no frame pacing is in the way.
  })
})
