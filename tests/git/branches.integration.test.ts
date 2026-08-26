import { describe, expect, test } from "bun:test"
import { GitRunner } from "../../src/git/runner"
import {
  checkoutRemoteTracking,
  createBranch,
  deleteBranch,
  fetchRemote,
  listBranches,
  listRemoteBranches,
  renameBranch,
  switchLocal,
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
})
