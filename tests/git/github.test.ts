import { describe, expect, test } from "bun:test"
import { PULL_REQUEST_LIST_ARGS, PullRequestsUnavailableError, loadPullRequests, parsePullRequests } from "../../src/git/github"
import { MAIN_BRANCHES, pullRequestsByBranch, remoteOwner, shouldShowPullRequest, type PullRequest } from "../../src/domain/pull-request"
import type { LocalBranch, Remote } from "../../src/domain/branch"

const prJson = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  number: 7,
  title: "Add a thing",
  state: "OPEN",
  isDraft: false,
  url: "https://github.com/acme/repo/pull/7",
  headRefName: "feature/thing",
  headRepositoryOwner: { login: "acme" },
  statusCheckRollup: [],
  ...overrides,
})

describe("PULL_REQUEST_LIST_ARGS", () => {
  test("asks for closed and merged pull requests too, since a merged one is what turns the dot purple", () => {
    expect(PULL_REQUEST_LIST_ARGS).toContain("--state")
    expect(PULL_REQUEST_LIST_ARGS[PULL_REQUEST_LIST_ARGS.indexOf("--state") + 1]).toBe("all")
    expect(PULL_REQUEST_LIST_ARGS[PULL_REQUEST_LIST_ARGS.indexOf("--json") + 1]).toContain("headRepositoryOwner")
  })
})

describe("parsePullRequests", () => {
  test("reads the fields the branches panel draws from", () => {
    const [pullRequest] = parsePullRequests(JSON.stringify([prJson()]))
    expect(pullRequest).toEqual({
      number: 7,
      title: "Add a thing",
      state: "OPEN",
      checksState: "",
      url: "https://github.com/acme/repo/pull/7",
      headRefName: "feature/thing",
      headRepositoryOwner: "acme",
    })
  })

  test("a merged pull request keeps its MERGED state — the purple dot's only source", () => {
    expect(parsePullRequests(JSON.stringify([prJson({ state: "MERGED" })]))[0]!.state).toBe("MERGED")
  })

  test("an open draft reports DRAFT, a closed draft stays CLOSED", () => {
    expect(parsePullRequests(JSON.stringify([prJson({ isDraft: true })]))[0]!.state).toBe("DRAFT")
    expect(parsePullRequests(JSON.stringify([prJson({ isDraft: true, state: "CLOSED" })]))[0]!.state).toBe("CLOSED")
  })

  test("individual check runs fold into one rollup state", () => {
    const withChecks = (checks: readonly unknown[]): string => JSON.stringify([prJson({ statusCheckRollup: checks })])
    expect(parsePullRequests(withChecks([{ conclusion: "SUCCESS", status: "COMPLETED" }]))[0]!.checksState).toBe("SUCCESS")
    expect(parsePullRequests(withChecks([{ conclusion: "SUCCESS", status: "COMPLETED" }, { status: "IN_PROGRESS" }]))[0]!.checksState).toBe("PENDING")
    expect(parsePullRequests(withChecks([{ conclusion: "SUCCESS", status: "COMPLETED" }, { conclusion: "FAILURE", status: "COMPLETED" }]))[0]!.checksState).toBe("FAILURE")
    expect(parsePullRequests(withChecks([]))[0]!.checksState).toBe("")
  })

  test("malformed output yields no pull requests rather than throwing", () => {
    expect(parsePullRequests("not json")).toEqual([])
    expect(parsePullRequests("{}")).toEqual([])
    expect(parsePullRequests(JSON.stringify([{ number: 1 }]))).toEqual([])
  })
})

describe("loadPullRequests", () => {
  test("a non-zero exit is reported as unavailable, not as a crash", async () => {
    const runner = async (): Promise<{ exitCode: number; stdout: string; stderr: string }> => ({
      exitCode: 4,
      stdout: "",
      stderr: "gh: To use GitHub CLI in a GitHub Actions workflow, set the GH_TOKEN environment variable",
    })
    await expect(loadPullRequests(runner)).rejects.toBeInstanceOf(PullRequestsUnavailableError)
  })

  test("passes exactly the documented argv", async () => {
    let seen: readonly string[] = []
    await loadPullRequests(async (args) => {
      seen = args
      return { exitCode: 0, stdout: "[]", stderr: "" }
    })
    expect(seen).toEqual(PULL_REQUEST_LIST_ARGS)
  })
})

describe("remoteOwner", () => {
  test("reads the owner out of both URL shapes", () => {
    expect(remoteOwner("git@github.com:acme/repo.git")).toBe("acme")
    expect(remoteOwner("https://github.com/acme/repo.git")).toBe("acme")
    expect(remoteOwner("https://github.com/acme/repo")).toBe("acme")
    expect(remoteOwner("ssh://git@github.enterprise.io/acme/repo.git")).toBe("acme")
    expect(remoteOwner("/local/path/repo.git")).toBe("path")
    expect(remoteOwner(undefined)).toBeUndefined()
  })
})

describe("pullRequestsByBranch", () => {
  const remotes: readonly Remote[] = [
    { name: "origin", fetchUrl: "git@github.com:acme/repo.git" },
    { name: "fork", fetchUrl: "https://github.com/contributor/repo.git" },
  ]
  const branches: readonly LocalBranch[] = [
    { name: "thing", isCurrent: false, upstreamRemote: "origin", upstreamBranch: "feature/thing" },
    { name: "forked", isCurrent: false, upstreamRemote: "fork", upstreamBranch: "feature/thing" },
    { name: "untracked", isCurrent: true },
  ]

  test("matches on head owner as well as branch name, so a fork's PR lands on the fork's branch", () => {
    const prs: readonly PullRequest[] = [
      { ...(parsePullRequests(JSON.stringify([prJson({ headRepositoryOwner: { login: "contributor" }, number: 9 })]))[0]!) },
      { ...(parsePullRequests(JSON.stringify([prJson()]))[0]!) },
    ]
    const map = pullRequestsByBranch(prs, branches, remotes)
    expect(map.forked?.number).toBe(9)
    expect(map.thing?.number).toBe(7)
    expect(map.untracked).toBeUndefined()
  })

  test("the first pull request seen for a key wins, since the API returns newest first", () => {
    const prs = parsePullRequests(JSON.stringify([prJson({ number: 20, state: "OPEN" }), prJson({ number: 3, state: "MERGED" })]))
    expect(pullRequestsByBranch(prs, branches, remotes).thing?.number).toBe(20)
  })

  test("no pull requests means an empty map, not an empty-ish object with prototype", () => {
    const map = pullRequestsByBranch([], branches, remotes)
    expect(Object.keys(map)).toEqual([])
    expect(Object.getPrototypeOf(map)).toBeNull()
  })
})

describe("shouldShowPullRequest", () => {
  const pr = (state: PullRequest["state"]): PullRequest => ({ ...parsePullRequests(JSON.stringify([prJson({ state })]))[0]! })

  test("a closed or merged pull request is hidden on a main branch but shown elsewhere", () => {
    expect(MAIN_BRANCHES).toEqual(["master", "main"])
    for (const branch of MAIN_BRANCHES) {
      expect(shouldShowPullRequest(pr("MERGED"), branch)).toBe(false)
      expect(shouldShowPullRequest(pr("CLOSED"), branch)).toBe(false)
      expect(shouldShowPullRequest(pr("OPEN"), branch)).toBe(true)
    }
    expect(shouldShowPullRequest(pr("MERGED"), "feature/thing")).toBe(true)
  })
})
