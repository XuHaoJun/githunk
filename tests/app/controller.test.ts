import { describe, expect, test } from "bun:test"
import { AppController } from "../../src/app/controller"
import { GitCommandError, GitRunner } from "../../src/git/runner"
import type { WorkingTreeSnapshot } from "../../src/domain/repository"
import type { PullRequest } from "../../src/domain/pull-request"
import type { GitMutations } from "../../src/git/mutations"
function snapshot(scope: "all" | "staged" | "unstaged", marker: string): WorkingTreeSnapshot {
  return {
    repositoryRoot: "/tmp/repo",
    branch: "main",
    upstream: "origin/main",
    reviewTarget: { kind: "working-tree", scope },
    files: [],
    patches: [{ label: "UNSTAGED", text: marker }],
  }
}

describe("AppController", () => {
  test("switches working tree scope and title", async () => {
    const controller = new AppController({
      repositoryRoot: "/tmp/repo",
      load: async (target) => snapshot(target.scope, target.scope),
    })
    await controller.refresh()
    await controller.setWorkingTreeScope("staged")

    expect(controller.state.reviewTarget).toEqual({ kind: "working-tree", scope: "staged" })
    expect(controller.state.title).toBe("Working Tree — Staged")
    expect(controller.state.loading).toBe(false)
  })

  test("does not let an older refresh overwrite a newer generation", async () => {
    let resolveFirst: ((value: WorkingTreeSnapshot) => void) | undefined
    let count = 0
    const controller = new AppController({
      repositoryRoot: "/tmp/repo",
      load: async (target) => {
        count += 1
        if (count === 1) return new Promise((resolve) => { resolveFirst = resolve })
        return snapshot(target.scope, "new")
      },
    })
    const first = controller.refresh()
    // refresh() now unconditionally awaits stash/branch listing before it
    // reaches the generation-incrementing load call; wait for that call to
    // actually start (and claim its generation number) before starting the
    // second, newer operation, so the two operations claim generations in
    // call order rather than in whichever happens to reach refreshTarget first.
    while (resolveFirst === undefined) await Promise.resolve()
    const second = controller.setWorkingTreeScope("staged")
    await second
    resolveFirst?.(snapshot("all", "old"))
    await first

    expect(controller.state.reviewTarget).toEqual({ kind: "working-tree", scope: "staged" })
    expect(controller.state.patches[0]?.text).toBe("new")
  })
 
  test("keeps the last successful snapshot when refresh fails", async () => {
    let calls = 0
    const controller = new AppController({
      repositoryRoot: "/tmp/repo",
      load: async (target) => {
        calls += 1
        if (calls === 1) return snapshot(target.scope, "last good")
        throw new GitCommandError({
          id: 9,
          cwd: "/tmp/repo",
          args: ["status"],
          startedAt: "2026-01-01T00:00:00.000Z",
          durationMs: 1,
          exitCode: 128,
          stdout: "",
          stderr: "repository unavailable",
        })
      },
    })

    await controller.refresh()
    await controller.refresh()

    expect(controller.state.loading).toBe(false)
    expect(controller.state.patches[0]?.text).toBe("last good")
    expect(controller.state.banner).toBe("repository unavailable")
  })
  test("preserves the prior target and view when a scope refresh fails", async () => {
    let calls = 0
    const runner = new GitRunner({ cwd: "/tmp/repo" })
    const error = new GitCommandError({
      id: 12,
      cwd: "/tmp/repo",
      args: ["status"],
      startedAt: "2026-01-01T00:00:00.000Z",
      durationMs: 1,
      exitCode: 128,
      stdout: "",
      stderr: "scope unavailable",
    })
    runner.log.logAction("scope unavailable")
    const controller = new AppController({
      runner,
      load: async (target) => {
        calls += 1
        if (calls === 1) {
          return {
            ...snapshot(target.scope, "old patch"),
            files: [{
              path: "old.ts",
              indexStatus: "M",
              worktreeStatus: ".",
              untracked: false,
              conflicted: false,
              additions: 1,
              deletions: 0,
            }],
          }
        }
        throw error
      },
      loadCommits: async () => [],
      loadBranches: async () => ({ detached: true, localBranches: [], remotes: [] }),
      loadStashes: async () => [],
      loadTags: async () => [],
      loadReflog: async () => [],
      loadWorktrees: async () => [],
      loadSubmodules: async () => [],
    })

    await controller.refresh()
    await controller.setWorkingTreeScope("staged")

    expect(controller.state.reviewTarget).toEqual({ kind: "working-tree", scope: "all" })
    expect(controller.state.title).toBe("Working Tree — All")
    expect(controller.state.files.map((file) => file.path)).toEqual(["old.ts"])
    expect(controller.state.patches[0]?.text).toBe("old patch")
    expect(controller.state.banner).toBe("scope unavailable")
    expect(controller.state.commandLog.at(-1)?.spans.map((span) => span.text).join("")).toBe("scope unavailable")
  })

  test("refreshes after each toggle-all mutation and exposes the first failure", async () => {
    const runner = new GitRunner({ cwd: "/tmp/repo" })
    let loads = 0
    const files = [
      { path: "first.txt", indexStatus: ".", worktreeStatus: "M", untracked: false, conflicted: false, additions: 1, deletions: 0 },
      { path: "second.txt", indexStatus: ".", worktreeStatus: "M", untracked: false, conflicted: false, additions: 1, deletions: 0 },
    ]
    const mutations = {
      stageFile: async (path: string) => { if (path === "second.txt") throw new Error("second failed") },
      unstageFile: async () => undefined,
    } as unknown as GitMutations
    const controller = new AppController({
      runner,
      mutations,
      load: async (target) => {
        loads += 1
        return {
          repositoryRoot: "/tmp/repo",
          branch: "main",
          reviewTarget: target,
          files,
          patches: [],
        }
      },
      loadCommits: async () => [],
      loadBranches: async () => ({ detached: true, localBranches: [], remotes: [] }),
      loadStashes: async () => [],
      loadTags: async () => [],
      loadReflog: async () => [],
      loadWorktrees: async () => [],
      loadSubmodules: async () => [],
    })
    await controller.refresh()
    await expect(controller.toggleAllFiles()).rejects.toThrow("second failed")
    expect(loads).toBe(2)
    expect(controller.state.banner).toBe("second failed")
  })

  test("refresh publishes the worktree and submodule listings", async () => {
    const worktrees = [{ path: "/tmp/repo", name: "repo", isMain: true, isCurrent: true, isPathMissing: false }] as const
    const submodules = [{ name: "vendor/lib", path: "vendor/lib", url: "/tmp/lib" }] as const
    const controller = new AppController({
      load: async (target) => snapshot(target.scope, ""),
      loadWorktrees: async () => worktrees,
      loadSubmodules: async () => submodules,
    })
    await controller.refresh()
    expect(controller.state.worktrees).toEqual(worktrees)
    expect(controller.state.submodules).toEqual(submodules)
  })

  test("a failing worktree or submodule listing only raises a banner", async () => {
    const controller = new AppController({
      load: async (target) => snapshot(target.scope, ""),
      loadWorktrees: async () => { throw new Error("worktree listing failed") },
      loadSubmodules: async () => [],
    })
    await controller.refresh()
    expect(controller.state.banner).toBe("worktree listing failed")
    expect(controller.state.worktrees).toBeUndefined()
    expect(controller.state.title).toBe("Working Tree — All")

    const other = new AppController({
      load: async (target) => snapshot(target.scope, ""),
      loadWorktrees: async () => [],
      loadSubmodules: async () => { throw new Error("submodule listing failed") },
    })
    await other.refresh()
    expect(other.state.banner).toBe("submodule listing failed")
    expect(other.state.submodules).toBeUndefined()
  })

  test("refresh publishes the real tag list", async () => {
    const tags = [{ name: "v1", ref: "refs/tags/v1", kind: "lightweight", objectOid: "a", targetOid: "a", subject: "release" }] as const
    const controller = new AppController({
      load: async (target) => snapshot(target.scope, ""),
      loadTags: async () => tags,
    })
    await controller.refresh()
    expect(controller.state.tags).toEqual(tags)
  })

  test("refresh starts pull-request loading without blocking local state", async () => {
    let pullRequestStarted = false
    let resolvePullRequest: ((value: readonly PullRequest[]) => void) | undefined
    let publications = 0
    let resolvePublication: (() => void) | undefined
    const publication = new Promise<void>((resolve) => { resolvePublication = resolve })
    const branch = {
      name: "feature",
      upstream: "origin/feature",
      upstreamRemote: "origin",
      upstreamBranch: "feature",
      isCurrent: true,
      committedAt: "1",
      subject: "feature",
    } as const
    const controller = new AppController({
      repositoryRoot: "/tmp/repo",
      load: async (target) => snapshot(target.scope, "local"),
      loadBranches: async () => ({
        detached: false,
        localBranches: [branch],
        remotes: [{ name: "origin", fetchUrl: "git@github.com:acme/repo.git" }],
      }),
      loadPullRequests: async () => {
        pullRequestStarted = true
        return new Promise<readonly PullRequest[]>((resolve) => { resolvePullRequest = resolve })
      },
      onPullRequestsChanged: () => { publications += 1; resolvePublication?.() },
    })

    const refresh = controller.refresh()
    await refresh

    expect(pullRequestStarted).toBe(true)
    expect(controller.state.patches[0]?.text).toBe("local")
    expect(publications).toBe(0)

    resolvePullRequest?.([{
      number: 1,
      title: "merged",
      state: "MERGED",
      checksState: "",
      url: "",
      headRefName: "feature",
      headRepositoryOwner: "acme",
    }])
    await publication

    expect(publications).toBe(1)
    expect(controller.state.pullRequests?.feature?.state).toBe("MERGED")
  })

  test("does not let an older pull-request refresh overwrite a newer result", async () => {
    let initialRefreshDone = false
    let oldRequestStarted = false
    let resolveOldRequest: ((value: readonly PullRequest[]) => void) | undefined
    const oldRequest = new Promise<readonly PullRequest[]>((resolve) => { resolveOldRequest = resolve })
    const branch = {
      name: "feature",
      upstream: "origin/feature",
      upstreamRemote: "origin",
      upstreamBranch: "feature",
      isCurrent: true,
      committedAt: "1",
      subject: "feature",
    } as const
    const controller = new AppController({
      repositoryRoot: "/tmp/repo",
      load: async (target) => snapshot(target.scope, "local"),
      loadBranches: async () => ({
        detached: false,
        localBranches: [branch],
        remotes: [{ name: "origin", fetchUrl: "git@github.com:acme/repo.git" }],
      }),
      loadPullRequests: async () => {
        if (!initialRefreshDone) return []
        if (!oldRequestStarted) {
          oldRequestStarted = true
          return await oldRequest
        }
        return [{
          number: 2,
          title: "merged",
          state: "MERGED",
          checksState: "",
          url: "",
          headRefName: "feature",
          headRepositoryOwner: "acme",
        }]
      },
    })

    await controller.refresh()
    initialRefreshDone = true
    const first = controller.refreshPullRequests()
    const second = controller.refreshPullRequests()
    await second
    expect(controller.state.pullRequests?.feature?.state).toBe("MERGED")

    resolveOldRequest?.([{
      number: 1,
      title: "open",
      state: "OPEN",
      checksState: "",
      url: "",
      headRefName: "feature",
      headRepositoryOwner: "acme",
    }])
    await first

    expect(controller.state.pullRequests?.feature?.state).toBe("MERGED")
  })
})

