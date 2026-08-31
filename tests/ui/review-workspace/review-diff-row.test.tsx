import { describe, expect, test } from "bun:test"
import { testRender } from "@opentui/react/test-utils"
import { act } from "react"
import { ReviewDiffRow } from "../../../src/ui/review-workspace/components/ReviewDiffRow"
import { hunkDiffAddresses } from "../../../src/ui/review-workspace/hunk-diff-row-model"

type CapturedColor = Readonly<{ toInts: () => readonly number[] }>
type CapturedSpan = Readonly<{ text: string; bg?: CapturedColor }>
type CapturedSetup = Readonly<{
  captureSpans: () => Readonly<{ lines: readonly Readonly<{ spans: readonly CapturedSpan[] }>[] }>
}>

type LayoutNode = Readonly<{
  x: number
  width: number
  _childrenInLayoutOrder?: readonly LayoutNode[]
}>

function textSpan(setup: CapturedSetup, text: string) {
  return setup.captureSpans().lines.flatMap((line) => line.spans).find((span) => span.text.includes(text))
}

function rgb(color: CapturedColor | undefined) {
  return color?.toInts().slice(0, 3)
}

const splitRow: Extract<HunkDiffRow, { type: "split-line" }> = {
  type: "split-line",
  key: "parity:split",
  fileKey: "parity",
  hunkIndex: 0,
  left: { kind: "deletion", sign: "-", lineNumber: 1, spans: [{ text: "old" }] },
  right: { kind: "addition", sign: "+", lineNumber: 1, spans: [{ text: "new" }] },
}
const emptySplitRow: Extract<HunkDiffRow, { type: "split-line" }> = {
  type: "split-line",
  key: "parity:empty",
  fileKey: "parity",
  hunkIndex: 0,
  left: { kind: "empty", sign: " ", lineNumber: 42, spans: [{ text: "gap" }] },
  right: { kind: "context", sign: " ", lineNumber: 42, spans: [{ text: "same" }] },
}

const emptyAdditionSplitRow: Extract<HunkDiffRow, { type: "split-line" }> = {
  type: "split-line",
  key: "parity:empty-addition",
  fileKey: "parity",
  hunkIndex: 0,
  left: { kind: "context", sign: " ", lineNumber: 1, spans: [{ text: "before\n" }] },
  right: { kind: "addition", sign: "+", lineNumber: 1, spans: [{ text: "\n" }] },
}

const stackRow: Extract<HunkDiffRow, { type: "stack-line" }> = {
  type: "stack-line",
  key: "parity:stack",
  fileKey: "parity",
  hunkIndex: 0,
  cell: { kind: "addition", sign: "+", newLineNumber: 1, spans: [{ text: "new" }] },
}

async function renderRow(row: HunkDiffRow, selected = false, showLineNumbers = false) {
  const setup = await testRender(
    <ReviewDiffRow row={row} width={40} digits={1} showLineNumbers={showLineNumbers} selected={selected} />,
    { width: 40, height: 2 },
  )
  await act(async () => {
    await setup.renderOnce()
  })
  return setup
}

describe("Review diff row parity", () => {
  test("paints hunk patch backgrounds on split additions and deletions", async () => {
    const setup = await renderRow(splitRow)
    try {
      expect(rgb(textSpan(setup, "old")?.bg)).toEqual([60, 30, 33])
      expect(rgb(textSpan(setup, "new")?.bg)).toEqual([23, 51, 34])
    } finally {
      await act(async () => setup.renderer.destroy())
    }
  })

  test("paints hunk patch background on stack additions", async () => {
    const setup = await renderRow(stackRow)
    try {
      expect(rgb(textSpan(setup, "new")?.bg)).toEqual([23, 51, 34])
    } finally {
      await act(async () => setup.renderer.destroy())
    }
  })

  test("keeps empty split gutters on the editor surface", async () => {
    const setup = await renderRow(emptySplitRow, false, true)
    try {
      expect(rgb(textSpan(setup, "gap")?.bg)).toEqual([39, 43, 49])
      expect(rgb(textSpan(setup, "same")?.bg)).toEqual([13, 17, 23])
      expect(rgb(textSpan(setup, "42 ")?.bg)).toEqual([13, 17, 23])
    } finally {
      await act(async () => setup.renderer.destroy())
    }
  })

  test("keeps split panes aligned when an added line is empty", async () => {
    const setup = await renderRow(emptyAdditionSplitRow, true, true)
    try {
      const root = setup.renderer.root as unknown as LayoutNode
      const panes = root._childrenInLayoutOrder?.[0]?._childrenInLayoutOrder ?? []
      expect(panes.map((pane) => ({ x: pane.x, width: pane.width }))).toEqual([
        { x: 0, width: 20 },
        { x: 20, width: 20 },
      ])
    } finally {
      await act(async () => setup.renderer.destroy())
    }
  })

  test("extracts only real source addresses and keeps both split sides", () => {
    expect(hunkDiffAddresses(splitRow)).toEqual([
      { fileKey: "parity", hunkIndex: 0, side: "old", line: 1 },
      { fileKey: "parity", hunkIndex: 0, side: "new", line: 1 },
    ])
    expect(hunkDiffAddresses(emptySplitRow)).toEqual([
      { fileKey: "parity", hunkIndex: 0, side: "new", line: 42 },
    ])
    expect(hunkDiffAddresses({
      type: "collapsed",
      key: "parity:gap",
      fileKey: "parity",
      hunkIndex: 0,
      gapId: "before:1",
      lineCount: 1,
      oldRange: [1, 1],
      newRange: [1, 1],
      expanded: false,
      text: "gap",
    })).toEqual([])
    expect(hunkDiffAddresses({
      type: "hunk-header",
      key: "parity:header",
      fileKey: "parity",
      hunkIndex: 0,
      text: "@@",
    })).toEqual([])
    expect(hunkDiffAddresses(stackRow)).toEqual([
      { fileKey: "parity", hunkIndex: 0, side: "new", line: 1 },
    ])
    expect(hunkDiffAddresses({
      type: "stack-line",
      key: "parity:stack-context",
      fileKey: "parity",
      hunkIndex: 0,
      cell: { kind: "context", sign: " ", oldLineNumber: 7, newLineNumber: 8, spans: [{ text: "same" }] },
    })).toEqual([
      { fileKey: "parity", hunkIndex: 0, side: "old", line: 7 },
      { fileKey: "parity", hunkIndex: 0, side: "new", line: 8 },
    ])
  })

  test("paints a selected background into the generated StyledText", async () => {
    const setup = await renderRow(splitRow, true)
    try {
      expect(rgb(textSpan(setup, "old")?.bg)).toEqual([38, 79, 120])
      expect(rgb(textSpan(setup, "new")?.bg)).toEqual([38, 79, 120])
    } finally {
      await act(async () => setup.renderer.destroy())
    }
  })
})
