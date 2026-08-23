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
    await mutations.discardFile("untracked.txt", true)
    expect((await repo.git(["status", "--short"])).stdout).not.toContain("untracked.txt")
  })
})
