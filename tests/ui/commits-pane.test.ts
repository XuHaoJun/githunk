import { describe, expect, test } from "bun:test"
import { renderCommitRows } from "../../src/ui/panes/commits-pane"
import type { CommitSummary } from "../../src/domain/commit"
import {
  COMMIT_HASH_DEFAULT_FG,
  COMMIT_HASH_MERGED_FG,
  COMMIT_HASH_PUSHED_FG,
  COMMIT_HASH_UNPUSHED_FG,
} from "../../src/ui/theme"

const now = new Date("2026-08-25T00:00:00Z")

function mkCommit(overrides: Partial<CommitSummary> & { oid: string }): CommitSummary {
  return {
    shortOid: overrides.oid.slice(0, 7),
    parentOids: [],
    authorName: "Author Name",
    authoredAt: "2026-08-24T00:00:00Z",
    subject: "Subject line",
    body: "",
    ...overrides,
  }
}

const commits: readonly CommitSummary[] = [
  mkCommit({ oid: "abc1234567890", shortOid: "abc1234", subject: "First commit with a very long subject line that should be truncated when width is narrow", authorName: "Author Name", authoredAt: "2026-08-24T12:00:00Z" }),
  mkCommit({ oid: "def1234567890", shortOid: "def1234", subject: "Second commit", authorName: "Other", authoredAt: "2026-08-20T00:00:00Z" }),
  mkCommit({ oid: "ghi1234567890", shortOid: "ghi1234", subject: "Third", authorName: "Author Name", authoredAt: "2026-08-10T00:00:00Z" }),
]

describe("commits pane rows", () => {
  test("includes author and omits arrow glyph", () => {
    const result = renderCommitRows(commits, { selectedId: commits[0]!.oid, focused: true, width: 80, now })
    // Lazygit shows author as 2-letter initials (CommitAuthorShortLength=2): "Author Name" → "AN", "Other" → "Ot".
    expect(result.plainText).toContain("AN")
    expect(result.plainText).toContain("Ot")
    expect(result.plainText).not.toContain("▸")
  })

  test("plainText respects width", () => {
    const result = renderCommitRows(commits, { selectedId: commits[0]!.oid, focused: false, width: 30, now })
    expect(result.plainText.length).toBeLessThanOrEqual(30 * commits.length + (commits.length - 1))
    // Each logical line should be <= width (allow newline separators)
    const lines = result.plainText.split("\n")
    for (const line of lines) {
      expect(line.length).toBeLessThanOrEqual(30)
    }
  })

  test("background only when focused", () => {
    const focused = renderCommitRows(commits, { selectedId: commits[0]!.oid, focused: true, width: 80, now })
    const unfocused = renderCommitRows(commits, { selectedId: commits[0]!.oid, focused: false, width: 80, now })
    const hasBg = (chunks: readonly { bg?: unknown }[]) => chunks.some((c) => c.bg !== undefined && c.bg !== null)
    expect(hasBg(focused.content.chunks)).toBe(true)
    expect(hasBg(unfocused.content.chunks)).toBe(false)
  })

  test("keeps the author column two cells wide whatever the name", () => {
    const mixed = [
      mkCommit({ oid: "aaa1234567890", parentOids: ["bbb1234567890"], authorName: "Author Name", subject: "one" }),
      mkCommit({ oid: "bbb1234567890", parentOids: ["ccc1234567890"], authorName: "Solo", subject: "two" }),
      mkCommit({ oid: "ccc1234567890", authorName: "X", subject: "three" }),
    ]
    const lines = renderCommitRows(mixed, { focused: false, width: 80, now }).plainText.split("\n")
    // "Author Name" → "AN", "Solo" → "So", "X" → "X " (padded); the graph then starts at a fixed offset.
    expect(lines.map((line) => line.slice(9, 11))).toEqual(["AN", "So", "X "])
    expect(new Set(lines.map((line) => line.indexOf("\u25cb")))).toEqual(new Set([12]))
  })

  test("pads the graph column so every subject starts at the same offset", () => {
    const merged = [
      mkCommit({ oid: "m00", parentOids: ["l00", "r00"], subject: "merge branch" }),
      mkCommit({ oid: "r00", parentOids: ["b00"], subject: "right side" }),
      mkCommit({ oid: "l00", parentOids: ["b00"], subject: "left side" }),
      mkCommit({ oid: "b00", parentOids: [], subject: "base" }),
    ]
    const lines = renderCommitRows(merged, { focused: false, width: 80, now }).plainText.split("\n")
    // The merge row needs three lanes, the root row one; padding keeps the subjects in one column.
    expect(lines[0]).toContain("\u25ce\u2500\u256e")
    const subjects = ["merge branch", "right side", "left side", "base"]
    const offsets = new Set(lines.map((line, index) => line.indexOf(subjects[index]!)))
    expect(offsets.size).toBe(1)
    expect([...offsets][0]).toBeGreaterThan(0)
  })

  test("drops time then author before truncating subject at narrow width", () => {
    const narrow = renderCommitRows(commits, { selectedId: commits[0]!.oid, focused: false, width: 30, now })
    // At width 30, time/author should be dropped fully so subject appears even if truncated
    expect(narrow.plainText).not.toContain("▸")
    // Subject words still partially visible (first commit subject starts with "First")
    expect(narrow.plainText).toContain("First")
  })

  /**
   * lazygit's `getHashColor` (pkg/gui/presentation/commits.go:485-501). A fixed hash colour would
   * throw away the panel's only signal for how far a commit has travelled.
   */
  test("colours the hash by commit status", () => {
    const statuses = [
      mkCommit({ oid: "aaa1234567890", subject: "local", status: "unpushed" }),
      mkCommit({ oid: "bbb1234567890", subject: "on the remote", status: "pushed" }),
      mkCommit({ oid: "ccc1234567890", subject: "on main", status: "merged" }),
      mkCommit({ oid: "ddd1234567890", subject: "unknown" }),
    ]
    const result = renderCommitRows(statuses, { focused: false, width: 80, now })
    const hashChunks = result.content.chunks.filter((chunk) => chunk.text.length === 8 && /^[a-f0-9]{8}$/.test(chunk.text))
    expect(hashChunks.map((chunk) => chunk.fg)).toEqual([
      COMMIT_HASH_UNPUSHED_FG,
      COMMIT_HASH_PUSHED_FG,
      COMMIT_HASH_MERGED_FG,
      COMMIT_HASH_DEFAULT_FG,
    ])
  })
})
