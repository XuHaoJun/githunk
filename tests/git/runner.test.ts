import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { CommandLog } from "../../src/app/command-log"
import { GitCommandError, GitRunner } from "../../src/git/runner"
import { createTempRepository, type TempRepository } from "../helpers/temp-repository"

describe("GitRunner", () => {
  let repo: TempRepository
  let log: CommandLog
  let runner: GitRunner

  beforeEach(async () => {
    repo = await createTempRepository()
    log = new CommandLog()
    runner = new GitRunner({ cwd: repo.path, log })
  })

  afterEach(async () => {
    await repo.cleanup()
  })

  test("returns successful stdout and records the command", async () => {
    const result = await runner.run(["rev-parse", "--show-toplevel"])

    expect(result.stdout.trim()).toBe(repo.path)
    expect(result.exitCode).toBe(0)
    expect(log.lines()).toHaveLength(1)
    expect(log.lines()[0]?.spans.map((span) => span.text).join("")).toBe("  git rev-parse --show-toplevel")
  })

  test("delivers stdin to Git", async () => {
    const result = await runner.run(["hash-object", "--stdin"], { stdin: "hello from githunk\n" })

    expect(result.stdout.trim()).toBe("c46baf9a2d1ee30f66f7a6543d5336917ce53bdb")
  })

  test("allows explicitly accepted read-only non-zero exits", async () => {
    const result = await runner.run(
      ["diff", "--no-index", "--", "/dev/null", "new file.ts"],
      { acceptedExitCodes: [0, 1], readOnly: true },
    )

    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain("new file.ts")
  })

  test("rejects non-zero exits with the complete command record", async () => {
    await expect(runner.run(["rev-parse", "--verify", "missing-ref"])).rejects.toMatchObject({
      record: { exitCode: 128, args: ["rev-parse", "--verify", "missing-ref"], cwd: repo.path },
    })
    expect(log.lines()).toHaveLength(1)
    expect(log.lines()[0]?.spans.map((span) => span.text).join("")).toBe("  git rev-parse --verify missing-ref")
  })

  test("passes filenames as arguments without shell interpretation", async () => {
    const filename = "safe name; echo SHOULD_NOT_RUN.txt"
    await repo.write(filename, "safe")

    const result = await runner.run(["status", "--short", "--", filename])
    expect(result.stdout).toContain(filename)
    expect(log.lines()).toHaveLength(1)
  })

  test("uses the configured working directory", async () => {
    const result = await runner.run(["rev-parse", "--show-prefix"])

    expect(result.stdout.trim()).toBe("")
    expect(result.record.cwd).toBe(repo.path)
  })

  test("exposes GitCommandError for rejected exits", async () => {
    try {
      await runner.run(["rev-parse", "--verify", "missing-ref"])
      throw new Error("expected GitCommandError")
    } catch (error) {
      expect(error).toBeInstanceOf(GitCommandError)
      expect((error as GitCommandError).record.stdout).toBe("")
    }
  })
})

/**
 * lazygit suppresses `index.lock` on every git command by default
 * (pkg/commands/git_cmd_obj_builder.go:35-38), with exactly one exception: a foreground files
 * refresh lets git take the lock so it persists the stat-cache it just refreshed, keeping later
 * status calls fast (pkg/commands/git_commands/file_loader.go:228-236).
 *
 * The observable difference is whether `git status` writes `.git/index` back after re-stat'ing a
 * file whose mtime moved: with the lock suppressed it cannot, so the next status re-stats the file
 * all over again.
 */
describe("GIT_OPTIONAL_LOCKS", () => {
  let repository: TempRepository | undefined
  afterEach(async () => {
    await repository?.cleanup()
    repository = undefined
  })

  /** A tracked file whose content matches the index but whose mtime does not. */
  async function repositoryWithStaleStatCache(): Promise<TempRepository> {
    const created = await createTempRepository()
    await created.write("a.txt", "one\n")
    await created.git(["add", "a.txt"])
    await created.git(["commit", "-m", "first"])
    // Settle the cache, then move the mtime without changing the bytes.
    await created.git(["status", "--porcelain"])
    await new Promise((resolve) => setTimeout(resolve, 1100))
    await created.write("a.txt", "one\n")
    return created
  }

  const indexMtime = async (path: string): Promise<number> => (await Bun.file(`${path}/.git/index`).stat()).mtimeMs

  test("a read cannot persist the refreshed stat-cache", async () => {
    repository = await repositoryWithStaleStatCache()
    const runner = new GitRunner(repository.path)
    const before = await indexMtime(repository.path)
    await runner.run(["status", "--porcelain=v2", "-z"], { readOnly: true })
    expect(await indexMtime(repository.path)).toBe(before)
  })

  test("optionalLocks lets that one read persist it", async () => {
    repository = await repositoryWithStaleStatCache()
    const runner = new GitRunner(repository.path)
    const before = await indexMtime(repository.path)
    await runner.run(["status", "--porcelain=v2", "-z"], { readOnly: true, optionalLocks: true })
    expect(await indexMtime(repository.path)).toBeGreaterThan(before)
  })
})
