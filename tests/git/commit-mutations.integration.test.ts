import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { CommandLog } from "../../src/app/command-log"
import { amend, CommitMutations, commit, EmptyCommitMessageError } from "../../src/git/commit-mutations"
import { GitCommandError, GitRunner } from "../../src/git/runner"
import { createTempRepository, type TempRepository } from "../helpers/temp-repository"

describe("CommitMutations", () => {
  let repo: TempRepository
  let runner: GitRunner
  beforeEach(async () => {
    repo = await createTempRepository()
    runner = new GitRunner({ cwd: repo.path, log: new CommandLog() })
    await repo.write("file.txt", "base\n")
    await repo.git(["add", "--", "file.txt"])
    await repo.git(["commit", "--quiet", "-m", "base"])
  })
  afterEach(async () => repo.cleanup())

  test("commits subject-only and multiline Unicode messages through stdin", async () => {
    await repo.write("file.txt", "change\n")
    await repo.git(["add", "--", "file.txt"])
    const message = "subject Ω\n\nbody 中文"
    await new CommitMutations(runner).commit(message)
    expect((await repo.git(["log", "-1", "--format=%B"])).stdout).toBe(`${message}\n\n`)
    expect(runner.log.lines().at(-1)?.spans.map((span) => span.text).join("")).toBe("  git commit -F -")
  })

  test("rejects an empty message before invoking Git", async () => {
    await expect(new CommitMutations(runner).commit(" \n\t")).rejects.toBeInstanceOf(EmptyCommitMessageError)
    expect(runner.log.lines()).toHaveLength(0)
  })

  test("fails with no staged changes", async () => {
    await expect(new CommitMutations(runner).commit("nothing")).rejects.toBeInstanceOf(GitCommandError)
  })

  test("preserves and edits the existing amend message", async () => {
    const mutations = new CommitMutations(runner)
    await repo.write("file.txt", "amend\n")
    await repo.git(["add", "--", "file.txt"])
    expect(await mutations.currentMessage()).toBe("base\n\n")
    await mutations.amend("edited\n\nbody")
    expect((await repo.git(["log", "-1", "--format=%B"])).stdout).toBe("edited\n\nbody\n\n")
  })

  test("propagates hook failure with the failing stderr on the rejected record", async () => {
    await repo.write("file.txt", "hook\n")
    await repo.git(["add", "--", "file.txt"])
    await repo.write(".git/hooks/commit-msg", "#!/bin/sh\necho hook failed >&2\nexit 1\n")
    await Bun.write(`${repo.path}/.git/hooks/commit-msg`, "#!/bin/sh\necho hook failed >&2\nexit 1\n")
    await Bun.spawn(["chmod", "+x", `${repo.path}/.git/hooks/commit-msg`]).exited
    try {
      await new CommitMutations(runner).commit("hook")
      throw new Error("expected GitCommandError")
    } catch (error) {
      expect(error).toBeInstanceOf(GitCommandError)
      expect((error as GitCommandError).record.stderr).toContain("hook failed")
    }
  })

  test("serializes exported helper calls sharing one runner", async () => {
    await repo.write("file.txt", "concurrent\n")
    await repo.git(["add", "--", "file.txt"])
    await Promise.all([commit(runner, "first"), amend(runner, "second")])
    expect((await repo.git(["log", "-1", "--format=%s"])).stdout.trim()).toBe("second")
    expect(runner.log.lines().filter((line) => line.spans.map((span) => span.text).join("").startsWith("  git commit"))).toHaveLength(2)
  })
})
