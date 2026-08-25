import { describe, expect, test } from "bun:test"
import { commitGraphRows } from "../../src/ui/commit-graph"

const commit = (oid: string, parentOids: readonly string[]) => ({
  oid, shortOid: oid, parentOids, authorName: "A", authoredAt: "2026-01-01T00:00:00Z", subject: oid, body: "",
})

describe("commit graph", () => {
  test("renders aligned linear ancestry", () => {
    const rows = commitGraphRows([commit("c", ["b"]), commit("b", ["a"]), commit("a", [])])
    expect(rows).toHaveLength(3)
    expect(new Set(rows.map((row) => row.length)).size).toBe(1)
    expect(rows.every((row) => row.includes("●") || row.includes("│"))).toBe(true)
  })

  test("opens and converges lanes for a merge", () => {
    const rows = commitGraphRows([
      commit("m", ["left", "right"]), commit("right", ["base"]), commit("left", ["base"]), commit("base", []),
    ])
    expect(rows.join("\n")).toContain("┬")
    expect(rows.at(-1)).toContain("●")
  })

  test("keeps a side branch in a distinct lane until convergence", () => {
    const rows = commitGraphRows([
      commit("tip", ["main"]), commit("side", ["base"]), commit("main", ["base"]), commit("base", []),
    ])
    expect(rows[1]).not.toBe(rows[2])
    expect(rows.at(-1)?.trim()).toBe("●")
  })
})
