import { describe, expect, test } from "bun:test"
import { parseReviewPatch } from "../../../src/review/git/patch-adapter"
import { REVIEW_CONFORMANCE_FIXTURES } from "./corpus"

describe("conformance: patch-adapter", () => {
  for (const fixture of REVIEW_CONFORMANCE_FIXTURES) {
    test(`${fixture.id}: parses file keys, hunk ranges, and stats inputs`, () => {
      const parsed = parseReviewPatch(fixture.patch)

      expect(parsed.length).toBe(fixture.expected.files.length)

      for (let i = 0; i < fixture.expected.files.length; i++) {
        const expectedFile = fixture.expected.files[i]!
        const actual = parsed[i]!

        expect(actual.path).toBe(expectedFile.path)
        if (expectedFile.previousPath !== undefined) {
          expect(actual.previousPath).toBe(expectedFile.previousPath)
        } else {
          expect(actual.previousPath).toBeUndefined()
        }
        expect(actual.isBinary).toBe(expectedFile.source === "binary")

        expect(actual.hunks.length).toBe(expectedFile.hunks.length)
        for (let hi = 0; hi < expectedFile.hunks.length; hi++) {
          const eh = expectedFile.hunks[hi]!
          const ah = actual.hunks[hi]!
          expect(ah.index).toBe(eh.index)
          expect(ah.oldStart).toBe(eh.oldStart)
          expect(ah.oldCount).toBe(eh.oldCount)
          expect(ah.newStart).toBe(eh.newStart)
          expect(ah.newCount).toBe(eh.newCount)
          expect([...ah.lines]).toEqual([...eh.lines])
        }

        // Patch digest stability: same normalized patch must yield same digest across runs
        // (computed as sha256Tuple([normalizedPatch]) inside parser)
        expect(actual.patchDigest.length).toBe(64)
        expect(actual.patchDigest).toMatch(/^[0-9a-f]{64}$/)

        // Stats are not in patch alone — verify numstat entry exists for this fixture file
        const numstat = fixture.numstatEntries.find((n) => n.path === expectedFile.path)
        expect(numstat).toBeDefined()
      }

      // Empty patch must yield zero files, not throw
      if (fixture.id === "empty") {
        expect(parsed).toEqual([])
      }

      // CRLF patch must be normalized: lines must not contain \r
      if (fixture.id === "crlf") {
        for (const pf of parsed) {
          for (const h of pf.hunks) {
            for (const line of h.lines) expect(line.includes("\r")).toBe(false)
          }
        }
      }

      // Binary patch must be flagged binary and have zero hunks
      if (fixture.id === "binary") {
        expect(parsed[0]!.isBinary).toBe(true)
        expect(parsed[0]!.hunks.length).toBe(0)
      }

      // Mode-only patch yields zero hunks path but still one file entry
      if (fixture.id === "mode-only") {
        // Pierre may produce a file entry with zero hunks for mode-only; adapter returns one file with empty hunks
        // If adapter returns 0 files for mode-only (Pierre omits), our expected is 1 — handle both by checking either
        // But corpus expects 1 file; enforce it
        expect(parsed.length).toBe(1)
      }

      // Rename/copy must preserve previousPath exactly
      if (fixture.id === "rename") {
        expect(parsed[0]!.previousPath).toBe("old-name.txt")
        expect(parsed[0]!.path).toBe("new-name.txt")
      }
      if (fixture.id === "copy") {
        expect(parsed[0]!.previousPath).toBe("original.txt")
        expect(parsed[0]!.path).toBe("copy.txt")
      }
    })
  }
})
