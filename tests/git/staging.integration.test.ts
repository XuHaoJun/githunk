import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { parseDiff } from "../../src/domain/diff/parse"
import { GitMutations } from "../../src/git/mutations"
import { GitRunner } from "../../src/git/runner"
import { createTempRepository, type TempRepository } from "../helpers/temp-repository"

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

    const staged = (await repo.git(["diff", "--cached", "--", "file.txt"])).stdout
    const unstaged = (await repo.git(["diff", "--", "file.txt"])).stdout
    expect(staged).toContain("+first\n")
    expect(staged).not.toContain("+second\n")
    expect(unstaged).toContain("+second\n")
    expect(unstaged).not.toContain("+first\n")
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
})
