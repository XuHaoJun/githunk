import { describe, expect, test } from "bun:test"
import { renderCommitRows } from "../../src/ui/panes/commits-pane"
import type { CommitSummary } from "../../src/domain/commit"

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
    expect(result.plainText).toContain("Author Name")
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

  test("drops time then author before truncating subject at narrow width", () => {
    const narrow = renderCommitRows(commits, { selectedId: commits[0]!.oid, focused: false, width: 30, now })
    // At width 30, time/author should be dropped fully so subject appears even if truncated
    expect(narrow.plainText).not.toContain("▸")
    // Subject words still partially visible (first commit subject starts with "First")
    expect(narrow.plainText).toContain("First")
  })
})
