import { describe, expect, test } from "bun:test"
import { AppController } from "../../src/app/controller"
import { GitCommandError, GitRunner } from "../../src/git/runner"
import type { WorkingTreeSnapshot } from "../../src/domain/repository"
import type { PullRequest } from "../../src/domain/pull-request"
import type { BranchDeleteRequest } from "../../src/domain/branch"
import type { GitMutations } from "../../src/git/mutations"
import { createTempRepository } from "../helpers/temp-repository"
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

  test("passes file batches through one controller refresh", async () => {
    const runner = new GitRunner({ cwd: "/tmp/repo" })
    let loads = 0
    const staged: string[][] = []
    const mutations = {
      stageFiles: async (paths: readonly string[]) => { staged.push([...paths]) },
      unstageFiles: async () => undefined,
      discardFiles: async () => undefined,
    } as unknown as GitMutations
    const controller = new AppController({
      runner,
      mutations,
      load: async (target) => {
        loads += 1
        return {
          ...snapshot(target.scope, "batch"),
          files: [{
            path: "first.txt",
            indexStatus: ".",
            worktreeStatus: "M",
            untracked: false,
            conflicted: false,
            additions: 1,
            deletions: 0,
          }, {
            path: "second.txt",
            indexStatus: ".",
            worktreeStatus: "M",
            untracked: false,
            conflicted: false,
            additions: 1,
            deletions: 0,
          }],
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
    await controller.stageFiles(["first.txt", "second.txt"])

    expect(staged).toEqual([["first.txt", "second.txt"]])
    expect(loads).toBe(2)
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
  test("drops stash batches in supplied order and falls back from the active stash", async () => {
    const repo = await createTempRepository()
    try {
      await repo.write("file.txt", "base\n")
      await repo.git(["add", "--", "file.txt"])
      await repo.git(["commit", "--quiet", "-m", "base"])
      await repo.write("file.txt", "first\n")
      await repo.git(["stash", "push", "--quiet", "-m", "first"])
      const firstOid = (await repo.git(["stash", "list", "--format=%H"])).stdout.trim()
      await repo.write("file.txt", "second\n")
      await repo.git(["stash", "push", "--quiet", "-m", "second"])
      const stashOids = (await repo.git(["stash", "list", "--format=%H"])).stdout.trim().split("\n")
      const secondOid = stashOids[0]
      if (firstOid.length === 0 || secondOid === undefined) throw new Error("test stash setup failed")

      const runner = new GitRunner({ cwd: repo.path })
      let loads = 0
      const controller = new AppController({
        repositoryRoot: repo.path,
        runner,
        load: async (target) => {
          loads += 1
          return snapshot(target.scope, "working")
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
      await controller.inspectStash(firstOid)
      await controller.dropStashes([firstOid, secondOid], { confirmed: true })

      const dropCommands = runner.log.lines()
        .map((line) => line.spans.map((span) => span.text).join(""))
        .filter((text) => text.includes("git stash drop"))
      expect(dropCommands).toEqual(["  git stash drop stash@{1}", "  git stash drop stash@{0}"])
      expect(loads).toBe(2)
      expect(controller.state.reviewTarget).toEqual({ kind: "working-tree", scope: "all" })
    } finally {
      await repo.cleanup()
    }
  })

  test("deletes branch batches in request order and refreshes once", async () => {
    const repository = await createTempRepository()
    const remote = await createTempRepository()
    try {
      await repository.write("file.txt", "base\n")
      await repository.git(["add", "--", "file.txt"])
      await repository.git(["commit", "--quiet", "-m", "base"])
      await remote.git(["config", "core.bare", "true"])
      await repository.git(["remote", "add", "origin", remote.path])
      await repository.git(["branch", "local-only"])
      await repository.git(["branch", "both"])
      await repository.git(["push", "--quiet", "origin", "master:remote-only"])
      await repository.git(["push", "--quiet", "origin", "master:both"])
      await repository.git(["fetch", "--quiet", "origin"])

      const runner = new GitRunner({ cwd: repository.path })
      let remoteRefreshes = 0
      const run = runner.run.bind(runner)
      runner.run = async (args, options = {}) => {
        if (args[0] === "for-each-ref" && args[2] === "refs/remotes/origin") remoteRefreshes += 1
        return run(args, options)
      }
      let loads = 0
      const controller = new AppController({
        repositoryRoot: repository.path,
        runner,
        load: async (target) => {
          loads += 1
          return snapshot(target.scope, "working")
        },
        loadCommits: async () => [],
        loadBranches: async () => ({
          detached: false,
          current: "master",
          localBranches: [],
          remotes: [{ name: "origin" }],
        }),
        loadStashes: async () => [],
        loadTags: async () => [],
        loadReflog: async () => [],
        loadWorktrees: async () => [],
        loadSubmodules: async () => [],
      })
      const requests: readonly BranchDeleteRequest[] = [
        { mode: "local", branch: "local-only", force: false },
        { mode: "remote", branch: "remote-only", remote: "origin", remoteBranch: "remote-only", force: false },
        { mode: "local-and-remote", branch: "both", remote: "origin", remoteBranch: "both", force: false },
      ]

      await controller.refresh()
      await controller.deleteBranches(requests)

      expect((await repository.git(["show-ref", "--verify", "--quiet", "refs/heads/local-only"])).exitCode).not.toBe(0)
      const deleteCommands = runner.log.lines()
        .map((line) => line.spans.map((span) => span.text).join(""))
        .filter((text) => text.includes("git branch -d --") || text.includes("git branch -D --") || text.includes("git push origin --delete"))
      expect(deleteCommands).toEqual([
        "  git branch -d -- local-only",
        "  git push origin --delete refs/heads/remote-only",
        "  git push origin --delete refs/heads/both",
        "  git branch -D -- both",
      ])

      expect(loads).toBe(2)
      expect(remoteRefreshes).toBe(1)
    } finally {
      await remote.cleanup()
      await repository.cleanup()
    }
  })

  test("rejects a malformed remote batch before any deletion", async () => {
    const repository = await createTempRepository()
    const remote = await createTempRepository()
    try {
      await repository.write("file.txt", "base\n")
      await repository.git(["add", "--", "file.txt"])
      await repository.git(["commit", "--quiet", "-m", "base"])
      await remote.git(["config", "core.bare", "true"])
      await repository.git(["remote", "add", "origin", remote.path])
      await repository.git(["branch", "local-only"])
      await repository.git(["push", "--quiet", "origin", "master:remote-only"])

      const runner = new GitRunner({ cwd: repository.path })
      const controller = new AppController({
        repositoryRoot: repository.path,
        runner,
        load: async (target) => snapshot(target.scope, "working"),
      })
      runner.log.logAction("before batch validation")


      await expect(controller.deleteBranches([
        { mode: "local", branch: "local-only", force: false },
        { mode: "remote", branch: "remote-only", remote: "origin", force: false },
      ])).rejects.toThrow("remote branch deletion requires an upstream")
      expect(controller.state.banner).toBe("remote branch deletion requires an upstream")
      expect(controller.state.commandLog.at(-1)?.spans.map((span) => span.text).join("")).toBe("before batch validation")

      expect((await repository.git(["show-ref", "--verify", "--quiet", "refs/heads/local-only"])).exitCode).toBe(0)
      expect((await remote.git(["show-ref", "--verify", "--quiet", "refs/heads/remote-only"])).exitCode).toBe(0)
      const deleteCommands = runner.log.lines()
        .map((line) => line.spans.map((span) => span.text).join(""))
        .filter((text) => text.includes("git branch -d --") || text.includes("git push origin --delete"))
      expect(deleteCommands).toEqual([])
    } finally {
      await remote.cleanup()
      await repository.cleanup()
    }
  })

})

