import { describe, expect, test } from "bun:test"
import type { ListColumn } from "../../src/ui/list-view"
import { localBranchRows } from "../../src/ui/panes/branches-pane"
import { pullRequestIcon } from "../../src/ui/pull-request-icon"
import { parsePullRequests } from "../../src/git/github"
import type { AppModel } from "../../src/domain/repository"
import type { PullRequest } from "../../src/domain/pull-request"
import {
  BRANCH_DIVERGED_FG,
  BRANCH_MATCHES_UPSTREAM_FG,
  BRANCH_RECENCY_CURRENT_FG,
  BRANCH_RECENCY_FG,
  PR_CLOSED_FG,
  PR_DRAFT_FG,
  PR_MERGED_FG,
  PR_OPEN_FG,
} from "../../src/ui/theme"

const NOW_UNIX = 1_700_000_000
const now = new Date(NOW_UNIX * 1000)

function modelWith(localBranches: AppModel["branches"] extends infer B ? B extends { localBranches: infer L } ? L : never : never, extra: Partial<AppModel> = {}): AppModel {
  return {
    repositoryRoot: "/tmp/repo",
    branch: "main",
    reviewTarget: { kind: "working-tree", scope: "all" },
    files: [],
    patches: [],
    rawPatchSections: [],
    loading: false,
    commandLog: [],
    title: "Working Tree",
    branches: { current: "main", detached: false, localBranches, remotes: [] },
    ...extra,
  } as unknown as AppModel
}

const pr = (overrides: Record<string, unknown>): PullRequest => parsePullRequests(JSON.stringify([{
  number: 1,
  title: "t",
  state: "OPEN",
  isDraft: false,
  url: "https://github.com/acme/repo/pull/1",
  headRefName: "feature",
  headRepositoryOwner: { login: "acme" },
  statusCheckRollup: [],
  ...overrides,
}]))[0]!

describe("pullRequestIcon", () => {
  test("state picks the colour, and MERGED is lazygit's purple", () => {
    expect(pullRequestIcon(pr({ state: "MERGED" }))).toEqual({ text: "●", color: PR_MERGED_FG })
    expect(pullRequestIcon(pr({ state: "CLOSED" }))).toEqual({ text: "●", color: PR_CLOSED_FG })
    expect(pullRequestIcon(pr({ state: "OPEN" }))).toEqual({ text: "●", color: PR_OPEN_FG })
    expect(pullRequestIcon(pr({ isDraft: true }))).toEqual({ text: "●", color: PR_DRAFT_FG })
  })

  test("an open pull request with checks shows the checks icon instead", () => {
    expect(pullRequestIcon(pr({ statusCheckRollup: [{ conclusion: "SUCCESS", status: "COMPLETED" }] })).text).toBe("✓")
    expect(pullRequestIcon(pr({ statusCheckRollup: [{ status: "IN_PROGRESS" }] })).text).toBe("●")
    expect(pullRequestIcon(pr({ statusCheckRollup: [{ conclusion: "FAILURE", status: "COMPLETED" }] })).text).toBe("✗")
    // A merged pull request keeps its own dot whatever its checks said.
    expect(pullRequestIcon(pr({ state: "MERGED", statusCheckRollup: [{ conclusion: "FAILURE", status: "COMPLETED" }] })))
      .toEqual({ text: "●", color: PR_MERGED_FG })
  })
})

describe("localBranchRows", () => {
  const branches = [
    { name: "main", isCurrent: true, committedAt: String(NOW_UNIX - 3600), subject: "trunk work", upstreamRemote: "origin", upstreamBranch: "main", aheadForPull: "0", behindForPull: "0", upstreamGone: false },
    { name: "feature", isCurrent: false, committedAt: String(NOW_UNIX - 2 * 86400), subject: "feature work", upstreamRemote: "origin", upstreamBranch: "feature", aheadForPull: "3", behindForPull: "7", upstreamGone: false },
    { name: "local-only", isCurrent: false, committedAt: String(NOW_UNIX - 3 * 604800), subject: "no upstream" },
  ]

  test("the first cell is lazygit's recency, with the checked-out branch as a green star", () => {
    const rows = localBranchRows(modelWith(branches), "", { now })
    expect(rows[0]!.columns[0]).toEqual({ text: "  *", priority: 0, color: BRANCH_RECENCY_CURRENT_FG })
    expect(rows[1]!.columns[0]).toEqual({ text: "2d", priority: 0, color: BRANCH_RECENCY_FG })
    expect(rows[2]!.columns[0]!.text).toBe("3w")
  })

  test("the branch status cell carries lazygit's tick and arrows, not git's raw track string", () => {
    const rows = localBranchRows(modelWith(branches), "", { now })
    const statusOf = (id: string): ListColumn | undefined => {
      const row = rows.find((candidate) => candidate.id === id)!
      return row.columns.find((column) => column.text === "✓" || column.text.startsWith("↓") || column.text.startsWith("↑"))
    }
    expect(statusOf("local:main")).toMatchObject({ text: "✓", color: BRANCH_MATCHES_UPSTREAM_FG })
    expect(statusOf("local:feature")).toMatchObject({ text: "↓7↑3", color: BRANCH_DIVERGED_FG })
    expect(statusOf("local:local-only")).toBeUndefined()
    // The raw `[ahead 3, behind 7]` never reaches a cell.
    expect(rows.flatMap((row) => row.columns.map((column) => column.text)).join(" ")).not.toContain("ahead")
  })

  test("an in-flight operation replaces the status with its label and a spinner frame", () => {
    const rows = localBranchRows(modelWith(branches), "", {
      now,
      itemOperations: new Map([["local:main", "pulling" as const]]),
      spinnerNowMs: 0,
    })
    const main = rows.find((row) => row.id === "local:main")!
    expect(main.columns.some((column) => column.text === "Pulling ●∙∙")).toBe(true)
    expect(main.columns.some((column) => column.text === "✓")).toBe(false)
  })

  test("a pull request adds one dot cell right of the recency cell", () => {
    const rows = localBranchRows(modelWith(branches), "", {
      now,
      pullRequests: { feature: pr({ state: "MERGED", headRefName: "feature" }) },
    })
    const feature = rows.find((row) => row.id === "local:feature")!
    expect(feature.columns[1]).toEqual({ text: "●", priority: 0, color: PR_MERGED_FG })
    // Branches with no pull request keep a blank cell so the columns stay aligned; a list with no
    // pull requests at all drops the column, because list-view sheds blank-everywhere columns.
    expect(rows.find((row) => row.id === "local:main")!.columns[1]!.text).toBe("")
    expect(localBranchRows(modelWith(branches), "", { now })[0]!.columns[1]!.text).toBe("")
  })

  test("a merged pull request on a main branch is hidden, as lazygit hides it", () => {
    const rows = localBranchRows(modelWith(branches), "", {
      now,
      pullRequests: { main: pr({ state: "MERGED", headRefName: "main" }) },
    })
    expect(rows.find((row) => row.id === "local:main")!.columns[1]!.text).toBe("")
  })

  test("every row has the same cells in the same positions, whatever the branch lacks", () => {
    // ../../src/ui/list-view addresses columns by index and pads each to its widest cell, so a row
    // that omitted a cell would push its later cells into the wrong columns — which silently hid
    // the status of every branch whose neighbour had no status.
    const rows = localBranchRows(modelWith(branches), "", { now })
    const widths = new Set(rows.map((row) => row.columns.length))
    expect(widths.size).toBe(1)
    const columnTexts = (index: number): readonly string[] => rows.map((row) => row.columns[index]!.text)
    expect(columnTexts(2)).toEqual(["main", "feature", "local-only"])
    expect(columnTexts(3)).toEqual(["✓", "↓7↑3", ""])
    expect(columnTexts(5)).toEqual(["trunk work", "feature work", "no upstream"])
  })

  test("the checked-out branch stays pinned above the date order", () => {
    const rows = localBranchRows(modelWith(branches), "", { now })
    expect(rows.map((row) => row.id)).toEqual(["local:main", "local:feature", "local:local-only"])
  })
})
