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

  test("starts the subject right after its own graph lane instead of padding to the widest lane", () => {
    const id = (s: string): string => `${s}0000000`
    // Varying lane widths (lazygit's graph_test "room to move to the left"):
    // 1:○  2:◎─╮  3:◎─│─╮  5:◎─│─│─╮  7:◎─│─│─│─╮ …
    const seq: Array<readonly [string, readonly string[]]> = [
      ["1", ["2"]],
      ["2", ["3", "4"]],
      ["3", ["5", "4"]],
      ["5", ["7", "8"]],
      ["7", ["4", "A"]],
      ["4", ["B"]],
      ["B", ["C"]],
      ["C", ["D"]],
    ]
    const merged = seq.map(([hash, parents], index) =>
      mkCommit({
        oid: id(hash) + index,
        parentOids: parents.map((p) => {
          const parentIndex = seq.findIndex(([h]) => h === p)
          return parentIndex === -1 ? id(p) + "z" : id(p) + parentIndex
        }),
        subject: `subject-${hash}`,
      }),
    )
    const lines = renderCommitRows(merged, { focused: false, width: 80, now }).plainText.split("\n")
    // The narrow lane must not pad out to the widest lane: single space, not a blank run.
    expect(lines[0]).toContain("○ subject-1")
    expect(lines[0]).not.toContain("○  ")
    // Subjects ride right after their own lane, so offsets vary with lane width.
    const offsets = lines.map((line, index) => line.indexOf(`subject-${seq[index]![0]}`))
    expect(new Set(offsets).size).toBeGreaterThan(1)
    // The trailing time still aligns the rows: every line ends with it.
    expect(lines.every((line) => line.endsWith("1d"))).toBe(true)
  })

  test("truncates the subject before dropping the trailing time at narrow width", () => {
    const narrow = renderCommitRows(commits, { selectedId: commits[0]!.oid, focused: false, width: 30, now })
    const lines = narrow.plainText.split("\n")
    // Time survives narrow widths; the flex subject absorbs the squeeze instead.
    expect(lines[0]).toContain("12h")
    expect(lines[1]).toContain("5d")
    // Subject words still partially visible (first commit subject starts with "First")
    expect(lines[0]).toContain("First")
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(30)
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
