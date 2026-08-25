import { describe, expect, test } from "bun:test"
import { localBranchRows } from "../../src/ui/panes/branches-pane"
import { remoteRows, remoteBranchRows } from "../../src/ui/panes/remotes-pane"
import { tagRows } from "../../src/ui/panes/tags-pane"
import type { AppModel } from "../../src/domain/repository"

const model = {
  repositoryRoot: "/tmp/repo",
  branch: "main",
  upstream: "origin/main",
  reviewTarget: { kind: "working-tree", scope: "all" } as const,
  files: [],
  patches: [],
  rawPatchSections: [],
  reviewStatuses: {},
  loading: false,
  commandLog: [],
  title: "Working Tree",
  branches: {
    current: "main",
    detached: false,
    localBranches: [
      { name: "main", isCurrent: true, committedAt: "1730000000", subject: "initial commit", upstream: "origin/main", upstreamTrack: "[ahead 1]", upstreamRemote: "origin", upstreamBranch: "main", aheadForPull: "1", behindForPull: "0", upstreamGone: false },
      { name: "feature", isCurrent: false, committedAt: "1729000000", subject: "feature work" },
    ],
    remotes: [
      {
        name: "origin",
        fetchUrl: "https://example.com/repo.git",
        pushUrl: "https://example.com/repo.git",
        branches: [{ name: "feature/foo", ref: "origin/feature/foo", oid: "abc123" }],
      },
    ],
  },
  tags: [
    {
      name: "v1",
      ref: "refs/tags/v1",
      kind: "annotated" as const,
      objectOid: "abc",
      targetOid: "def",
      subject: "release 1.0",
      taggerName: "Alice",
      taggedAt: "2026-08-24T00:00:00Z",
      message: "release notes",
    },
  ],
} as unknown as AppModel

describe("tab-specific pane rows", () => {
  test("local branch rows use local: prefix and equal localBranches length", () => {
    const rows = localBranchRows(model)
    expect(rows.every((row) => row.id.startsWith("local:"))).toBe(true)
    expect(rows.length).toBe(model.branches!.localBranches.length)
    expect(rows.map((r) => r.id)).toEqual(["local:main", "local:feature"])
  })

  test("local branch rows show recency/current/branch status without adding metadata headers as selectable rows", () => {
    const rows = localBranchRows(model)
    // No header rows: count matches localBranches, not + header count
    expect(rows.length).toBe(2)
    const mainRow = rows.find((r) => r.id === "local:main")!
    const combined = mainRow.columns.map((c) => c.text).join(" ")
    expect(combined).toContain("main")
    expect(combined).toContain("initial commit")
    // The checked-out branch's recency cell is lazygit's literal "  *".
    expect(mainRow.columns[0]!.text).toBe("  *")
    // The status cell is lazygit's arrow form, not git's raw `%(upstream:track)`.
    expect(combined).toContain("↑1")
    expect(combined).not.toContain("ahead 1")
    expect(combined).toContain("origin/main")
    // feature row is not the checked-out one, so its recency is a real age
    const featureRow = rows.find((r) => r.id === "local:feature")!
    expect(featureRow.columns[0]!.text).not.toBe("  *")
  })

  test("remote rows use remote: prefix", () => {
    const rows = remoteRows(model)
    expect(rows.map((row) => row.id)).toEqual(["remote:origin"])
    expect(rows.every((row) => row.id.startsWith("remote:"))).toBe(true)
    const originRow = rows[0]!
    const combined = originRow.columns.map((c) => c.text).join(" ")
    expect(combined).toContain("origin")
  })

  test("remote branch rows use remote-branch: prefix with full ref", () => {
    const rows = remoteBranchRows(model, "origin")
    expect(rows.map((row) => row.id)).toEqual(["remote-branch:origin/feature/foo"])
    expect(rows.length).toBe(1)
    const combined = rows[0]!.columns.map((c) => c.text).join(" ")
    expect(combined).toContain("origin/feature/foo")
  })

  test("tag rows use tag: prefix with full ref", () => {
    const rows = tagRows(model)
    expect(rows.map((row) => row.id)).toEqual(["tag:refs/tags/v1"])
    const combined = rows[0]!.columns.map((c) => c.text).join(" ")
    expect(combined).toContain("v1")
  })

  test("empty remotes or tags produce no rows rather than placeholder selectable rows", () => {
    const emptyModel = {
      ...model,
      branches: { ...model.branches!, remotes: [] },
      tags: [],
    } as AppModel
    expect(remoteRows(emptyModel)).toEqual([])
    expect(tagRows(emptyModel)).toEqual([])
    expect(remoteBranchRows(emptyModel, "origin")).toEqual([])
  })
})
