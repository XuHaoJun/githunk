import { describe, expect, test } from "bun:test"
import { createTestRenderer } from "@opentui/core/testing"
import { createMainPane, getMainDiffLineSelection, getMainSelection, getMainSelectionProjection, installMainContent, resolveMainNativeSelection, setMainDiffLineRangeState, setMainDocumentSelection, virtualMainPaneFor } from "../../src/ui/panes/main-pane"
import { parseDiff } from "../../src/domain/diff/parse"
import { createDiffLineRangeState, toggleDiffLineRange } from "../../src/domain/diff/line-selection"
import { VIRTUAL_DIFF_LINE_THRESHOLD } from "../../src/domain/diff/virtual"
import { isVirtualDiffDocument } from "../../src/ui/panes/virtual-main-pane"
import type { MainPaneContent } from "../../src/ui/panes/main-pane"
import type { DiffDocument } from "../../src/domain/diff/document"
import type { AppModel } from "../../src/app/model"

function model(): AppModel {
  return { repositoryRoot: "", branch: undefined, headOid: undefined, selectedCommitOid: undefined, commits: [], branches: [], remotes: [], tags: [], stashes: [], files: [], activeTab: "files" } as unknown as AppModel
}

function patchText(lines: number, lineWidth = 0, wide = false): string {
  const body = Array.from({ length: lines }, (_, index) => `+${wide ? "界" : ""}${"x".repeat(lineWidth)}line ${index}`)
  return [
    "diff --git a/large.txt b/large.txt",
    "index 1111111..2222222 100644",
    "--- a/large.txt",
    "+++ b/large.txt",
    `@@ -1,${lines} +1,${lines} @@`,
    ...body,
    "",
  ].join("\n")
}

function content(document: DiffDocument): MainPaneContent {
  return { source: "files", stableId: "large", label: "large", document }
}

describe("main pane virtual diff viewport", () => {
  test("keeps the native text window bounded while logical metrics cover the document", async () => {
    const setup = await createTestRenderer({ width: 120, height: 40 })
    try {
      const pane = createMainPane(setup.renderer, model())
      setup.renderer.root.add(pane.box)
      const document = parseDiff(patchText(VIRTUAL_DIFF_LINE_THRESHOLD + 20, 100))
      installMainContent(pane, content(document), false)
      await setup.flush()

      expect(isVirtualDiffDocument(document)).toBe(true)
      expect(pane.text.lineCount).toBeLessThanOrEqual(pane.text.height + pane.text.height * 2 + 10)
      expect(pane.text.scrollHeight).toBe(document.lines.length)

      pane.text.scrollY = pane.text.maxScrollY
      await setup.flush()
      expect(pane.text.scrollY).toBe(pane.text.maxScrollY)
      expect(pane.text.plainText).toContain(`+${"x".repeat(100)}line ${VIRTUAL_DIFF_LINE_THRESHOLD + 19}`)
      expect(pane.text.maxScrollX).toBeGreaterThan(0)
      pane.text.scrollX = pane.text.maxScrollX
      await setup.flush()
      expect(pane.text.scrollX).toBe(pane.text.maxScrollX)
    } finally {
      setup.renderer.destroy()
    }
  })
  test("does not rebuild an unchanged virtual layout", async () => {
    const setup = await createTestRenderer({ width: 120, height: 40 })
    try {
      const pane = createMainPane(setup.renderer, model())
      setup.renderer.root.add(pane.box)
      const document = parseDiff(patchText(VIRTUAL_DIFF_LINE_THRESHOLD + 20))
      installMainContent(pane, content(document), false)
      const layout = virtualMainPaneFor(pane)?.layout()
      installMainContent(pane, content(document), false)
      expect(layout).toBeDefined()
      expect(virtualMainPaneFor(pane)?.layout()).toBe(layout)
    } finally {
      setup.renderer.destroy()
    }
  })


  test("preserves raw line-range selection while scrolling away from it", async () => {
    const setup = await createTestRenderer({ width: 120, height: 40 })
    try {
      const pane = createMainPane(setup.renderer, model())
      setup.renderer.root.add(pane.box)
      const document = parseDiff(patchText(VIRTUAL_DIFF_LINE_THRESHOLD + 20))
      installMainContent(pane, content(document), false)
      await setup.flush()

      const state = toggleDiffLineRange(createDiffLineRangeState(document))
      setMainDiffLineRangeState(pane, state)
      const selectedLine = document.lines[state.selectedIndex]!
      const selection = getMainDiffLineSelection(pane)
      expect(selection?.startUtf16).toBe(selectedLine.startUtf16)
      expect(selection?.endUtf16).toBe(selectedLine.endUtf16)

      pane.text.scrollY = pane.text.maxScrollY
      await setup.flush()
      expect(getMainDiffLineSelection(pane)?.startUtf16).toBe(selection?.startUtf16)
      expect(getMainDiffLineSelection(pane)?.endUtf16).toBe(selection?.endUtf16)
      setMainDiffLineRangeState(pane, createDiffLineRangeState(document))
      expect(getMainDiffLineSelection(pane)).toBeUndefined()
    } finally {
      setup.renderer.destroy()
    }
  })


  test("includes a long preamble in virtual horizontal metrics", async () => {
    const setup = await createTestRenderer({ width: 120, height: 40 })
    try {
      const pane = createMainPane(setup.renderer, model())
      setup.renderer.root.add(pane.box)
      const document = parseDiff(patchText(VIRTUAL_DIFF_LINE_THRESHOLD + 20))
      const preamble = "p".repeat(200)
      installMainContent(pane, { ...content(document), preamble }, false)
      await setup.flush()

      const virtual = virtualMainPaneFor(pane)
      expect(virtual?.layout()?.contentWidth).toBe(preamble.length)
      expect(pane.text.scrollWidth).toBe(preamble.length)
      expect(pane.text.maxScrollX).toBeGreaterThan(0)
    } finally {
      setup.renderer.destroy()
    }
  })

  test("keeps stat highlights after the preamble separator scrolls out", async () => {
    const setup = await createTestRenderer({ width: 120, height: 40 })
    try {
      const pane = createMainPane(setup.renderer, model())
      setup.renderer.root.add(pane.box)
      const document = parseDiff(patchText(VIRTUAL_DIFF_LINE_THRESHOLD + 20))
      const statRows = Array.from({ length: 100 }, (_, index) => ` file-${index}.txt | 1 +`)
      const preamble = ["commit abc", "---", ...statRows, " 100 files changed, 100 insertions(+)"].join("\n")
      installMainContent(pane, { ...content(document), preamble }, false)
      await setup.flush()

      pane.text.scrollY = 60
      await setup.flush()
      const frame = setup.captureSpans()
      const statLine = frame.lines.find((line) => line.spans.some((span) => span.text.includes("file-60.txt")))
      expect(statLine).toBeDefined()
      expect(statLine!.spans.some((span) => span.fg.intent === "indexed")).toBe(true)
    } finally {
      setup.renderer.destroy()
    }
  })

  test("keeps the eager renderer for documents at or below the threshold", async () => {
    const setup = await createTestRenderer({ width: 120, height: 40 })
    try {
      const pane = createMainPane(setup.renderer, model())
      setup.renderer.root.add(pane.box)
      const document = parseDiff(patchText(VIRTUAL_DIFF_LINE_THRESHOLD - 5))
      installMainContent(pane, content(document), false)
      await setup.flush()

      expect(isVirtualDiffDocument(document)).toBe(false)
      expect(pane.text.lineCount).toBeGreaterThan(document.lines.length - 1)
      expect(pane.text.plainText).toContain(`+line ${VIRTUAL_DIFF_LINE_THRESHOLD - 6}`)
    } finally {
      setup.renderer.destroy()
    }
  })

  test("virtualizes only above exactly 10,000 parsed lines", async () => {
    // patchText carries 5 header rows, so body N-5 parses to exactly N lines.
    const atThreshold = parseDiff(patchText(VIRTUAL_DIFF_LINE_THRESHOLD - 5))
    expect(atThreshold.lines.length).toBe(VIRTUAL_DIFF_LINE_THRESHOLD)
    expect(isVirtualDiffDocument(atThreshold)).toBe(false)
    const above = parseDiff(patchText(VIRTUAL_DIFF_LINE_THRESHOLD - 4))
    expect(above.lines.length).toBe(VIRTUAL_DIFF_LINE_THRESHOLD + 1)
    expect(isVirtualDiffDocument(above)).toBe(true)

    const setup = await createTestRenderer({ width: 120, height: 40 })
    try {
      const pane = createMainPane(setup.renderer, model())
      setup.renderer.root.add(pane.box)
      installMainContent(pane, { ...content(atThreshold), stableId: "boundary-eager" }, false)
      await setup.flush()
      expect(virtualMainPaneFor(pane)?.isActive()).toBe(false)
      expect(pane.text.lineCount).toBeGreaterThan(atThreshold.lines.length - 1)

      installMainContent(pane, { ...content(above), stableId: "boundary-virtual" }, false)
      await setup.flush()
      expect(virtualMainPaneFor(pane)?.isActive()).toBe(true)
      expect(pane.text.lineCount).toBeLessThanOrEqual(pane.text.height + pane.text.height * 2 + 10)
      expect(pane.text.scrollHeight).toBe(above.lines.length)
    } finally {
      setup.renderer.destroy()
    }
  })
  test("publishes the exact bounded projection and carries document selections across windows", async () => {
    const setup = await createTestRenderer({ width: 120, height: 40 })
    try {
      const pane = createMainPane(setup.renderer, model())
      setup.renderer.root.add(pane.box)
      const document = parseDiff(patchText(VIRTUAL_DIFF_LINE_THRESHOLD + 20))
      installMainContent(pane, { ...content(document), preamble: "commit abc\n" }, false)
      await setup.flush()

      const first = getMainSelectionProjection(pane)
      expect(first?.text).toBe(pane.text.plainText)
      expect(first?.segments[0]?.displayStartUtf16).toBe(0)
      expect(first?.segments.at(-1)?.displayEndUtf16).toBe(first?.text.length)
      for (let index = 1; index < (first?.segments.length ?? 0); index += 1) {
        expect(first?.segments[index]?.displayStartUtf16).toBe(first?.segments[index - 1]?.displayEndUtf16)
      }

      const generation = first?.generation ?? 0
      pane.text.scrollY = Math.floor(pane.text.scrollHeight / 2)
      await setup.flush()
      const middle = getMainSelectionProjection(pane)
      expect(middle?.generation).toBeGreaterThan(generation)
      expect(middle?.text).toBe(pane.text.plainText)

      const selected = {
        valid: true as const,
        startUtf16: document.lines[6]!.startUtf16,
        endUtf16: document.lines[6]!.endUtf16,
        active: true as const,
      }
      setMainDocumentSelection(pane, selected)
      pane.text.scrollY = pane.text.maxScrollY
      await setup.flush()
      expect(getMainSelection(pane)).toEqual({ valid: true, kind: "document", selection: selected })

      pane.text.scrollY = 0
      await setup.flush()
      ;(pane.text as unknown as { setSelection(start: number, end: number): void }).setSelection(0, 5)
      expect(resolveMainNativeSelection(pane)).toEqual({ valid: true, kind: "text", text: "commi" })
      pane.text.scrollY = pane.text.maxScrollY
      await setup.flush()
      expect(getMainSelection(pane)).toBeUndefined()
    } finally {
      setup.renderer.destroy()
    }
  })
  test("does not turn a zero-length native click into an active semantic selection", async () => {
    const setup = await createTestRenderer({ width: 120, height: 40 })
    try {
      const pane = createMainPane(setup.renderer, model())
      setup.renderer.root.add(pane.box)
      const document = parseDiff(patchText(4))
      installMainContent(pane, content(document), false)
      await setup.flush()
      ;(pane.text as unknown as { setSelection(start: number, end: number): void }).setSelection(0, 0)
      expect(resolveMainNativeSelection(pane)).toBeUndefined()
      expect(getMainSelection(pane)).toBeUndefined()
    } finally {
      setup.renderer.destroy()
    }
  })
  test("clears a stored semantic selection when the native range disappears", async () => {
    const setup = await createTestRenderer({ width: 120, height: 40 })
    try {
      const pane = createMainPane(setup.renderer, model())
      setup.renderer.root.add(pane.box)
      const document = parseDiff(patchText(4))
      installMainContent(pane, content(document), false)
      await setup.flush()
      setMainDocumentSelection(pane, {
        valid: true,
        startUtf16: document.lines[0]!.startUtf16,
        endUtf16: document.lines[0]!.endUtf16,
        active: true,
      })
      expect(getMainSelection(pane)).toBeDefined()
      ;(pane.text as unknown as { resetSelection(): void }).resetSelection()
      expect(resolveMainNativeSelection(pane)).toBeUndefined()
      expect(getMainSelection(pane)).toBeUndefined()
    } finally {
      setup.renderer.destroy()
    }
  })
})
