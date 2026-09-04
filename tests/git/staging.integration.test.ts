import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { parseDiff } from "../../src/domain/diff/parse"
import { GitMutations } from "../../src/git/mutations"
import { GitRunner } from "../../src/git/runner"
import { createTempRepository, type TempRepository } from "../helpers/temp-repository"

function withoutIndex(raw: string): string {
  return raw.split("\n").filter((line) => !line.startsWith("index ")).join("\n")
}

describe("GitMutations", () => {
  let repo: TempRepository
  let runner: GitRunner
  beforeEach(async () => {
    repo = await createTempRepository()
    runner = new GitRunner({ cwd: repo.path })
    await repo.write("file.txt", "base\nkeep\n")
    await repo.git(["add", "--", "file.txt"])
    await repo.git(["commit", "--quiet", "-m", "base"])
  })

  afterEach(async () => {
    await repo.cleanup()
  })

  test("stages only selected additions and leaves the remainder unstaged", async () => {
    await repo.write("file.txt", "base\nfirst\nkeep\nsecond\n")
    const patch = (await runner.run(["diff", "--no-ext-diff", "--no-color", "--", "file.txt"], { readOnly: true })).stdout
    const document = parseDiff(patch)
    const selected = document.lines.flatMap((line, index) => line.raw === "+first\n" ? [index] : [])
    await new GitMutations(runner).applySelection(document, selected, { reverse: false, wholeFile: false })
    const staged = (await repo.git(["diff", "--cached", "--no-color", "--binary", "--", "file.txt"])).stdout
    const unstaged = (await repo.git(["diff", "--no-color", "--binary", "--", "file.txt"])).stdout
    expect(withoutIndex(staged)).toBe([
      "diff --git a/file.txt b/file.txt",
      "--- a/file.txt",
      "+++ b/file.txt",
      "@@ -1,2 +1,3 @@",
      " base",
      "+first",
      " keep",
      "",
    ].join("\n"))
    expect(withoutIndex(unstaged)).toBe([
      "diff --git a/file.txt b/file.txt",
      "--- a/file.txt",
      "+++ b/file.txt",
      "@@ -1,3 +1,4 @@",
      " base",
      " first",
      " keep",
      "+second",
      "",
    ].join("\n"))
  })

  test("stages a batch of files and refreshes once", async () => {
    await repo.write("first.txt", "first\n")
    await repo.write("second.txt", "second\n")
    let refreshes = 0
    const mutations = new GitMutations(runner, async () => { refreshes += 1 })

    await mutations.stageFiles(["first.txt", "second.txt"])

    expect((await repo.git(["diff", "--cached", "--name-only"])).stdout.split("\n").filter(Boolean)).toEqual(["first.txt", "second.txt"])
    expect(refreshes).toBe(1)
  })
  test("refreshes after a partially failed stage batch and rethrows the mutation error", async () => {
    await repo.write("first.txt", "first\n")
    let refreshes = 0
    const mutations = new GitMutations(runner, async () => { refreshes += 1 })

    await expect(mutations.stageFiles(["first.txt", "missing.txt"])).rejects.toThrow()

    expect((await repo.git(["diff", "--cached", "--name-only"])).stdout.trim()).toBe("first.txt")
    expect(refreshes).toBe(1)
  })
  test("preserves the mutation error when failure refresh also rejects", async () => {
    let refreshes = 0
    const mutations = new GitMutations(runner, async () => {
      refreshes += 1
      throw new Error("refresh failed")
    })

    const error = await mutations.stageFiles(["missing.txt"]).catch((failure: unknown) => failure)

    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toContain("missing.txt")
    expect((error as Error).message).not.toBe("refresh failed")
    expect(refreshes).toBe(1)
  })


  test("refreshes after a partially failed unstage batch and rethrows the mutation error", async () => {
    await repo.write("first.txt", "first\n")
    await repo.git(["add", "--", "first.txt"])
    let refreshes = 0
    const mutations = new GitMutations(runner, async () => { refreshes += 1 })

    await expect(mutations.unstageFiles(["first.txt", "missing.txt"])).rejects.toThrow()

    expect((await repo.git(["diff", "--cached", "--name-only"])).stdout).toBe("")
    expect(refreshes).toBe(1)
  })

  test("refreshes after a partially failed discard batch and rethrows the mutation error", async () => {
    await repo.write("first.txt", "first\n")
    let refreshes = 0
    const mutations = new GitMutations(runner, async () => { refreshes += 1 })

    await expect(mutations.discardFiles(["first.txt", "/"], "unstaged")).rejects.toThrow()

    expect((await repo.git(["status", "--short"])).stdout).toBe("")
    expect(refreshes).toBe(1)
  })

  test("unstages a batch and refreshes once on success", async () => {
    await repo.write("first.txt", "first\n")
    await repo.write("second.txt", "second\n")
    await repo.git(["add", "--", "first.txt", "second.txt"])
    let refreshes = 0
    const mutations = new GitMutations(runner, async () => { refreshes += 1 })

    await mutations.unstageFiles(["first.txt", "second.txt"])

    expect((await repo.git(["diff", "--cached", "--name-only"])).stdout).toBe("")
    expect(refreshes).toBe(1)
  })

  test("discards a batch and refreshes once on success", async () => {
    await repo.write("first.txt", "first\n")
    await repo.write("second.txt", "second\n")
    let refreshes = 0
    const mutations = new GitMutations(runner, async () => { refreshes += 1 })

    await mutations.discardFiles(["first.txt", "second.txt"], "unstaged")

    expect((await repo.git(["status", "--short"])).stdout).toBe("")
    expect(refreshes).toBe(1)
  })

  test("discards a batch of files and refreshes once", async () => {
    await repo.write("file.txt", "base\nchanged\n")
    await repo.write("untracked.txt", "remove me\n")
    let refreshes = 0
    const mutations = new GitMutations(runner, async () => { refreshes += 1 })

    await mutations.discardFiles(["file.txt", "untracked.txt"], "all")

    expect((await repo.git(["status", "--short"])).stdout).toBe("")
    expect(refreshes).toBe(1)
  })


  test("serially stages a file and then unstages it without losing the change", async () => {
    await repo.write("file.txt", "base\nchanged\n")
    const mutations = new GitMutations(runner)
    await Promise.all([mutations.stageFile("file.txt"), mutations.unstageFile("file.txt")])
    const status = (await repo.git(["status", "--short"])).stdout
    expect(status).toContain(" M file.txt")
  })

  test("discards only selected working-tree additions after exact patch confirmation", async () => {
    await repo.write("file.txt", "base\nfirst\nkeep\nsecond\n")
    const patch = (await runner.run(["diff", "--no-ext-diff", "--no-color", "--", "file.txt"], { readOnly: true })).stdout
    const document = parseDiff(patch)
    const selected = document.lines.flatMap((line, index) => line.raw === "+first\n" ? [index] : [])
    await new GitMutations(runner).discardSelection(document, selected, { wholeFile: false })

    const content = await Bun.file(`${repo.path}/file.txt`).text()
    expect(content).toBe("base\nkeep\nsecond\n")
  })

  test("stages a selected deletion from a file that is being deleted", async () => {
    await repo.write("file.txt", "")
    const patch = (await runner.run(["diff", "--no-ext-diff", "--no-color", "--", "file.txt"], { readOnly: true })).stdout
    const document = parseDiff(patch)
    const selected = document.lines.flatMap((line, index) => line.raw === "-base\n" ? [index] : [])
    await new GitMutations(runner).applySelection(document, selected, { reverse: false, wholeFile: false })

    const staged = (await repo.git(["diff", "--cached", "--no-color", "--binary", "--", "file.txt"])).stdout
    const unstaged = (await repo.git(["diff", "--no-color", "--binary", "--", "file.txt"])).stdout
    expect(withoutIndex(staged)).toBe([
      "diff --git a/file.txt b/file.txt",
      "--- a/file.txt",
      "+++ b/file.txt",
      "@@ -1,2 +1 @@",
      "-base",
      " keep",
      "",
    ].join("\n"))
    expect(withoutIndex(unstaged)).toBe([
      "diff --git a/file.txt b/file.txt",
      "--- a/file.txt",
      "+++ b/file.txt",
      "@@ -1 +0,0 @@",
      "-keep",
      "",
    ].join("\n"))
  })

  test("stages a selected change in a quoted Unicode path", async () => {
    await repo.write("é.txt", "base\n")
    await repo.git(["add", "--", "é.txt"])
    await repo.git(["commit", "--quiet", "-m", "unicode"])
    await repo.write("é.txt", "base\nchanged\n")
    const patch = (await runner.run(["diff", "--no-ext-diff", "--no-color", "--", "é.txt"], { readOnly: true })).stdout
    const document = parseDiff(patch)
    const selected = document.lines.flatMap((line, index) => line.raw === "+changed\n" ? [index] : [])
    await new GitMutations(runner).applySelection(document, selected, { reverse: false, wholeFile: false })
    const actual = (await repo.git(["diff", "--cached", "--no-color", "--binary", "--", "é.txt"])).stdout
    expect(withoutIndex(actual)).toBe([
      "diff --git \"a/\\303\\251.txt\" \"b/\\303\\251.txt\"",
      "--- \"a/\\303\\251.txt\"",
      "+++ \"b/\\303\\251.txt\"",
      "@@ -1 +1,2 @@",
      " base",
      "+changed",
      "",
    ].join("\n"))
  })

  test("discards an untracked file only through clean", async () => {
    await repo.write("untracked.txt", "remove me\n")
    const mutations = new GitMutations(runner)
    await mutations.discardFile("untracked.txt", "all")
    expect((await repo.git(["status", "--short"])).stdout).not.toContain("untracked.txt")
  })
  test("discards an untracked nested git repository", async () => {
    await repo.write("nested/inner.txt", "inner\n")
    await new GitRunner({ cwd: join(repo.path, "nested") }).run(["init", "--quiet"])
    expect((await repo.git(["status", "--short"])).stdout).toContain("nested/")
    const mutations = new GitMutations(runner)
    await mutations.discardFile("nested/", "all")
    expect((await repo.git(["status", "--short"])).stdout).not.toContain("nested")
  })

  test("separates discarding unstaged changes from all changes", async () => {
    await repo.write("file.txt", "base\nstaged\n")
    await repo.git(["add", "--", "file.txt"])
    await repo.write("file.txt", "base\nstaged\nunstaged\n")
    const mutations = new GitMutations(runner)

    await mutations.discardFile("file.txt", "unstaged")
    expect((await repo.git(["diff", "--cached", "--name-only"])).stdout).toContain("file.txt")
    expect((await repo.git(["diff", "--name-only"])).stdout).toBe("")

    await mutations.discardFile("file.txt", "all")
    expect((await repo.git(["status", "--short"])).stdout).toBe("")
  })
})
