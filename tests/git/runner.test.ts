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
    // The command line itself, plus its failure output under "Git output:" — see "a failed
    // command's stderr lands under the same heading" below for the shape of that. Pinned here as
    // an exact count: command line, blank line, heading, one stderr line ("fatal: Needed a single
    // revision").
    const texts = log.lines().map((line) => line.spans.map((span) => span.text).join(""))
    expect(texts).toHaveLength(4)
    expect(texts[0]).toBe("  git rev-parse --verify missing-ref")
    expect(texts[1]).toBe("")
    expect(texts[2]).toBe("Git output:")
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

  /**
   * lazygit marks each of its 80 read paths DontLog() by hand
   * (pkg/commands/git_commands/status.go:98,135,140; commit_loader.go:294,571,605;
   * stash_loader.go:36,71; file_loader.go:133,213,228; config.go:83). githunk gets the same set
   * from one rule, because `readOnly` already marks exactly the reads.
   */
  test("a readOnly command is not logged", async () => {
    await runner.run(["rev-parse", "--show-toplevel"], { readOnly: true })
    expect(log.lines()).toEqual([])
  })

  test("a readOnly command can opt back in with an explicit dontLog: false", async () => {
    await runner.run(["rev-parse", "--show-toplevel"], { readOnly: true, dontLog: false })
    expect(log.lines()).toHaveLength(1)
  })

  test("a write can opt out with an explicit dontLog, as the background fetch does", async () => {
    await runner.run(["rev-parse", "--show-toplevel"], { dontLog: true })
    expect(log.lines()).toEqual([])
  })

  test("logs the command before it runs, so a slow command is visible while it runs", async () => {
    const seen: number[] = []
    const promise = runner.run(["rev-parse", "--show-toplevel"])
    seen.push(log.lines().length)
    await promise
    seen.push(log.lines().length)
    expect(seen).toEqual([1, 1])
  })

  /**
   * lazygit writes command output into the panel only for the commands it streams — the ones with a
   * credential strategy, i.e. push/pull/fetch (cmd_obj_runner.go:234-246,
   * git_commands/sync.go:44,110,69) — behind `prefixWriter`'s magenta `Git output:`
   * (extras_panel.go:96-98).
   */
  test("streamOutput puts the output under a Git output: heading", async () => {
    await runner.run(["rev-parse", "--show-toplevel"], { streamOutput: true })
    const texts = log.lines().map((line) => line.spans.map((span) => span.text).join(""))
    expect(texts[0]).toBe("  git rev-parse --show-toplevel")
    expect(texts[1]).toBe("")
    expect(texts[2]).toBe("Git output:")
    expect(texts[3]).toBe(repo.path)
  })

  /**
   * githunk's one deliberate deviation. lazygit raises an error popup for a non-streamed failure
   * and writes nothing to the log; githunk has no popup — a failed mutation shows as a pane
   * bottomTitle — and PRD 6.7 requires command failures stay inspectable.
   */
  test("a failed command's stderr lands under the same heading", async () => {
    await expect(runner.run(["rev-parse", "--verify", "missing-ref"])).rejects.toThrow()
    const texts = log.lines().map((line) => line.spans.map((span) => span.text).join(""))
    expect(texts[0]).toBe("  git rev-parse --verify missing-ref")
    expect(texts[2]).toBe("Git output:")
    expect(texts.slice(3).join("\n")).toContain("fatal")
  })

  test("a succeeding command's stdout stays out of the log", async () => {
    await runner.run(["rev-parse", "--show-toplevel"])
    const texts = log.lines().map((line) => line.spans.map((span) => span.text).join(""))
    expect(texts).toEqual(["  git rev-parse --show-toplevel"])
  })

  test("an accepted non-zero exit is not a failure and logs no output", async () => {
    await runner.run(["rev-parse", "--verify", "--quiet", "missing-ref"], { acceptedExitCodes: [0, 1], dontLog: false })
    const texts = log.lines().map((line) => line.spans.map((span) => span.text).join(""))
    expect(texts).toEqual(["  git rev-parse --verify --quiet missing-ref"])
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
