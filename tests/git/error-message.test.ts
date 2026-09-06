import { describe, expect, test } from "bun:test"
import { describeGitError } from "../../src/git/error-message"
import { GitCommandError } from "../../src/git/runner"
import type { CommandRecord } from "../../src/domain/command"

function record(overrides: Partial<CommandRecord>): CommandRecord {
  return { id: 1, cwd: "/tmp/repo", args: ["fetch"], startedAt: "2026-09-06T00:00:00.000Z", durationMs: 1, exitCode: 1, stdout: "", stderr: "", ...overrides }
}

describe("describeGitError", () => {
  test("prefers stderr of a failed git command", () => {
    const error = new GitCommandError(record({ exitCode: 128, stderr: "fatal: could not read from remote" }))
    expect(describeGitError(error)).toBe("fatal: could not read from remote")
  })

  test("falls back to the command error message when stderr is empty", () => {
    const error = new GitCommandError(record({ exitCode: 1, stderr: "" }))
    expect(describeGitError(error)).toBe("git fetch failed with exit code 1")
  })

  test("uses the message of a plain Error", () => {
    expect(describeGitError(new Error("boom"))).toBe("boom")
  })

  test("stringifies anything else", () => {
    expect(describeGitError(42)).toBe("42")
  })
})
