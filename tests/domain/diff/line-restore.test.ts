import { describe, expect, test } from "bun:test"
import { parseDiff } from "../../../src/domain/diff/parse"
import { changeLineAtOrdinal, changeOrdinalBefore, diffLineIdentity, findDiffLineByIdentity, newFilePosition } from "../../../src/domain/diff/line-restore"

const twoFiles = parseDiff(["diff --git a/a.txt b/a.txt", "--- a/a.txt", "+++ b/a.txt", "@@ -1,3 +1,3 @@", " keep", "-old", "+new", " tail", "diff --git a/b.txt b/b.txt", "--- a/b.txt", "+++ b/b.txt", "@@ -1,1 +1,2 @@", " one", "+two", ""].join("\n"))

const indexOf = (document: typeof twoFiles, raw: string): number => document.lines.findIndex((line) => line.raw === `${raw}\n`)

describe("change ordinals", () => {
  test("counts the change lines before a line", () => {
    expect(changeOrdinalBefore(twoFiles, indexOf(twoFiles, " keep"))).toBe(0)
    expect(changeOrdinalBefore(twoFiles, indexOf(twoFiles, "-old"))).toBe(0)
    expect(changeOrdinalBefore(twoFiles, indexOf(twoFiles, "+new"))).toBe(1)
    expect(changeOrdinalBefore(twoFiles, indexOf(twoFiles, "+two"))).toBe(2)
  })

  test("finds the change line at an ordinal, landing on the last change past the end", () => {
    expect(changeLineAtOrdinal(twoFiles, 0)).toBe(indexOf(twoFiles, "-old"))
    expect(changeLineAtOrdinal(twoFiles, 2)).toBe(indexOf(twoFiles, "+two"))
    expect(changeLineAtOrdinal(twoFiles, 9)).toBe(indexOf(twoFiles, "+two"))
  })

  test("has no change line to land on in a diff without changes", () => {
    expect(changeLineAtOrdinal(parseDiff(""), 0)).toBeUndefined()
  })
})

describe("diff line identity", () => {
  test("names an addition by its new line and a deletion by its old line", () => {
    expect(diffLineIdentity(twoFiles, indexOf(twoFiles, "+new"))).toEqual({ path: "a.txt", kind: "addition", line: 2 })
    expect(diffLineIdentity(twoFiles, indexOf(twoFiles, "-old"))).toEqual({ path: "a.txt", kind: "deletion", line: 2 })
    expect(diffLineIdentity(twoFiles, indexOf(twoFiles, " tail"))).toEqual({ path: "a.txt", kind: "context", line: 3 })
  })

  test("has no identity for header rows", () => {
    expect(diffLineIdentity(twoFiles, 0)).toBeUndefined()
  })

  test("finds the same line in a re-rendered diff after an earlier hunk changed", () => {
    const after = parseDiff(["diff --git a/a.txt b/a.txt", "--- a/a.txt", "+++ b/a.txt", "@@ -1,3 +1,4 @@", "+inserted", " keep", "-old", "+new", " tail", "diff --git a/b.txt b/b.txt", "--- a/b.txt", "+++ b/b.txt", "@@ -1,1 +1,2 @@", " one", "+two", ""].join("\n"))
    const identity = diffLineIdentity(twoFiles, indexOf(twoFiles, "+two"))!
    expect(findDiffLineByIdentity(after, identity)).toBe(indexOf(after, "+two"))
    expect(findDiffLineByIdentity(after, { path: "a.txt", kind: "addition", line: 99 })).toBeUndefined()
  })
})

describe("new-file position", () => {
  test("is the new line of an addition or context line and where a deletion sits", () => {
    expect(newFilePosition(twoFiles, indexOf(twoFiles, " keep"))).toBe(1)
    expect(newFilePosition(twoFiles, indexOf(twoFiles, "-old"))).toBe(2)
    expect(newFilePosition(twoFiles, indexOf(twoFiles, "+new"))).toBe(2)
    expect(newFilePosition(twoFiles, indexOf(twoFiles, "@@ -1,3 +1,3 @@"))).toBe(1)
  })

  test("places a trailing deletion after the last line before it", () => {
    const trailing = parseDiff(["diff --git a/c.txt b/c.txt", "--- a/c.txt", "+++ b/c.txt", "@@ -1,2 +1 @@", " first", "-gone", ""].join("\n"))
    expect(newFilePosition(trailing, indexOf(trailing, "-gone"))).toBe(2)
  })

  test("has no position on a file header", () => {
    expect(newFilePosition(twoFiles, 0)).toBeUndefined()
  })
})
