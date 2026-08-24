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
})
