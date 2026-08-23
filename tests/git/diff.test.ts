import { describe, expect, test } from "bun:test"
import { loadWorkingTree, parseNumstat } from "../../src/git/diff"
import { GitRunner } from "../../src/git/runner"
import { createTempRepository } from "../helpers/temp-repository"
import type { GitResult } from "../../src/git/runner"

type Call = { args: readonly string[]; options: { acceptedExitCodes?: readonly number[] } | undefined }

function fakeRunner(results: GitResult[], calls: Call[]) {
  return {
    async run(args: readonly string[], options?: Call["options"]): Promise<GitResult> {
      calls.push({ args, options })
      const result = results.shift()
      if (result === undefined) throw new Error("unexpected git call")
      return result
    },
  } as never
}

function result(stdout: string): GitResult {
  return {
    exitCode: 0,
    stdout,
    stderr: "",
    record: {
      id: 1,
      cwd: "/tmp/repo",
      args: [],
      startedAt: "2026-01-01T00:00:00.000Z",
      durationMs: 1,
      exitCode: 0,
      stdout,
      stderr: "",
    },
  }
}

describe("working tree diff loading", () => {
  test("keeps staged and unstaged sections and includes untracked patch", async () => {
    const calls: Call[] = []
    const snapshot = await loadWorkingTree(
      fakeRunner(
        [
          result("# branch.head main\0? notes.txt\0"),
          result(""),
          result("1\t2\tnotes.txt\0"),
          result("UNSTAGED RAW\n"),
          result("STAGED RAW\n"),
          { ...result("UNTRACKED CONTENT\n"), exitCode: 1 },
        ],
        calls,
      ),
      "all",
    )

    expect(snapshot.patches).toEqual([
      { label: "STAGED", text: "STAGED RAW\n" },
      { label: "UNSTAGED", text: "UNSTAGED RAW\nUNTRACKED CONTENT\n" },
    ])
    expect(snapshot.files[0]?.path).toBe("notes.txt")
    expect(snapshot.files[0]?.additions).toBe(1)
    expect(calls.at(-1)?.options?.acceptedExitCodes).toEqual([0, 1])
    expect(calls.at(-1)?.args).toEqual([
      "diff",
      "--no-index",
      "--no-ext-diff",
      "--no-color",
      "--binary",
      "--",
      "/dev/null",
      "notes.txt",
    ])
  })
  test("renders real untracked file content in the unstaged patch", async () => {
    const repository = await createTempRepository()
    try {
      await repository.write("tracked.txt", "tracked\n")
      expect((await repository.git(["add", "tracked.txt"])).exitCode).toBe(0)
      expect((await repository.git(["commit", "-qm", "initial"])).exitCode).toBe(0)
      await repository.write("notes/子 🧪.txt", "untracked content\n")

      const snapshot = await loadWorkingTree(new GitRunner(repository.path), "unstaged")

      expect(snapshot.files.map((file) => file.path)).toEqual(["notes/子 🧪.txt"])
      expect(snapshot.patches).toEqual([
        { label: "UNSTAGED", text: expect.stringContaining("+untracked content") },
      ])
    } finally {
      await repository.cleanup()
    }
  })

 
  test("parses NUL-separated rename numstat paths", () => {
    expect(parseNumstat("1\t0\t\0old name.txt\0new name.txt\0")).toEqual([
      { path: "new name.txt", previousPath: "old name.txt", additions: 1, deletions: 0 },
    ])
  })
})
