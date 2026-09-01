import { sha256Tuple } from "../../../src/review/core/identity"
import type { ReviewFile } from "../../../src/review/core/types"

/**
 * Single vocabulary shared by parser, core, and row planner.
 * Each fixture carries patch/raw/numstat input plus expected semantic addresses:
 * file keys, hunk ranges, source addresses, gaps, content-id relationships,
 * and row-address relationships. Do not duplicate expected values in consumers;
 * import this corpus.
 */

export type ConformanceExpectedFile = Readonly<{
  key: string
  path: string
  previousPath?: string
  kind: ReviewFile["kind"]
  stats: Readonly<{ additions: number | null; deletions: number | null }>
  source: ReviewFile["source"]
  hunks: readonly Readonly<{
    index: number
    oldStart: number
    oldCount: number
    newStart: number
    newCount: number
    lines: readonly string[]
  }>[]
}>

export type ConformanceFixture = Readonly<{
  id: string
  description: string
  // Canonical inputs — sanitizer normalizes CRLF/controls before Pierre
  patch: string
  rawEntries: readonly Readonly<{
    status: string
    path: string
    previousPath?: string
    oldMode: string
    newMode: string
    oldBlobOid: string
    newBlobOid: string
  }>[]
  numstatEntries: readonly Readonly<{
    path: string
    previousPath?: string
    additions: number | null
    deletions: number | null
  }>[]
  expected: Readonly<{
    files: readonly ConformanceExpectedFile[]
    // Gap ids expected as collapsed rows before each hunk + trailing gap
    gaps: readonly Readonly<{ fileKey: string; gapId: string }>[]
    // Sample source addresses that must be observed in row planner output
    rowAddresses: readonly Readonly<{
      fileKey: string
      hunkIndex: number | null
      oldLine: number | null
      newLine: number | null
      marker: string
    }>[]
    // Content-id equality relationships: pairs that share or differ
    contentIdDistinctPairs: readonly (readonly [string, string])[]
    contentIdSamePairs: readonly (readonly [string, string])[]
  }>
}>

// Helpers to compute contentId exactly as loadReviewDocument does, for relationship assertions
export function computeContentId(
  raw: { oldBlobOid: string; newBlobOid: string; oldMode: string; newMode: string },
  normalizedHunkBody: string,
): string {
  return sha256Tuple([raw.oldBlobOid, raw.newBlobOid, raw.oldMode, raw.newMode, normalizedHunkBody])
}

export function normalizedHunkBodyForFixture(file: ConformanceExpectedFile): string {
  const body = file.hunks.flatMap((h) => h.lines).join("\n")
  return body.length > 0 ? body + "\n" : ""
}

// — DRY OID fixtures (40 hex)
const OID_A = "a".repeat(40)
const OID_B = "b".repeat(40)
const OID_C = "c".repeat(40)
const OID_D = "d".repeat(40)
const OID_ZERO = "0".repeat(40)

// Long line ~600 chars
const LONG_LINE = "x".repeat(600)
const LONG_LINE_MODIFIED = "y".repeat(600)

// Shared patch fragments
const CRLF_PATCH =
  "diff --git a/crlf.txt b/crlf.txt\r\n" +
  "index abc123..def456 100644\r\n" +
  "--- a/crlf.txt\r\n" +
  "+++ b/crlf.txt\r\n" +
  "@@ -1,3 +1,3 @@\r\n" +
  " line1\r\n" +
  "-old line\r\n" +
  "+new line\r\n" +
  " line3\r\n"

const NO_NEWLINE_PATCH =
  "diff --git a/nonewline.txt b/nonewline.txt\n" +
  "index abc123..def456 100644\n" +
  "--- a/nonewline.txt\n" +
  "+++ b/nonewline.txt\n" +
  "@@ -1,2 +1,2 @@\n" +
  " line1\n" +
  "-line2\n" +
  "+line2\n" +
  "\\ No newline at end of file\n"

const CJK_PATCH =
  "diff --git a/cjk.txt b/cjk.txt\n" +
  "index abc123..def456 100644\n" +
  "--- a/cjk.txt\n" +
  "+++ b/cjk.txt\n" +
  "@@ -1,3 +1,3 @@\n" +
  " hello\n" +
  "-世界 hello\n" +
  "+世界 world\n" +
  " こんにちは\n"

const COMBINING_PATCH =
  "diff --git a/combining.txt b/combining.txt\n" +
  "index abc123..def456 100644\n" +
  "--- a/combining.txt\n" +
  "+++ b/combining.txt\n" +
  "@@ -1,2 +1,2 @@\n" +
  "-e\u0301 combined\n" + // e + combining acute
  "+e\u0301 updated\n" +
  " plain\n"

const LONG_LINE_PATCH =
  `diff --git a/long.txt b/long.txt\n` +
  `index abc123..def456 100644\n` +
  `--- a/long.txt\n` +
  `+++ b/long.txt\n` +
  `@@ -1,2 +1,2 @@\n` +
  ` ${LONG_LINE}\n` +
  `-${LONG_LINE}\n` +
  `+${LONG_LINE_MODIFIED}\n`

const BINARY_PATCH =
  "diff --git a/image.png b/image.png\n" +
  "index abc123..def456 100644\n" +
  "--- a/image.png\n" +
  "+++ b/image.png\n" +
  "GIT binary patch\n" +
  "literal 0\n" +
  "HcmV?d00001\n"

const MODE_ONLY_PATCH =
  "diff --git a/script.sh b/script.sh\n" +
  "old mode 100644\n" +
  "new mode 100755\n"

const RENAME_PATCH =
  "diff --git a/old-name.txt b/new-name.txt\n" +
  "similarity index 100%\n" +
  "rename from old-name.txt\n" +
  "rename to new-name.txt\n" +
  "index abc123..def456 100644\n" +
  "--- a/old-name.txt\n" +
  "+++ b/new-name.txt\n" +
  "@@ -1,2 +1,2 @@\n" +
  " line1\n" +
  "-old\n" +
  "+new\n"

const COPY_PATCH =
  "diff --git a/original.txt b/copy.txt\n" +
  "similarity index 100%\n" +
  "copy from original.txt\n" +
  "copy to copy.txt\n" +
  "index abc123..def456 100644\n" +
  "--- a/original.txt\n" +
  "+++ b/copy.txt\n" +
  "@@ -1,1 +1,1 @@\n" +
  "-hello\n" +
  "+hello copy\n"

const DELETE_PATCH =
  "diff --git a/delete-me.txt b/delete-me.txt\n" +
  "deleted file mode 100644\n" +
  "index abc123..0000000\n" +
  "--- a/delete-me.txt\n" +
  "+++ /dev/null\n" +
  "@@ -1,2 +0,0 @@\n" +
  "-line1\n" +
  "-line2\n"

const EMPTY_PATCH = ""

const AMBIGUOUS_PATCH =
  "diff --git a/ambiguous.txt b/ambiguous.txt\n" +
  "index abc123..def456 100644\n" +
  "--- a/ambiguous.txt\n" +
  "+++ b/ambiguous.txt\n" +
  "@@ -1,7 +1,7 @@\n" +
  " context-a\n" +
  " context-b\n" +
  " context-c\n" +
  "-target-old\n" +
  "+target-new\n" +
  " context-d\n" +
  " context-e\n" +
  " context-f\n"

const MULTI_FILE_PATCH =
  "diff --git a/src/a.ts b/src/a.ts\n" +
  "index abc123..def456 100644\n" +
  "--- a/src/a.ts\n" +
  "+++ b/src/a.ts\n" +
  "@@ -10,3 +10,3 @@\n" +
  " context-a\n" +
  "-old-a\n" +
  "+new-a\n" +
  " tail-a\n" +
  "diff --git a/src/b.ts b/src/b.ts\n" +
  "index abc123..def456 100644\n" +
  "--- a/src/b.ts\n" +
  "+++ b/src/b.ts\n" +
  "@@ -20,3 +20,3 @@\n" +
  " context-b\n" +
  "-old-b\n" +
  "+new-b\n" +
  " tail-b\n"

export const REVIEW_CONFORMANCE_FIXTURES: readonly ConformanceFixture[] = [
  {
    id: "crlf",
    description: "CRLF line endings normalized before parse",
    patch: CRLF_PATCH,
    rawEntries: [{ status: "M", path: "crlf.txt", oldMode: "100644", newMode: "100644", oldBlobOid: OID_A, newBlobOid: OID_B }],
    numstatEntries: [{ path: "crlf.txt", additions: 1, deletions: 1 }],
    expected: {
      files: [
        {
          key: "crlf.txt",
          path: "crlf.txt",
          kind: "modified",
          stats: { additions: 1, deletions: 1 },
          source: "available",
          hunks: [{ index: 0, oldStart: 1, oldCount: 3, newStart: 1, newCount: 3, lines: [" line1", "-old line", "+new line", " line3"] }],
        },
      ],
      gaps: [
        { fileKey: "crlf.txt", gapId: "before:0" },
        { fileKey: "crlf.txt", gapId: "trailing:0" },
      ],
      rowAddresses: [
        { fileKey: "crlf.txt", hunkIndex: 0, oldLine: 1, newLine: 1, marker: "context" },
        { fileKey: "crlf.txt", hunkIndex: 0, oldLine: 2, newLine: null, marker: "deletion" },
        { fileKey: "crlf.txt", hunkIndex: 0, oldLine: null, newLine: 2, marker: "addition" },
      ],
      contentIdDistinctPairs: [],
      contentIdSamePairs: [],
    },
  },
  {
    id: "no-final-newline",
    description: "File without final newline reports marker row",
    patch: NO_NEWLINE_PATCH,
    rawEntries: [{ status: "M", path: "nonewline.txt", oldMode: "100644", newMode: "100644", oldBlobOid: OID_A, newBlobOid: OID_B }],
    numstatEntries: [{ path: "nonewline.txt", additions: 1, deletions: 1 }],
    expected: {
      files: [
        {
          key: "nonewline.txt",
          path: "nonewline.txt",
          kind: "modified",
          stats: { additions: 1, deletions: 1 },
          source: "available",
          hunks: [{ index: 0, oldStart: 1, oldCount: 2, newStart: 1, newCount: 2, lines: [" line1", "-line2", "+line2"] }],
        },
      ],
      gaps: [
        { fileKey: "nonewline.txt", gapId: "before:0" },
        { fileKey: "nonewline.txt", gapId: "trailing:0" },
      ],
      rowAddresses: [
        { fileKey: "nonewline.txt", hunkIndex: 0, oldLine: 1, newLine: 1, marker: "context" },
        { fileKey: "nonewline.txt", hunkIndex: 0, oldLine: 2, newLine: null, marker: "deletion" },
      ],
      contentIdDistinctPairs: [],
      contentIdSamePairs: [],
    },
  },
  {
    id: "cjk",
    description: "CJK wide characters affect wrapping but not anchors",
    patch: CJK_PATCH,
    rawEntries: [{ status: "M", path: "cjk.txt", oldMode: "100644", newMode: "100644", oldBlobOid: OID_A, newBlobOid: OID_B }],
    numstatEntries: [{ path: "cjk.txt", additions: 1, deletions: 1 }],
    expected: {
      files: [
        {
          key: "cjk.txt",
          path: "cjk.txt",
          kind: "modified",
          stats: { additions: 1, deletions: 1 },
          source: "available",
          hunks: [{ index: 0, oldStart: 1, oldCount: 3, newStart: 1, newCount: 3, lines: [" hello", "-世界 hello", "+世界 world", " こんにちは"] }],
        },
      ],
      gaps: [
        { fileKey: "cjk.txt", gapId: "before:0" },
        { fileKey: "cjk.txt", gapId: "trailing:0" },
      ],
      rowAddresses: [
        { fileKey: "cjk.txt", hunkIndex: 0, oldLine: 2, newLine: null, marker: "deletion" },
        { fileKey: "cjk.txt", hunkIndex: 0, oldLine: null, newLine: 2, marker: "addition" },
      ],
      contentIdDistinctPairs: [],
      contentIdSamePairs: [],
    },
  },
  {
    id: "combining-marks",
    description: "Combining marks counted as one cell width approximation",
    patch: COMBINING_PATCH,
    rawEntries: [{ status: "M", path: "combining.txt", oldMode: "100644", newMode: "100644", oldBlobOid: OID_A, newBlobOid: OID_B }],
    numstatEntries: [{ path: "combining.txt", additions: 1, deletions: 1 }],
    expected: {
      files: [
        {
          key: "combining.txt",
          path: "combining.txt",
          kind: "modified",
          stats: { additions: 1, deletions: 1 },
          source: "available",
          hunks: [{ index: 0, oldStart: 1, oldCount: 2, newStart: 1, newCount: 2, lines: ["-e\u0301 combined", "+e\u0301 updated", " plain"] }],
        },
      ],
      gaps: [
        { fileKey: "combining.txt", gapId: "before:0" },
        { fileKey: "combining.txt", gapId: "trailing:0" },
      ],
      rowAddresses: [
        { fileKey: "combining.txt", hunkIndex: 0, oldLine: 1, newLine: null, marker: "deletion" },
        { fileKey: "combining.txt", hunkIndex: 0, oldLine: 2, newLine: 2, marker: "context" },
      ],
      contentIdDistinctPairs: [],
      contentIdSamePairs: [],
    },
  },
  {
    id: "long-line",
    description: "600-char line wraps but source address stable",
    patch: LONG_LINE_PATCH,
    rawEntries: [{ status: "M", path: "long.txt", oldMode: "100644", newMode: "100644", oldBlobOid: OID_A, newBlobOid: OID_B }],
    numstatEntries: [{ path: "long.txt", additions: 1, deletions: 1 }],
    expected: {
      files: [
        {
          key: "long.txt",
          path: "long.txt",
          kind: "modified",
          stats: { additions: 1, deletions: 1 },
          source: "available",
          hunks: [{ index: 0, oldStart: 1, oldCount: 2, newStart: 1, newCount: 2, lines: [` ${LONG_LINE}`, `-${LONG_LINE}`, `+${LONG_LINE_MODIFIED}`] }],
        },
      ],
      gaps: [
        { fileKey: "long.txt", gapId: "before:0" },
        { fileKey: "long.txt", gapId: "trailing:0" },
      ],
      rowAddresses: [
        { fileKey: "long.txt", hunkIndex: 0, oldLine: 1, newLine: 1, marker: "context" },
        { fileKey: "long.txt", hunkIndex: 0, oldLine: 2, newLine: null, marker: "deletion" },
        { fileKey: "long.txt", hunkIndex: 0, oldLine: null, newLine: 2, marker: "addition" },
      ],
      contentIdDistinctPairs: [],
      contentIdSamePairs: [],
    },
  },
  {
    id: "binary",
    description: "Binary file has no hunks and dedicated source kind",
    patch: BINARY_PATCH,
    rawEntries: [{ status: "M", path: "image.png", oldMode: "100644", newMode: "100644", oldBlobOid: OID_A, newBlobOid: OID_B }],
    numstatEntries: [{ path: "image.png", additions: null, deletions: null }],
    expected: {
      files: [
        {
          key: "image.png",
          path: "image.png",
          kind: "binary",
          stats: { additions: null, deletions: null },
          source: "binary",
          hunks: [],
        },
      ],
      gaps: [],
      rowAddresses: [{ fileKey: "image.png", hunkIndex: null, oldLine: null, newLine: null, marker: "binary" }],
      contentIdDistinctPairs: [],
      contentIdSamePairs: [],
    },
  },
  {
    id: "mode-only",
    description: "Mode change without content hunk",
    patch: MODE_ONLY_PATCH,
    rawEntries: [{ status: "M", path: "script.sh", oldMode: "100644", newMode: "100755", oldBlobOid: OID_A, newBlobOid: OID_A }],
    numstatEntries: [{ path: "script.sh", additions: 0, deletions: 0 }],
    expected: {
      files: [
        {
          key: "script.sh",
          path: "script.sh",
          kind: "modified",
          stats: { additions: 0, deletions: 0 },
          source: "available",
          hunks: [],
        },
      ],
      gaps: [],
      rowAddresses: [{ fileKey: "script.sh", hunkIndex: null, oldLine: null, newLine: null, marker: "mode" }],
      contentIdDistinctPairs: [],
      contentIdSamePairs: [],
    },
  },
  {
    id: "rename",
    description: "Renamed file carries previousPath and transfers anchors",
    patch: RENAME_PATCH,
    rawEntries: [{ status: "R100", path: "new-name.txt", previousPath: "old-name.txt", oldMode: "100644", newMode: "100644", oldBlobOid: OID_A, newBlobOid: OID_B }],
    numstatEntries: [{ path: "new-name.txt", previousPath: "old-name.txt", additions: 1, deletions: 1 }],
    expected: {
      files: [
        {
          key: "new-name.txt",
          path: "new-name.txt",
          previousPath: "old-name.txt",
          kind: "renamed",
          stats: { additions: 1, deletions: 1 },
          source: "available",
          hunks: [{ index: 0, oldStart: 1, oldCount: 2, newStart: 1, newCount: 2, lines: [" line1", "-old", "+new"] }],
        },
      ],
      gaps: [
        { fileKey: "new-name.txt", gapId: "before:0" },
        { fileKey: "new-name.txt", gapId: "trailing:0" },
      ],
      rowAddresses: [
        { fileKey: "new-name.txt", hunkIndex: 0, oldLine: 1, newLine: 1, marker: "context" },
        { fileKey: "new-name.txt", hunkIndex: 0, oldLine: 2, newLine: null, marker: "deletion" },
      ],
      contentIdDistinctPairs: [],
      contentIdSamePairs: [],
    },
  },
  {
    id: "copy",
    description: "Copied file with previousPath",
    patch: COPY_PATCH,
    rawEntries: [{ status: "C100", path: "copy.txt", previousPath: "original.txt", oldMode: "100644", newMode: "100644", oldBlobOid: OID_A, newBlobOid: OID_B }],
    numstatEntries: [{ path: "copy.txt", previousPath: "original.txt", additions: 1, deletions: 1 }],
    expected: {
      files: [
        {
          key: "copy.txt",
          path: "copy.txt",
          previousPath: "original.txt",
          kind: "copied",
          stats: { additions: 1, deletions: 1 },
          source: "available",
          hunks: [{ index: 0, oldStart: 1, oldCount: 1, newStart: 1, newCount: 1, lines: ["-hello", "+hello copy"] }],
        },
      ],
      gaps: [
        { fileKey: "copy.txt", gapId: "before:0" },
        { fileKey: "copy.txt", gapId: "trailing:0" },
      ],
      rowAddresses: [
        { fileKey: "copy.txt", hunkIndex: 0, oldLine: 1, newLine: null, marker: "deletion" },
        { fileKey: "copy.txt", hunkIndex: 0, oldLine: null, newLine: 1, marker: "addition" },
      ],
      contentIdDistinctPairs: [],
      contentIdSamePairs: [],
    },
  },
  {
    id: "delete",
    description: "Deleted file",
    patch: DELETE_PATCH,
    rawEntries: [{ status: "D", path: "delete-me.txt", oldMode: "100644", newMode: "000000", oldBlobOid: OID_A, newBlobOid: OID_ZERO }],
    numstatEntries: [{ path: "delete-me.txt", additions: 0, deletions: 2 }],
    expected: {
      files: [
        {
          key: "delete-me.txt",
          path: "delete-me.txt",
          kind: "deleted",
          stats: { additions: 0, deletions: 2 },
          source: "available",
          hunks: [{ index: 0, oldStart: 1, oldCount: 2, newStart: 0, newCount: 0, lines: ["-line1", "-line2"] }],
        },
      ],
      gaps: [
        { fileKey: "delete-me.txt", gapId: "before:0" },
        { fileKey: "delete-me.txt", gapId: "trailing:0" },
      ],
      rowAddresses: [
        { fileKey: "delete-me.txt", hunkIndex: 0, oldLine: 1, newLine: null, marker: "deletion" },
        { fileKey: "delete-me.txt", hunkIndex: 0, oldLine: 2, newLine: null, marker: "deletion" },
      ],
      contentIdDistinctPairs: [],
      contentIdSamePairs: [],
    },
  },
  {
    id: "empty",
    description: "Empty diff yields no files",
    patch: EMPTY_PATCH,
    rawEntries: [],
    numstatEntries: [],
    expected: {
      files: [],
      gaps: [],
      rowAddresses: [],
      contentIdDistinctPairs: [],
      contentIdSamePairs: [],
    },
  },
  {
    id: "ambiguous-context",
    description: "Repeated context lines must not mis-relocate anchors",
    patch: AMBIGUOUS_PATCH,
    rawEntries: [{ status: "M", path: "ambiguous.txt", oldMode: "100644", newMode: "100644", oldBlobOid: OID_A, newBlobOid: OID_B }],
    numstatEntries: [{ path: "ambiguous.txt", additions: 1, deletions: 1 }],
    expected: {
      files: [
        {
          key: "ambiguous.txt",
          path: "ambiguous.txt",
          kind: "modified",
          stats: { additions: 1, deletions: 1 },
          source: "available",
          hunks: [
            {
              index: 0,
              oldStart: 1,
              oldCount: 7,
              newStart: 1,
              newCount: 7,
              lines: [" context-a", " context-b", " context-c", "-target-old", "+target-new", " context-d", " context-e", " context-f"],
            },
          ],
        },
      ],
      gaps: [
        { fileKey: "ambiguous.txt", gapId: "before:0" },
        { fileKey: "ambiguous.txt", gapId: "trailing:0" },
      ],
      rowAddresses: [
        { fileKey: "ambiguous.txt", hunkIndex: 0, oldLine: 4, newLine: null, marker: "deletion" },
        { fileKey: "ambiguous.txt", hunkIndex: 0, oldLine: null, newLine: 4, marker: "addition" },
        { fileKey: "ambiguous.txt", hunkIndex: 0, oldLine: 1, newLine: 1, marker: "context" },
      ],
      contentIdDistinctPairs: [],
      contentIdSamePairs: [],
    },
  },
  {
    id: "multi-file",
    description: "Multiple files preserve document order and per-file addresses",
    patch: MULTI_FILE_PATCH,
    rawEntries: [
      { status: "M", path: "src/a.ts", oldMode: "100644", newMode: "100644", oldBlobOid: OID_A, newBlobOid: OID_B },
      { status: "M", path: "src/b.ts", oldMode: "100644", newMode: "100644", oldBlobOid: OID_C, newBlobOid: OID_D },
    ],
    numstatEntries: [
      { path: "src/a.ts", additions: 1, deletions: 1 },
      { path: "src/b.ts", additions: 1, deletions: 1 },
    ],
    expected: {
      files: [
        {
          key: "src/a.ts",
          path: "src/a.ts",
          kind: "modified",
          stats: { additions: 1, deletions: 1 },
          source: "available",
          hunks: [{ index: 0, oldStart: 10, oldCount: 3, newStart: 10, newCount: 3, lines: [" context-a", "-old-a", "+new-a", " tail-a"] }],
        },
        {
          key: "src/b.ts",
          path: "src/b.ts",
          kind: "modified",
          stats: { additions: 1, deletions: 1 },
          source: "available",
          hunks: [{ index: 0, oldStart: 20, oldCount: 3, newStart: 20, newCount: 3, lines: [" context-b", "-old-b", "+new-b", " tail-b"] }],
        },
      ],
      gaps: [
        { fileKey: "src/a.ts", gapId: "before:0" },
        { fileKey: "src/a.ts", gapId: "trailing:0" },
        { fileKey: "src/b.ts", gapId: "before:0" },
        { fileKey: "src/b.ts", gapId: "trailing:0" },
      ],
      rowAddresses: [
        { fileKey: "src/a.ts", hunkIndex: 0, oldLine: 10, newLine: 10, marker: "context" },
        { fileKey: "src/a.ts", hunkIndex: 0, oldLine: 11, newLine: null, marker: "deletion" },
        { fileKey: "src/b.ts", hunkIndex: 0, oldLine: 21, newLine: null, marker: "deletion" },
        { fileKey: "src/b.ts", hunkIndex: 0, oldLine: null, newLine: 21, marker: "addition" },
      ],
      contentIdDistinctPairs: [["src/a.ts", "src/b.ts"]],
      contentIdSamePairs: [],
    },
  },
] as const

export type ReviewConformanceFixture = (typeof REVIEW_CONFORMANCE_FIXTURES)[number]
