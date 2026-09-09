import { describe, expect, test } from "bun:test"
import { parseDiff } from "../../../src/domain/diff/parse"
import type { DiffDocument } from "../../../src/domain/diff/document"
import { renderDiff } from "../../../src/domain/diff/render"
import { copySelection, selectionFromRenderable } from "../../../src/domain/diff/selection"
import {
  eagerDiffSelectionProjection,
  resolveMainSelection,
  textSelectionProjection,
  type MainSelectionProjection,
} from "../../../src/domain/diff/selection-projection"
import { moveMainCursor } from "../../../src/ui/panes/main-pane"

type Fixture = DiffDocument
const fixture = "diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1,3 +1,3 @@\n context\n-old\n+  new\n"

function doc(): Fixture {
  const value = parseDiff(fixture)
  renderDiff(value)
  return value
}

describe("precise diff selection and copy", () => {
  test("maps display-number selections and normalizes reversed drags", () => {
    const value = doc()
    const rendered = value.rendered!
    const start = rendered.displayText.indexOf("new")
    const end = start + "new".length
    const selected = rendered.displayText.slice(start, end)
    const selection = selectionFromRenderable(value, { start: end, end: start }, selected)
    expect(selection.valid).toBe(true)
    expect(copySelection(value, selection, "text")).toBe("new")
  })

  test("rejects pane contamination or native/display mismatches", () => {
    const value = doc()
    const selection = selectionFromRenderable(value, { start: 0, end: 4 }, "LEFT")
    expect(selection.valid).toBe(false)
    expect(copySelection(value, selection, "text")).toBe("")
  })

  test("resolves exact projection ranges across text, decoration, and document segments", () => {
    const value = doc()
    const additionIndex = value.lines.findIndex((line) => line.kind === "addition")
    const addition = value.lines[additionIndex]!
    const projection: MainSelectionProjection = {
      generation: 1,
      document: value,
      text: "commit abc\n  1 +new\n",
      segments: [
        { kind: "text", displayStartUtf16: 0, displayEndUtf16: 11 },
        { kind: "decoration", displayStartUtf16: 11, displayEndUtf16: 15 },
        {
          kind: "document",
          displayStartUtf16: 15,
          displayEndUtf16: 20,
          rawStartUtf16: addition.startUtf16,
          rawEndUtf16: addition.startUtf16 + 5,
          lineIndex: additionIndex,
        },
      ],
    }

    expect(resolveMainSelection(projection, { start: 16, end: 19 }, "new")).toMatchObject({
      valid: true,
      kind: "document",
      selection: { startUtf16: addition.startUtf16 + 1, endUtf16: addition.startUtf16 + 4 },
    })
    expect(resolveMainSelection(projection, { start: 19, end: 16 }, "new")).toMatchObject({
      valid: true,
      kind: "document",
      selection: { startUtf16: addition.startUtf16 + 1, endUtf16: addition.startUtf16 + 4 },
    })
    expect(resolveMainSelection(projection, { start: 11, end: 19 }, "  1 +new")).toMatchObject({
      valid: true,
      kind: "document",
      selection: { startUtf16: addition.startUtf16, endUtf16: addition.startUtf16 + 4 },
    })
    expect(resolveMainSelection(projection, { start: 7, end: 10 }, "abc")).toEqual({
      valid: true,
      kind: "text",
      text: "abc",
    })
    expect(resolveMainSelection(projection, { start: 9, end: 17 }, "c\n  1 +n")).toEqual({
      valid: true,
      kind: "text",
      text: "c\n  1 +n",
    })
    expect(resolveMainSelection(projection, { start: 11, end: 15 }, "  1 ")).toEqual({
      valid: false,
      reason: "native/display selection mismatch",
    })
    expect(resolveMainSelection(projection, { start: 16, end: 19 }, "wrong")).toEqual({
      valid: false,
      reason: "native/display selection mismatch",
    })
  })

  test("normalizes UTF-8 ranges against the exact projection text", () => {
    const value = doc()
    const additionIndex = value.lines.findIndex((line) => line.kind === "addition")
    const addition = value.lines[additionIndex]!
    const text = "提交🙂\n  1 +new\n"
    const preambleLength = "提交🙂\n".length
    const projection: MainSelectionProjection = {
      generation: 1,
      document: value,
      text,
      segments: [
        { kind: "text", displayStartUtf16: 0, displayEndUtf16: preambleLength },
        { kind: "decoration", displayStartUtf16: preambleLength, displayEndUtf16: preambleLength + 4 },
        {
          kind: "document",
          displayStartUtf16: preambleLength + 4,
          displayEndUtf16: text.length,
          rawStartUtf16: addition.startUtf16,
          rawEndUtf16: addition.startUtf16 + 5,
          lineIndex: additionIndex,
        },
      ],
    }
    const selectedStart = text.indexOf("new")
    const start = Buffer.byteLength(text.slice(0, selectedStart), "utf8")
    const end = start + Buffer.byteLength("new", "utf8")
    expect(resolveMainSelection(projection, { unit: "utf8", start, end }, "new")).toMatchObject({
      valid: true,
      kind: "document",
      selection: { startUtf16: addition.startUtf16 + 1, endUtf16: addition.startUtf16 + 4 },
    })
  })

  test("builds exact text and eager diff projections", () => {
    const value = doc()
    const rendered = value.rendered!
    const preamble = "commit abc\n"
    const textProjection = textSelectionProjection(2, "plain output")
    expect(textProjection).toEqual({
      generation: 2,
      text: "plain output",
      segments: [{ kind: "text", displayStartUtf16: 0, displayEndUtf16: 12 }],
    })
    expect(textSelectionProjection(3, "")).toEqual({ generation: 3, text: "", segments: [] })

    const projection = eagerDiffSelectionProjection({
      generation: 4,
      document: value,
      text: `${preamble}${rendered.displayText}`,
      preambleLength: preamble.length,
      bodySegments: rendered.segments,
    })
    expect(projection.generation).toBe(4)
    expect(projection.document).toBe(value)
    expect(projection.segments[0]).toEqual({ kind: "text", displayStartUtf16: 0, displayEndUtf16: preamble.length })
    expect(projection.segments.some((segment) => segment.kind === "decoration")).toBe(true)
    expect(projection.segments.filter((segment) => segment.kind === "document")).toHaveLength(rendered.segments.length)
  })

  test("strips exactly one marker while preserving indentation and newlines", () => {
    const value = doc()
    const addition = value.lines.find((line) => line.kind === "addition")!
    const selection = { valid: true as const, startUtf16: addition.startUtf16, endUtf16: addition.endUtf16, fileIndex: 0, hunkIndex: 0 }
    expect(copySelection(value, undefined, "hunk")).toBe("")
    expect(copySelection(value, undefined, "file")).toBe("")
    expect(copySelection(value, selection, "added")).toBe("  new\n")
    expect(copySelection(value, selection, "removed")).toBe("")
  })

  test("whole hunk and file work from a cursor without a mouse selection", () => {
    const value = doc()
    const cursor = { valid: true as const, startUtf16: 0, endUtf16: 0, fileIndex: 0, hunkIndex: 0, active: false }
    expect(copySelection(value, cursor, "hunk")).toBe(fixture.slice(fixture.indexOf("@@")))
    expect(copySelection(value, cursor, "file")).toBe(fixture)
  })
  test("whole hunk/file require explicit non-first cursor context", () => {
    const second = "diff --git a/b.txt b/b.txt\n--- a/b.txt\n+++ b/b.txt\n@@ -1 +1 @@\n-old b\n+new b\n"
    const value = parseDiff(`${fixture}${second}`)
    expect(value.text).toBe(`${fixture}${second}`)
    const cursor = { valid: true as const, startUtf16: fixture.length, endUtf16: fixture.length, fileIndex: 1, hunkIndex: 0, active: false }
    expect(copySelection(value, cursor, "hunk")).toBe(second.slice(second.indexOf("@@")))
    expect(copySelection(value, cursor, "file")).toBe(second)
  })
  test("production Main cursor movement reaches later files before keyboard copy", () => {
    const second = "diff --git a/b.txt b/b.txt\n--- a/b.txt\n+++ b/b.txt\n@@ -1 +1 @@\n-old b\n+new b\n"
    const value = parseDiff(`${fixture}${second}`)
    const target = moveMainCursor(value, { fileIndex: 0, hunkIndex: 0 }, "next")
    expect(target).toEqual({ fileIndex: 1, hunkIndex: 0 })
    const cursor = {
      valid: true as const,
      startUtf16: 0,
      endUtf16: 0,
      fileIndex: target!.fileIndex,
      ...(target!.hunkIndex === undefined ? {} : { hunkIndex: target!.hunkIndex }),
      active: false,
    }
    expect(copySelection(value, cursor, "file")).toBe(second)
  })
  test("production Main cursor movement reaches a later hunkless file", () => {
    const binary = "diff --git a/dir b/old.bin b/dir b/new.bin\nBinary files a/dir b/old.bin and b/dir b/new.bin differ\n"
    const value = parseDiff(`${fixture}${binary}`)
    const target = moveMainCursor(value, { fileIndex: 0, hunkIndex: 0 }, "next")
    expect(target).toEqual({ fileIndex: 1 })
    const cursor = {
      valid: true as const,
      startUtf16: 0,
      endUtf16: 0,
      fileIndex: target!.fileIndex,
      ...(target!.hunkIndex === undefined ? {} : { hunkIndex: target!.hunkIndex }),
      active: false,
    }
    expect(copySelection(value, cursor, "file")).toBe(binary)
  })

  test("Unicode selections preserve exact JS text and UTF-8 bytes", () => {
    const unicode = parseDiff("diff --git a/u b/u\n@@ -1 +1 @@\n-€🙂\n+e\u0301界\n")
    renderDiff(unicode)
    const line = unicode.lines.find((entry) => entry.kind === "addition")!
    const selection = { valid: true as const, startUtf16: line.startUtf16, endUtf16: line.endUtf16, fileIndex: 0, hunkIndex: 0 }
    const copied = copySelection(unicode, selection, "added")
    expect(copied).toBe("e\u0301界\n")
    expect(new TextEncoder().encode(copied)).toEqual(new TextEncoder().encode("e\u0301界\n"))
  })
})
