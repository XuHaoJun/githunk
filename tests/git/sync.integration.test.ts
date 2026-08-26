import { describe, expect, test } from "bun:test"
import { GitRunner, GitCommandError } from "../../src/git/runner"
import { fetch, pull, push } from "../../src/git/sync"
import { createTempRepository } from "../helpers/temp-repository"

describe("synchronization operations", () => {
  test("fetches, pulls fast-forward, and pushes with an upstream", async () => {
    const remote = await createTempRepository()
    const local = await createTempRepository()
    try {
      await remote.write("file.txt", "base\n")
      await remote.git(["add", "file.txt"])
      await remote.git(["commit", "-m", "base"])
      await local.git(["remote", "add", "origin", remote.path])
      await fetch(new GitRunner(local.path), "origin")
      await local.git(["switch", "-c", "master", "--track", "origin/master"])
      await local.git(["branch", "--unset-upstream"])
      const runner = new GitRunner(local.path)
      const branch = (await local.git(["branch", "--show-current"])).stdout.trim()
      await local.write("file.txt", "local\n")
      await local.git(["add", "file.txt"])
      await local.git(["commit", "-m", "local"])
      const missingPull = await pull(runner)
      expect(missingPull).toMatchObject({ kind: "upstream-required", branch, operation: "pull" })
      if (missingPull.kind === "upstream-required") {
        await pull(runner, { upstream: missingPull.candidates[0] ?? { remote: "origin", branch } })
        expect(runner.log.lines().at(-1)?.spans.map((span) => span.text).join("")).toBe(`  git pull origin ${branch}`)
      }
      const missing = await push(runner)
      expect(missing.kind).toBe("upstream-required")
      if (missing.kind === "upstream-required") {
        expect(missing.branch).toBe(branch)
        expect(missing.operation).toBe("push")
      }
      await remote.git(["config", "receive.denyCurrentBranch", "updateInstead"])
      await push(runner, { upstream: { remote: "origin", branch } })
      await remote.git(["config", "receive.denyCurrentBranch", "updateInstead"])
      await remote.write("file.txt", "remote\n")
      await remote.git(["add", "file.txt"])
      await remote.git(["commit", "-m", "remote"])
      await fetch(runner, "origin")
      await pull(runner)
      expect((await local.git(["log", "-1", "--format=%s"])).stdout.trim()).toBe("remote")
    } finally {
      await local.cleanup()
      await remote.cleanup()
    }
  })

  test("surfaces rejected pushes as command failures", async () => {
    const remote = await createTempRepository()
    const local = await createTempRepository()
    try {
      await remote.write("file.txt", "base\n")
      await remote.git(["add", "file.txt"])
      await remote.git(["commit", "-m", "base"])
      await local.git(["remote", "add", "origin", remote.path])
      const runner = new GitRunner(local.path)
      await expect(push(runner)).resolves.toMatchObject({ kind: "upstream-required" })
      await expect(push(runner, { upstream: { remote: "origin", branch: "master" } })).rejects.toBeInstanceOf(GitCommandError)
    } finally {
      await local.cleanup()
      await remote.cleanup()
    }
  })
})
