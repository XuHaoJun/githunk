import { afterEach, describe, expect, test } from "bun:test"
import { TextAttributes, type RGBA } from "@opentui/core"
import { MouseButtons } from "@opentui/core/testing"
import { createShellHarness, type ShellHarness } from "../helpers/shell-harness"
import type { TempRepository } from "../helpers/temp-repository"
import type { DiffDocument } from "../../src/domain/diff/document"
import { getMainDiffLineRangeState, getMainDiffLineSelection, getMainDocument, getMainPointerSelection, virtualMainPaneFor } from "../../src/ui/panes/main-pane"
import { VIRTUAL_DIFF_LINE_THRESHOLD } from "../../src/domain/diff/virtual"
import { paneScrollbar } from "../../src/ui/panes/common"


/** The main pane's spans on `row`, clipped to its own text window, in paint order. */
function mainSpans(harness: ShellHarness, row: number): Array<{ text: string; fg: RGBA; attributes: number }> {
  const geometry = harness.app.view!.paneTextGeometry("main")!
  const line = harness.captureSpans().lines[row]
  expect(line).toBeDefined()
  const out: Array<{ text: string; fg: RGBA; attributes: number }> = []
  let x = 0
  for (const span of line!.spans) {
    const end = x + span.width - 1
    if (end >= geometry.screenX && x <= geometry.screenX + geometry.width - 1) {
      out.push({ text: span.text, fg: span.fg, attributes: span.attributes })
    }
    x = end + 1
  }
  return out
}

/** The first span on `row` whose text contains `needle`. */
function mainSpanWith(harness: ShellHarness, row: number, needle: string): { text: string; fg: RGBA; attributes: number } {
  const spans = mainSpans(harness, row)
  const found = spans.find((span) => span.text.includes(needle))
  expect(found, `no span containing ${JSON.stringify(needle)} on row ${row}: ${JSON.stringify(spans)}`).toBeDefined()
  return found!
}

function expectDefault(color: RGBA): void {
  expect(color.intent).toBe("default")
}

function expectIndexed(color: RGBA, slot: number): void {
  expect(color.intent).toBe("indexed")
  expect(color.slot).toBe(slot)
}
function mainHasSelectionBackground(harness: ShellHarness, row: number): boolean {
  const line = harness.captureSpans().lines[row]
  return line?.spans.some((span) => span.bg.intent !== "default" && span.bg.a > 0) ?? false
}


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
    const fileHeader = mainSpanWith(harness, top, "diff --git")
    expectDefault(fileHeader.fg)
    expect(fileHeader.attributes).toBe(0)
    // `index …` is metadata, dimmed but still terminal-default foreground.
    const metadata = mainSpanWith(harness, top + 1, "index ")
    expect(metadata.attributes & TextAttributes.DIM).toBe(TextAttributes.DIM)
    expectDefault(metadata.fg)
    // The `@@` header is ANSI cyan.
    const hunkHeader = mainSpanWith(harness, top + 4, "@@ -1,4 +1,3 @@")
    expectIndexed(hunkHeader.fg, 6)
    // Source lines carry a dim line-number gutter ahead of the diff body.
    expect(mainSpans(harness, top + 5)[0]!.attributes & TextAttributes.DIM).toBe(TextAttributes.DIM)
    expectIndexed(mainSpanWith(harness, top + 6, "-two").fg, 1)
    expectIndexed(mainSpanWith(harness, top + 7, "+TWO").fg, 2)
    // A context line's body stays terminal-default and unstyled.
    const context = mainSpanWith(harness, top + 8, " three")
    expectDefault(context.fg)
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
    expectDefault(header.fg)
    expect(header.attributes).toBe(0)
    const stat = mainSpanWith(harness, top + 8, "a.txt |")
    expect(stat.attributes).toBe(0)
    const statSpans = mainSpans(harness, top + 8)
    const statAdditions = statSpans.find((span) => span.text.includes("+"))
    expect(statAdditions).toBeDefined()
    expectIndexed(statAdditions!.fg, 2)
    const statDeletions = statSpans.find((span) => span.text.includes("-"))
    expect(statDeletions).toBeDefined()
    expectIndexed(statDeletions!.fg, 1)
    // The patch's own rows are styled from `diff --git` on: 11 rows of preamble in this fixture.
    expect(mainSpanWith(harness, top + 12, "index ").attributes & TextAttributes.DIM).toBe(TextAttributes.DIM)
    expectIndexed(mainSpanWith(harness, top + 15, "@@ -1,2 +1,3 @@").fg, 6)
    expectIndexed(mainSpanWith(harness, top + 17, "-two").fg, 1)
    expectIndexed(mainSpanWith(harness, top + 18, "+TWO").fg, 2)
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
    // `.` is the page scroll of the focused main view (lazygit's `ViewSelectionController`);
    // `<ctrl+d>` is the *global* scroll, and moves only `gui.scrollHeight` lines.
    for (let page = 0; page < 12; page++) await harness.pressKey(".")
    expect(harness.app.view!.mainScrollY).toBeGreaterThan(100)

    // Every row of this diff body is an addition or a deletion, so the first row of the
    // viewport must be painted — a viewport-windowed renderer that forgot to follow the
    // scroll would leave it at the default foreground.
    const top = harness.app.view!.paneTextGeometry("main")!.screenY
    const body = mainSpans(harness, top).find((span) => span.text.startsWith("+") || span.text.startsWith("-"))
    expect(body).toBeDefined()
    expect(body!.fg.intent).toBe("indexed")
    expect([1, 2]).toContain(body!.fg.slot)
  })
})

describe("main pane keyboard line ranges", () => {
  let harness: ShellHarness | undefined
  afterEach(async () => {
    await harness?.cleanup()
    harness = undefined
  })

  async function changedFileHarness(): Promise<ShellHarness> {
    return createShellHarness({
      width: 140,
      height: 30,
      setup: async (repository: TempRepository) => {
        await repository.write("a.txt", "one\ntwo\nthree\n")
        await repository.git(["add", "-A"])
        await repository.git(["commit", "-m", "base"])
        await repository.write("a.txt", "one\nTWO\nthree\n")
      },
    })
  }
  async function useUnstagedScope(): Promise<void> {
    await harness!.pressKey("]")
    await harness!.settle()
    await harness!.pressKey("]")
    await harness!.settle()
  }
  async function virtualChangedFileHarness(): Promise<ShellHarness> {
    const created = await createShellHarness({
      width: 140,
      height: 30,
      setup: async (repository: TempRepository) => {
        const lineCount = 11_000
        const original = Array.from({ length: lineCount }, (_, index) => `base ${index}`)
        const changed = original.map((line, index) => index === 0 ? `changed ${index}` : line)
        await repository.write("large.txt", `${original.join("\n")}\n`)
        await repository.git(["add", "large.txt"])
        await repository.git(["commit", "-m", "base"])
        await repository.git(["config", "diff.context", String(lineCount)])
        await repository.write("large.txt", `${changed.join("\n")}\n`)
      },
    })
    await created.pressKey("]")
    await created.settle()
    await created.pressKey("]")
    await created.settle()
    await created.pressKey("0")
    return created
  }

  async function selectFirstVirtualChange(): Promise<{ readonly document: DiffDocument; readonly startUtf16: number; readonly endUtf16: number }> {
    const view = harness!.app.view!
    const pane = view.mainPane
    const document = getMainDocument(pane)
    const virtual = virtualMainPaneFor(pane)
    expect(document).toBeDefined()
    expect(document!.lines.length).toBeGreaterThan(VIRTUAL_DIFF_LINE_THRESHOLD)
    expect(virtual?.isActive()).toBe(true)
    const layout = virtual?.layout()
    expect(pane.text.lineCount).toBeLessThanOrEqual(pane.text.height + pane.text.height * 2 + 10)
    // The native window stays bounded while the logical document stays complete: scrollHeight
    // covers every preamble row plus every parsed diff line, so no patch data is truncated.
    expect(pane.text.scrollHeight).toBe((layout?.preambleRows ?? 0) + document!.lines.length)
    expect(paneScrollbar(pane.text)?.scrollSize).toBe(pane.text.scrollHeight)
    expect(layout).toBeDefined()
    const startIndex = document!.lines.findIndex((line) => line.kind === "deletion")
    const endIndex = document!.lines.findIndex((line, index) => index > startIndex && line.kind === "addition")
    expect(startIndex).toBeGreaterThanOrEqual(0)
    expect(endIndex).toBeGreaterThan(startIndex)
    const startRow = (layout?.preambleRows ?? 0) + startIndex
    const endRow = (layout?.preambleRows ?? 0) + endIndex
    const start = layout!.rowAt(startRow)!
    const geometry = view.paneTextGeometry("main")!
    const endColumn = Math.min(geometry.width - 1, start.gutterCols + 24)
    await harness!.drag(
      geometry.screenX + start.gutterCols,
      geometry.screenY + startRow,
      geometry.screenX + endColumn,
      geometry.screenY + endRow,
    )
    const selection = getMainPointerSelection(pane)
    expect(selection?.startUtf16).toBe(document!.lines[startIndex]!.startUtf16)
    expect(selection?.endUtf16).toBe(document!.lines[endIndex]!.endUtf16)
    return { document: document!, startUtf16: selection!.startUtf16, endUtf16: selection!.endUtf16 }
  }

  test("routes a virtual mouse selection through exact raw copy and preserves it while scrolling", async () => {
    harness = await virtualChangedFileHarness()
    const view = harness.app.view!
    const selected = await selectFirstVirtualChange()
    const expected = selected.document.text.slice(selected.startUtf16, selected.endUtf16)
    view.mainPane.text.scrollY = Math.floor(view.mainPane.text.maxScrollY / 2)
    await harness.flush()
    expect(getMainPointerSelection(view.mainPane)?.startUtf16).toBe(selected.startUtf16)
    expect(getMainPointerSelection(view.mainPane)?.endUtf16).toBe(selected.endUtf16)
    view.mainPane.text.scrollY = 0
    await harness.flush()

    const copied: string[] = []
    const renderer = harness.renderer as unknown as {
      isOsc52Supported: () => boolean
      copyToClipboardOSC52: (text: string) => boolean
    }
    renderer.isOsc52Supported = () => true
    renderer.copyToClipboardOSC52 = (text) => {
      copied.push(text)
      return true
    }
    await harness.pressKey("o", { ctrl: true })
    expect(copied).toEqual([expected])
  })
  test("a non-selecting mouse down clears virtual pointer state instead of starting a range", async () => {
    harness = await virtualChangedFileHarness()
    const view = harness.app.view!
    await selectFirstVirtualChange()
    expect(getMainPointerSelection(view.mainPane)).toBeDefined()
    const geometry = view.paneTextGeometry("main")!
    // Right-button matches OpenTUI's button 0 && !ctrl selection gate: it must not create a raw
    // range, and clears any prior one like the renderer's down-clear.
    await harness.mockMouse.click(geometry.screenX + 2, geometry.screenY + 1, MouseButtons.RIGHT)
    await harness.flush()
    expect(getMainPointerSelection(view.mainPane)).toBeUndefined()
    await selectFirstVirtualChange()
    expect(getMainPointerSelection(view.mainPane)).toBeDefined()
    await harness.mockMouse.click(geometry.screenX + 2, geometry.screenY + 1, MouseButtons.LEFT, { modifiers: { ctrl: true } })
    await harness.flush()
    expect(getMainPointerSelection(view.mainPane)).toBeUndefined()
  })

  test("uses virtual raw indexes for a real stage mutation", async () => {
    harness = await virtualChangedFileHarness()
    const selected = await selectFirstVirtualChange()
    expect(selected.document.text.slice(selected.startUtf16, selected.endUtf16)).toContain("changed 0")
    expect(harness.app.controller.state.reviewTarget.kind).toBe("working-tree")
    if (harness.app.controller.state.reviewTarget.kind === "working-tree") {
      expect(harness.app.controller.state.reviewTarget.scope).toBe("unstaged")
    }
    await harness.pressKey(" ")
    await harness.settle()
    const staged = (await harness.repository.git(["diff", "--cached", "--", "large.txt"])).stdout
    expect(staged).toMatch(/^\+changed 0$/m)
  })

  test("uses virtual raw indexes for a real discard mutation", async () => {
    harness = await virtualChangedFileHarness()
    const selected = await selectFirstVirtualChange()
    expect(selected.document.text.slice(selected.startUtf16, selected.endUtf16)).toContain("changed 0")
    await harness.pressKey("d")
    expect(harness.frame()).toContain("Confirm discard")
    await harness.pressKey("d")
    await harness.settle()
    const remaining = (await harness.repository.git(["diff", "--", "large.txt"])).stdout
    expect(remaining).not.toMatch(/^\+changed 0$/m)
    expect(remaining).not.toMatch(/^\+changed 1$/m)
  })

  test("stages the correct lines from a scrolled virtual viewport", async () => {
    harness = await virtualChangedFileHarness()
    const view = harness.app.view!
    const pane = view.mainPane
    const document = getMainDocument(pane)
    const virtual = virtualMainPaneFor(pane)
    expect(document).toBeDefined()
    expect(virtual?.isActive()).toBe(true)
    const layout = virtual?.layout()
    expect(layout).toBeDefined()
    const startIndex = document!.lines.findIndex((line) => line.kind === "deletion")
    const endIndex = document!.lines.findIndex((line, index) => index > startIndex && line.kind === "addition")
    expect(startIndex).toBeGreaterThanOrEqual(0)
    expect(endIndex).toBeGreaterThan(startIndex)
    const startRow = (layout?.preambleRows ?? 0) + startIndex
    const endRow = (layout?.preambleRows ?? 0) + endIndex
    // Scroll just enough that visible rows diverge from logical rows while the
    // first change stays in view: without the adapter's +scrollY translation the
    // drag below would land two rows early on file headers.
    const scrolledY = 2
    expect(startRow).toBeGreaterThanOrEqual(scrolledY)
    pane.text.scrollY = scrolledY
    await harness.flush()
    expect(pane.text.scrollY).toBe(scrolledY)
    const geometry = view.paneTextGeometry("main")!
    const visibleStart = startRow - scrolledY
    const visibleEnd = endRow - scrolledY
    expect(visibleEnd).toBeLessThan(geometry.height)
    const start = layout!.rowAt(startRow)!
    const endColumn = Math.min(geometry.width - 1, start.gutterCols + 24)
    await harness.drag(
      geometry.screenX + start.gutterCols,
      geometry.screenY + visibleStart,
      geometry.screenX + endColumn,
      geometry.screenY + visibleEnd,
    )
    const selection = getMainPointerSelection(pane)
    expect(selection?.startUtf16).toBe(document!.lines[startIndex]!.startUtf16)
    expect(selection?.endUtf16).toBe(document!.lines[endIndex]!.endUtf16)
    await harness.pressKey(" ")
    await harness.settle()
    const staged = (await harness.repository.git(["diff", "--cached", "--", "large.txt"])).stdout
    expect(staged).toMatch(/^\+changed 0$/m)
  })


  test("selects contiguous changed lines for staging and paints the visual range", async () => {
    harness = await changedFileHarness()
    await harness.pressKey("0")
    const view = harness.app.view!
    await useUnstagedScope()
    expect(getMainDiffLineRangeState(view.mainPane)?.rangeMode).toBe("none")

    await harness.pressKey("v")
    await harness.pressKey("ARROW_DOWN", { shift: true })
    const selected = getMainDiffLineSelection(view.mainPane)
    expect(selected?.indexes.length).toBe(2)
    expect(selected?.endUtf16).toBeGreaterThan(selected?.startUtf16 ?? 0)
    const top = view.paneTextGeometry("main")!.screenY
    for (const index of selected?.indexes ?? []) expect(mainHasSelectionBackground(harness, top + index)).toBe(true)

    await harness.pressKey(" ")
    await harness.settle()
    const staged = await harness.repository.git(["diff", "--cached", "--", "a.txt"])
    expect(staged.stdout).toContain("-two")
    expect(staged.stdout).toContain("+TWO")
  })

  test("routes keyboard ranges through discard and preserves native copy text", async () => {
    harness = await changedFileHarness()
    await useUnstagedScope()
    await harness.pressKey("0")
    await harness.pressKey("ARROW_DOWN", { shift: true })
    expect(getMainDiffLineRangeState(harness.app.view!.mainPane)?.rangeMode).toBe("non-sticky")

    const copied: string[] = []
    const renderer = harness.renderer as unknown as {
      isOsc52Supported: () => boolean
      copyToClipboardOSC52: (text: string) => boolean
    }
    renderer.isOsc52Supported = () => true
    renderer.copyToClipboardOSC52 = (text) => {
      copied.push(text)
      return true
    }
    await harness.pressKey("o", { ctrl: true })
    expect(copied).toHaveLength(1)
    expect(copied[0]).toContain("-two\n+TWO\n")

    await harness.pressKey("d")
    expect(harness.frame()).toContain("Confirm discard")
    await harness.pressKey("d")
    await harness.settle()
    const worktree = await harness.repository.git(["diff", "--", "a.txt"])
    expect(worktree.stdout).not.toContain("TWO")
  })
  test("batches a keyboard range spanning multiple untracked files", async () => {
    harness = await createShellHarness({
      setup: async (repository) => {
        await repository.write("base.txt", "base\n")
        await repository.git(["add", "base.txt"])
        await repository.git(["commit", "-m", "base"])
        await repository.write("a.txt", "untracked a\n")
        await repository.write("b.txt", "untracked b\n")
      },
    })
    await useUnstagedScope()
    await harness.pressKey("0")
    await harness.pressKey("v")

    const view = harness.app.view!
    const document = getMainDocument(view.mainPane)
    expect(document).toBeDefined()
    let fileIndexes = new Set<number>()
    for (let step = 0; step < 40; step += 1) {
      const selected = getMainDiffLineSelection(view.mainPane)
      fileIndexes = new Set((selected?.indexes ?? []).flatMap((index) => {
        const fileIndex = document?.lines[index]?.fileIndex
        return fileIndex === undefined ? [] : [fileIndex]
      }))
      if (fileIndexes.size >= 2) break
      await harness.pressKey("ARROW_DOWN", { shift: true })
    }
    expect(fileIndexes.size).toBe(2)

    await harness.pressKey("d")
    expect(harness.frame()).toContain("Confirm discard")
    await harness.pressKey("d")
    await harness.settle()

    const status = (await harness.repository.git(["status", "--short"])).stdout
    expect(status).not.toContain("?? a.txt")
    expect(status).not.toContain("?? b.txt")
  })

  test("rejects a keyboard range mixing tracked and untracked files", async () => {
    harness = await createShellHarness({
      setup: async (repository) => {
        await repository.write("tracked.txt", "base\n")
        await repository.git(["add", "tracked.txt"])
        await repository.git(["commit", "-m", "base"])
        await repository.write("tracked.txt", "tracked change\n")
        await repository.write("untracked.txt", "untracked change\n")
      },
    })
    await useUnstagedScope()
    await harness.pressKey("0")
    await harness.pressKey("v")

    const view = harness.app.view!
    const document = getMainDocument(view.mainPane)
    expect(document).toBeDefined()
    let fileIndexes = new Set<number>()
    for (let step = 0; step < 40; step += 1) {
      const selected = getMainDiffLineSelection(view.mainPane)
      fileIndexes = new Set((selected?.indexes ?? []).flatMap((index) => {
        const fileIndex = document?.lines[index]?.fileIndex
        return fileIndex === undefined ? [] : [fileIndex]
      }))
      if (fileIndexes.size >= 2) break
      await harness.pressKey("ARROW_DOWN", { shift: true })
    }
    expect(fileIndexes.size).toBe(2)

    await harness.pressKey("d")
    expect(harness.frame()).toContain("tracked and untracked")
    expect(harness.app.view!.actionMenuOpen).toBe(false)
    expect((await harness.repository.git(["diff", "--", "tracked.txt"])).stdout).toContain("tracked change")
    expect((await harness.repository.git(["status", "--short"])).stdout).toContain("?? untracked.txt")
  })

  test("ordinary main movement cancels a non-sticky range", async () => {
    harness = await changedFileHarness()
    await harness.pressKey("0")
    await harness.pressKey("ARROW_DOWN", { shift: true })
    expect(getMainDiffLineRangeState(harness.app.view!.mainPane)?.rangeMode).toBe("non-sticky")
    await harness.pressKey("j")
    expect(getMainDiffLineRangeState(harness.app.view!.mainPane)?.rangeMode).toBe("none")
    expect(getMainDiffLineSelection(harness.app.view!.mainPane)).toBeUndefined()
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
    expect(harness.app.controller.state.files.length).toBe(8)
    expect(harness.app.controller.state.files.some((f) => f.path.includes("file-7"))).toBe(true)

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
