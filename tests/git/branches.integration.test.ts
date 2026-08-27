import { describe, expect, test } from "bun:test"
import { CommandLog } from "../../src/app/command-log"
import { AppController } from "../../src/app/controller"
import { GitRunner } from "../../src/git/runner"
import {
  checkoutRemoteTracking,
  createBranch,
  deleteBranch,
  deleteLocalAndRemoteBranch,
  deleteRemoteBranch,
  fetchRemote,
  isBranchMerged,
  listBranches,
  listRemoteBranches,
  renameBranch,
  switchLocal,
  type CreateBranchOptions,
} from "../../src/git/branches"
import { trackingLocalName } from "../../src/domain/branch"
import { createTempRepository } from "../helpers/temp-repository"

describe("branch and remote operations", () => {
  test("lists and mutates local branches with slash-containing names", async () => {
    const repository = await createTempRepository()
    try {
      await repository.write("file.txt", "base\n")
      await repository.git(["add", "file.txt"])
      await repository.git(["commit", "-m", "base"])
      const runner = new GitRunner(repository.path)
      await createBranch(runner, "feature/foo")
      await renameBranch(runner, "feature/foo", "feature/bar")
      await switchLocal(runner, "master")
      await deleteBranch(runner, "feature/bar")
      const listing = await listBranches(runner)
      expect(listing.localBranches.map((branch) => branch.name)).not.toContain("feature/bar")
    } finally {
      await repository.cleanup()
    }
  })

  test("checks out a missing remote branch as a tracking branch", async () => {
    const repository = await createTempRepository()
    try {
      await repository.write("file.txt", "base\n")
      await repository.git(["add", "file.txt"])
      await repository.git(["commit", "-m", "base"])
      const bare = await createTempRepository()
      try {
        await bare.git(["config", "core.bare", "true"])
        await repository.git(["remote", "add", "origin", bare.path])
        await repository.git(["push", "origin", "master:feature/foo"])
        const runner = new GitRunner(repository.path)
        await fetchRemote(runner, "origin")
        expect(trackingLocalName("origin", "feature/foo")).toBe("feature/foo")
        const result = await checkoutRemoteTracking(runner, "origin/feature/foo")
        expect(result.kind).toBe("created")
        expect((await listRemoteBranches(runner, "origin")).map((branch) => branch.name)).toContain("feature/foo")
      } finally {
        await bare.cleanup()
      }
    } finally {
      await repository.cleanup()
    }
  })

  test("fetchRemote streams a succeeding fetch's output under the Git output: heading", async () => {
    const repository = await createTempRepository()
    const bare = await createTempRepository()
    const advancer = await createTempRepository()
    try {
      await repository.write("file.txt", "base\n")
      await repository.git(["add", "file.txt"])
      await repository.git(["commit", "-m", "base"])
      await bare.git(["config", "core.bare", "true"])
      await repository.git(["remote", "add", "origin", bare.path])
      await repository.git(["push", "origin", "master"])
      const runner = new GitRunner(repository.path)
      // A brand-new remote's first non-verbose fetch is silent in this git version even though it
      // creates a remote-tracking ref, so prime it once before observing output.
      await fetchRemote(runner, "origin")

      // Move the bare remote's master from an unrelated second repository, so repository's
      // origin/master is stale and the next fetch has a genuine ref update to report — the default
      // `+refs/heads/*:refs/remotes/origin/*` refspec force-updates remote-tracking refs
      // (docs: git-fetch's REFSPECS), and non-verbose git still prints that update line (unlike
      // the silent first fetch above, which only suppresses *new*-ref creation).
      await advancer.git(["remote", "add", "origin", bare.path])
      await advancer.write("file.txt", "advanced\n")
      await advancer.git(["add", "file.txt"])
      await advancer.git(["commit", "-m", "advance"])
      await advancer.git(["push", "--force", "origin", "master"])

      // lazygit's FetchRemote is PromptOnCredentialRequest, so it streams (sync.go:127-132,
      // cmd_obj_runner.go:38-40,234-246) — pin that a *succeeding* fetch still gets the Git
      // output: heading, which is what distinguishes streamOutput from the failure-only branch.
      await fetchRemote(runner, "origin")
      const texts = runner.log.lines().map((line) => line.spans.map((span) => span.text).join(""))
      const commandIndices = texts.reduce<number[]>((acc, text, index) => {
        if (text === "  git fetch -- origin") acc.push(index)
        return acc
      }, [])
      const secondFetchIndex = commandIndices[1]
      expect(secondFetchIndex).toBeGreaterThanOrEqual(0)
      expect(texts[secondFetchIndex! + 2]).toBe("Git output:")
      expect(texts.slice(secondFetchIndex! + 3).join("\n")).toContain("master")
    } finally {
      await advancer.cleanup()
      await bare.cleanup()
      await repository.cleanup()
    }
  })

  test("switches an existing tracking branch and reports upstream mismatches", async () => {
    const repository = await createTempRepository()
    try {
      await repository.write("file.txt", "base\n")
      await repository.git(["add", "file.txt"])
      await repository.git(["commit", "-m", "base"])
      const bare = await createTempRepository()
      try {
        await bare.git(["config", "core.bare", "true"])
        await repository.git(["remote", "add", "origin", bare.path])
        await repository.git(["push", "origin", "master:feature/foo"])
        const runner = new GitRunner(repository.path)
        await fetchRemote(runner, "origin")
        expect((await checkoutRemoteTracking(runner, "origin/feature/foo")).kind).toBe("created")
        expect((await checkoutRemoteTracking(runner, "origin/feature/foo")).kind).toBe("switched")
        await repository.git(["config", "branch.feature/foo.remote", "other"])
        await repository.git(["config", "branch.feature/foo.merge", "refs/heads/feature/foo"])
        const mismatch = await checkoutRemoteTracking(runner, "origin/feature/foo")
        expect(mismatch.kind).toBe("mismatch")
        if (mismatch.kind === "mismatch") expect(mismatch.message).toContain("no upstream")
      } finally {
        await bare.cleanup()
      }
    } finally {
      await repository.cleanup()
    }
  })

  test("keeps detached state and surfaces dirty checkout failures", async () => {
    const repository = await createTempRepository()
    try {
      await repository.write("file.txt", "base\n")
      await repository.git(["add", "file.txt"])
      await repository.git(["commit", "-m", "base"])
      await repository.git(["branch", "other"])
      await repository.git(["switch", "other"])
      await repository.write("file.txt", "other\n")
      await repository.git(["add", "file.txt"])
      await repository.git(["commit", "-m", "other"])
      await repository.git(["switch", "master"])
      await repository.write("file.txt", "dirty\n")
      const runner = new GitRunner(repository.path)
      await expect(switchLocal(runner, "other")).rejects.toThrow()
      await repository.git(["checkout", "--detach", "HEAD"])
      expect((await listBranches(runner)).detached).toBe(true)
    } finally {
      await repository.cleanup()
    }
  })
  test("rejects option-like start points and preserves branch refs ending in HEAD", async () => {
    const repository = await createTempRepository()
    try {
      await repository.write("file.txt", "base\n")
      await repository.git(["add", "file.txt"])
      await repository.git(["commit", "-m", "base"])
      const runner = new GitRunner(repository.path)
      await expect(createBranch(runner, "feature/option", "--track")).rejects.toThrow()
      await repository.git(["update-ref", "refs/remotes/origin/feature/HEAD", "HEAD"])
      await repository.git(["remote", "add", "origin", "https://example.invalid/origin.git"])
      const branches = await listRemoteBranches(runner, "origin")
      expect(branches.map((branch) => branch.name)).toContain("feature/HEAD")
      expect(trackingLocalName("origin", "feature/HEAD")).toBe("feature/HEAD")
    } finally {
      await repository.cleanup()
    }
  })

  test("preserves slash-containing remote identity for tracking checkout", async () => {
    const repository = await createTempRepository()
    const bare = await createTempRepository()
    try {
      await repository.write("file.txt", "base\n")
      await repository.git(["add", "file.txt"])
      await repository.git(["commit", "-m", "base"])
      await bare.git(["config", "core.bare", "true"])
      await repository.git(["remote", "add", "origin/foo", bare.path])
      await repository.git(["push", "origin/foo", "master:feature/bar"])
      const runner = new GitRunner(repository.path)
      await fetchRemote(runner, "origin/foo")
      const branch = (await listRemoteBranches(runner, "origin/foo")).find((candidate) => candidate.name === "feature/bar")
      expect(branch).toBeDefined()
      if (branch !== undefined) {
        const result = await checkoutRemoteTracking(runner, { remote: "origin/foo", branch: branch.name, ref: branch.ref })
        expect(result.kind).toBe("created")
        expect(result.localBranch).toBe("feature/bar")
      }
    } finally {
      await repository.cleanup()
      await bare.cleanup()
    }
  })

  test("deletes a remote branch through its configured remote", async () => {
    const repository = await createTempRepository()
    const remote = await createTempRepository()
    try {
      await repository.write("file.txt", "base\n")
      await repository.git(["add", "file.txt"])
      await repository.git(["commit", "-m", "base"])
      await remote.git(["config", "core.bare", "true"])
      await repository.git(["remote", "add", "origin", remote.path])
      await repository.git(["push", "origin", "master:feature/foo"])

      await deleteRemoteBranch(new GitRunner(repository.path), "origin", "feature/foo")

      const remoteRef = await remote.git(["show-ref", "--verify", "--quiet", "refs/heads/feature/foo"])
      expect(remoteRef.exitCode).not.toBe(0)
    } finally {
      await remote.cleanup()
      await repository.cleanup()
    }
  })

  test("deletes the remote ref before the matching local branch", async () => {
    const repository = await createTempRepository()
    const remote = await createTempRepository()
    try {
      await repository.write("file.txt", "base\n")
      await repository.git(["add", "file.txt"])
      await repository.git(["commit", "-m", "base"])
      await remote.git(["config", "core.bare", "true"])
      await repository.git(["remote", "add", "origin", remote.path])
      await repository.git(["push", "origin", "master:feature/foo"])
      await repository.git(["fetch", "origin"])
      await repository.git(["branch", "--track", "feature/foo", "origin/feature/foo"])

      await deleteLocalAndRemoteBranch(new GitRunner(repository.path), "feature/foo", "origin", "feature/foo")

      expect((await repository.git(["branch", "--list", "feature/foo"])).stdout).not.toContain("feature/foo")
      expect((await remote.git(["show-ref", "--verify", "--quiet", "refs/heads/feature/foo"])).exitCode).not.toBe(0)
    } finally {
      await remote.cleanup()
      await repository.cleanup()
    }
  })
  test("combined deletion validates force before touching the remote", async () => {
    const repository = await createTempRepository()
    const remote = await createTempRepository()
    try {
      await repository.write("file.txt", "base\n")
      await repository.git(["add", "file.txt"])
      await repository.git(["commit", "-m", "base"])
      await remote.git(["config", "core.bare", "true"])
      await repository.git(["remote", "add", "origin", remote.path])
      await repository.git(["switch", "-c", "feature/foo"])
      await repository.write("feature.txt", "unmerged\n")
      await repository.git(["add", "feature.txt"])
      await repository.git(["commit", "-m", "unmerged"])
      await repository.git(["push", "-u", "origin", "feature/foo"])
      await repository.git(["switch", "master"])

      const runner = new GitRunner(repository.path)
      await expect(deleteLocalAndRemoteBranch(runner, "feature/foo", "origin", "feature/foo")).rejects.toThrow()

      expect((await remote.git(["show-ref", "--verify", "--quiet", "refs/heads/feature/foo"])).exitCode).toBe(0)
      expect((await repository.git(["branch", "--list", "feature/foo"])).stdout).toContain("feature/foo")
    } finally {
      await remote.cleanup()
      await repository.cleanup()
    }
  })

  test("reports whether a branch is merged into HEAD", async () => {
    const repository = await createTempRepository()
    try {
      await repository.write("file.txt", "base\n")
      await repository.git(["add", "file.txt"])
      await repository.git(["commit", "-m", "base"])
      const runner = new GitRunner(repository.path)
      await createBranch(runner, "feature")
      await repository.write("file.txt", "feature\n")
      await repository.git(["add", "file.txt"])
      await repository.git(["commit", "-m", "feature"])
      await switchLocal(runner, "master")

      expect(await isBranchMerged(runner, "feature")).toBe(false)
      await repository.git(["merge", "--ff-only", "feature"])
      expect(await isBranchMerged(runner, "feature")).toBe(true)
    } finally {
      await repository.cleanup()
    }
  })

  test("creates from a remote ref without tracking when the name is edited", async () => {
    const repository = await createTempRepository()
    const remote = await createTempRepository()
    try {
      await repository.write("file.txt", "base\n")
      await repository.git(["add", "file.txt"])
      await repository.git(["commit", "-m", "base"])
      await remote.git(["config", "core.bare", "true"])
      await repository.git(["remote", "add", "origin", remote.path])
      await repository.git(["push", "origin", "master:feature/foo"])
      await repository.git(["fetch", "origin"])

      const runner = new GitRunner(repository.path)
      const options: CreateBranchOptions = { track: false }
      await createBranch(runner, "custom", "origin/feature/foo", options)

      const upstream = await repository.git(["rev-parse", "--abbrev-ref", "custom@{upstream}"])
      expect(upstream.exitCode).not.toBe(0)
    } finally {
      await remote.cleanup()
      await repository.cleanup()
    }
  })
  test("combined deletion logs remote and local actions in order", async () => {
    const repository = await createTempRepository()
    const remote = await createTempRepository()
    try {
      await repository.write("file.txt", "base\n")
      await repository.git(["add", "file.txt"])
      await repository.git(["commit", "-m", "base"])
      await remote.git(["config", "core.bare", "true"])
      await repository.git(["remote", "add", "origin", remote.path])
      await repository.git(["push", "origin", "master:feature/foo"])
      await repository.git(["fetch", "origin"])
      await repository.git(["branch", "--track", "feature/foo", "origin/feature/foo"])

      const log = new CommandLog()
      const controller = new AppController({
        repositoryRoot: repository.path,
        runner: new GitRunner({ cwd: repository.path, log }),
      })
      await controller.refresh()
      await controller.deleteLocalAndRemoteBranch("feature/foo", "origin", "feature/foo", { force: true, confirmed: true })

      const actions = log.lines()
        .filter((line) => line.spans.some((span) => span.style === "action"))
        .map((line) => line.spans.map((span) => span.text).join(""))
      expect(actions).toEqual(["Delete remote branch", "Delete local branch"])
    } finally {
      await remote.cleanup()
      await repository.cleanup()
    }
  })
})
