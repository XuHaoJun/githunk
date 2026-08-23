import { describe, expect, test } from "bun:test"
import { parseDiff } from "../../../src/domain/diff/parse"
import type { DiffDocument } from "../../../src/domain/diff/document"
import { renderDiff } from "../../../src/domain/diff/render"
import { copySelection, selectionFromRenderable } from "../../../src/domain/diff/selection"

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
