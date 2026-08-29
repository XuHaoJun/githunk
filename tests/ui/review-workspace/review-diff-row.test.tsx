import { describe, expect, test } from "bun:test"
import { testRender } from "@opentui/react/test-utils"
import { act } from "react"
import { ReviewDiffRow } from "../../../src/ui/review-workspace/components/ReviewDiffRow"
import type { HunkDiffRow } from "../../../src/ui/review-workspace/hunk-diff-row-model"

type CapturedColor = Readonly<{ toInts: () => readonly number[] }>
type CapturedSpan = Readonly<{ text: string; bg?: CapturedColor }>
type CapturedSetup = Readonly<{
  captureSpans: () => Readonly<{ lines: readonly Readonly<{ spans: readonly CapturedSpan[] }>[] }>
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
    const setup = await renderRow(splitRow, true)
    try {
      expect(rgb(textSpan(setup, "old")?.bg)).toEqual([60, 30, 33])
      expect(rgb(textSpan(setup, "new")?.bg)).toEqual([23, 51, 34])
    } finally {
      await act(async () => setup.renderer.destroy())
    }
  })

  test("paints hunk patch background on stack additions", async () => {
    const setup = await renderRow(stackRow, true)
    try {
      expect(rgb(textSpan(setup, "new")?.bg)).toEqual([23, 51, 34])
    } finally {
      await act(async () => setup.renderer.destroy())
    }
  })

  test("keeps empty split gutters on the editor surface", async () => {
    const setup = await renderRow(emptySplitRow, true, true)
    try {
      expect(rgb(textSpan(setup, "gap")?.bg)).toEqual([39, 43, 49])
      expect(rgb(textSpan(setup, "same")?.bg)).toEqual([13, 17, 23])
      expect(rgb(textSpan(setup, "42 ")?.bg)).toEqual([13, 17, 23])
    } finally {
      await act(async () => setup.renderer.destroy())
    }
  })

  test("does not paint a selected background over diff rows", () => {
    const renderedRow = ReviewDiffRow({
      row: splitRow,
      width: 40,
      digits: 1,
      showLineNumbers: false,
      selected: true,
    }) as unknown as {
      props?: { style?: Readonly<Record<string, unknown>> }
    }

    expect(renderedRow.props?.style).not.toHaveProperty("backgroundColor")
  })
})
