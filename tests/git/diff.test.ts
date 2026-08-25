import { afterEach, describe, expect, test } from "bun:test"
import { loadWorkingTree, parseNumstat } from "../../src/git/diff"
import { GitRunner } from "../../src/git/runner"
import { createTempRepository, type TempRepository } from "../helpers/temp-repository"
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
        // Call order: the five reads that need nothing from each other go out together — status,
        // both numstats, both patches — and only then the per-untracked-file numstat and patch.
        [
          result("# branch.head main\0? notes.txt\0"),
          result(""),
          result("1\t2\tnotes.txt\0"),
          result("UNSTAGED RAW\n"),
          result("STAGED RAW\n"),
          result("1\t0\tnotes.txt\0"),
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
    expect(snapshot.files[0]?.additions).toBe(2)
    expect(snapshot.files[0]?.deletions).toBe(2)
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

      expect(snapshot.files[0]?.additions).toBe(1)
      expect(snapshot.files[0]?.deletions).toBe(0)
      expect(snapshot.files.map((file) => file.path)).toEqual(["notes/子 🧪.txt"])
      expect(snapshot.patches).toEqual([
        { label: "UNSTAGED", text: expect.stringContaining("+untracked content") },
      ])
    } finally {
      await repository.cleanup()
    }
  })

 
  test("includes every file from an untracked directory", async () => {
    const repository = await createTempRepository()
    try {
      await repository.write("tracked.txt", "tracked\n")
      expect((await repository.git(["add", "tracked.txt"])).exitCode).toBe(0)
      expect((await repository.git(["commit", "-qm", "initial"])).exitCode).toBe(0)
      await repository.write("new-dir/first.txt", "first\n")
      await repository.write("new-dir/second.txt", "second\n")

      const snapshot = await loadWorkingTree(new GitRunner(repository.path), "unstaged")

      expect(snapshot.files.map((file) => file.path)).toEqual(["new-dir/first.txt", "new-dir/second.txt"])
      const patch = snapshot.patches[0]?.text ?? ""
      expect(patch).toContain("new-dir/first.txt")
      expect(patch).toContain("+first")
      expect(patch).toContain("new-dir/second.txt")
      expect(patch).toContain("+second")
    } finally {
      await repository.cleanup()
    }
  })

  test("preserves binary diff patches and reports zero line counts", async () => {
    const repository = await createTempRepository()
    try {
      await repository.write("image.bin", "PNG\u0000\u0001old\u0000bytes")
      expect((await repository.git(["add", "image.bin"])).exitCode).toBe(0)
      expect((await repository.git(["commit", "-qm", "initial"])).exitCode).toBe(0)
      await repository.write("image.bin", "PNG\u0000\u0002new\u0000bytes")

      const snapshot = await loadWorkingTree(new GitRunner(repository.path), "unstaged")

      expect(snapshot.files).toEqual([{
        path: "image.bin",
        indexStatus: ".",
        worktreeStatus: "M",
        untracked: false,
        conflicted: false,
        additions: 0,
        deletions: 0,
      }])
      expect(snapshot.patches[0]?.text).toContain("GIT binary patch")
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

/**
 * The working-tree reads are independent of one another — only the per-untracked-file work needs
 * the status output — so they run together rather than one after another. lazygit's refresh
 * likewise fans its loaders out across goroutines (pkg/gui/controllers/helpers/refresh_helper.go).
 */
describe("loadWorkingTree process scheduling", () => {
  let repository: TempRepository | undefined
  afterEach(async () => {
    await repository?.cleanup()
    repository = undefined
  })

  /** Wraps a runner so overlapping `run` calls are counted. */
  function overlapCounting(runner: GitRunner): { readonly runner: GitRunner; peak(): number } {
    let inFlight = 0
    let peak = 0
    const original = runner.run.bind(runner)
    const patched = runner as unknown as { run: GitRunner["run"] }
    patched.run = async (args, options) => {
      inFlight += 1
      peak = Math.max(peak, inFlight)
      try {
        return await original(args, options)
      } finally {
        inFlight -= 1
      }
    }
    return { runner, peak: () => peak }
  }

  test("the status, numstat and patch reads overlap instead of queueing", async () => {
    repository = await createTempRepository()
    await repository.write("tracked.txt", "one\n")
    await repository.git(["add", "tracked.txt"])
    await repository.git(["commit", "-m", "first"])
    await repository.write("tracked.txt", "two\n")
    await repository.write("staged.txt", "staged\n")
    await repository.git(["add", "staged.txt"])
    const counted = overlapCounting(new GitRunner(repository.path))

    const snapshot = await loadWorkingTree(counted.runner, "all")

    expect(snapshot.files.map((file) => file.path).sort()).toEqual(["staged.txt", "tracked.txt"])
    // Five independent reads: status, two numstats, two patches.
    expect(counted.peak()).toBeGreaterThanOrEqual(5)
  })

  test("many untracked files are diffed concurrently, under a ceiling", async () => {
    repository = await createTempRepository()
    await repository.write("tracked.txt", "one\n")
    await repository.git(["add", "tracked.txt"])
    await repository.git(["commit", "-m", "first"])
    for (let index = 0; index < 20; index++) {
      await repository.write(`new-${index}.txt`, `content ${index}\n`)
    }
    const counted = overlapCounting(new GitRunner(repository.path))

    const snapshot = await loadWorkingTree(counted.runner, "unstaged")

    expect(snapshot.files.filter((file) => file.untracked).length).toBe(20)
    // Each untracked file still gets its own numstat and patch, in path order.
    for (let index = 0; index < 20; index++) {
      expect(snapshot.patches.map((section) => section.text).join("")).toContain(`new-${index}.txt`)
    }
    expect(counted.peak()).toBeGreaterThan(1)
    // Two pools of 8, plus whatever of the five head reads is still in flight.
    expect(counted.peak()).toBeLessThanOrEqual(21)
  })
})
