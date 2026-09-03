import { describe, expect, test } from "bun:test"
import { createTestRenderer } from "@opentui/core/testing"
import { createMainPane, getMainDiffLineSelection, getMainPointerSelection, installMainContent, setMainDiffLineRangeState, virtualMainPaneFor } from "../../src/ui/panes/main-pane"
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
      expect(getMainPointerSelection(pane)).toBeUndefined()
    } finally {
      setup.renderer.destroy()
    }
  })

  test("maps middle-window pointer rows to raw document selections", async () => {
    const setup = await createTestRenderer({ width: 120, height: 40 })
    try {
      const pane = createMainPane(setup.renderer, model())
      setup.renderer.root.add(pane.box)
      const document = parseDiff(patchText(VIRTUAL_DIFF_LINE_THRESHOLD + 20, 0, true))
      installMainContent(pane, content(document), false)
      await setup.flush()

      const logicalRow = Math.floor(document.lines.length / 2)
      pane.text.scrollY = logicalRow
      await setup.flush()
      expect(pane.text.plainText).toContain(`+界line ${logicalRow - 5}`)

      const virtual = virtualMainPaneFor(pane)
      const row = virtual?.layout()?.rowAt(logicalRow)
      const pointerSelection = virtual?.setPointerSelection(0, row?.gutterCols ?? 0, 0, (row?.gutterCols ?? 0) + 3)
      expect(pointerSelection?.startUtf16).toBe(document.lines[logicalRow]?.startUtf16)
      expect(getMainPointerSelection(pane)?.startUtf16).toBe(pointerSelection?.startUtf16)
      const nativeSelection = (pane.text as unknown as { textBufferView?: { getSelection?: () => { readonly start: number; readonly end: number } | null; getSelectedText?: () => string } }).textBufferView?.getSelection?.()
      const window = virtual?.layout()?.window(logicalRow, pane.text.height, Math.max(10, Math.floor(pane.text.height)))
      const expectedNativeStart = (logicalRow - (window?.[0] ?? logicalRow)) * ((virtual?.layout()?.contentWidth ?? 0) + 1)
      expect(nativeSelection?.start).toBe(expectedNativeStart)
      expect(nativeSelection?.end).toBeGreaterThan(nativeSelection?.start ?? 0)
      expect((pane.text as unknown as { textBufferView?: { getSelectedText?: () => string } }).textBufferView?.getSelectedText?.()).toContain("界")
      installMainContent(pane, content(document), false)
      expect(getMainPointerSelection(pane)?.startUtf16).toBe(pointerSelection?.startUtf16)
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
})
