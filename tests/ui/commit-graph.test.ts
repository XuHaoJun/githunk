import { describe, expect, test } from "bun:test"
import { commitGraphRows } from "../../src/ui/commit-graph"

const commit = (oid: string, parentOids: readonly string[]) => ({
  oid, shortOid: oid, parentOids, authorName: "A", authoredAt: "2026-01-01T00:00:00Z", subject: oid, body: "",
})

const texts = (commits: Parameters<typeof commitGraphRows>[0]) => commitGraphRows(commits).map((row) => row.text)

describe("commit graph", () => {
  test("renders linear ancestry as one lane of two-character cells", () => {
    const rows = texts([commit("c", ["b"]), commit("b", ["a"]), commit("a", [])])
    // Lazygit renders each lane as glyph + rightward filler; a lone lane is "○ ".
    expect(rows).toEqual(["○ ", "○ ", "○ "])
  })

  test("opens and converges lanes for a merge", () => {
    const rows = texts([
      commit("m", ["left", "right"]), commit("right", ["base"]), commit("left", ["base"]), commit("base", []),
    ])
    // The merge fans out with lazygit's ◎─╮, the side lane runs alongside, then both rejoin.
    expect(rows[0]).toBe("◎─╮ ")
    expect(rows[1]).toBe("│ ○ ")
    expect(rows[2]).toBe("○ │ ")
    expect(rows[3]).toBe("○─╯ ")
  })

  test("keeps a side branch in a distinct lane until convergence", () => {
    const rows = texts([
      commit("tip", ["main"]), commit("side", ["base"]), commit("main", ["base"]), commit("base", []),
    ])
    expect(rows[1]).not.toBe(rows[2])
    expect(rows.at(-1)?.trim()).toBe("○─╯")
  })

  test("colours each pipe with the colour supplied for its commit", () => {
    const rows = commitGraphRows([commit("b", ["a"]), commit("a", [])], () => "#abcdef")
    expect(rows[0]!.segments[0]).toEqual({ text: "○", color: "#abcdef" })
    // Fillers stay unstyled spaces, as in lazygit's cell renderer.
    expect(rows[0]!.segments[1]).toEqual({ text: " " })
  })
})
