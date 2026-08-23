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
    expect(log.records()).toHaveLength(1)
    expect(log.records()[0]).toMatchObject({ cwd: repo.path, args: ["rev-parse", "--show-toplevel"], exitCode: 0 })
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
    expect(log.records()).toHaveLength(1)
    expect(log.records()[0]?.stderr).toContain("fatal")
  })

  test("passes filenames as arguments without shell interpretation", async () => {
    const filename = "safe name; echo SHOULD_NOT_RUN.txt"
    await repo.write(filename, "safe")

    const result = await runner.run(["status", "--short", "--", filename])
    expect(result.stdout).toContain(filename)
    expect(log.records()).toHaveLength(1)
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
