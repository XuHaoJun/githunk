import { afterEach, describe, expect, test } from "bun:test"
import { GitRunner } from "../../src/git/runner"
import { loadRefLog, refLogArgs, refLogFullName } from "../../src/git/ref-log"
import { createTempRepository, type TempRepository } from "../helpers/temp-repository"

describe("refLogFullName", () => {
  test("qualifies each ref kind the branches panel can select", () => {
    expect(refLogFullName({ kind: "local-branch", name: "main" })).toBe("refs/heads/main")
    expect(refLogFullName({ kind: "remote-branch", name: "origin/feature" })).toBe("refs/remotes/origin/feature")
    expect(refLogFullName({ kind: "tag", name: "v1.0" })).toBe("refs/tags/v1.0")
  })

  test("leaves an already-qualified ref alone", () => {
    expect(refLogFullName({ kind: "local-branch", name: "refs/heads/main" })).toBe("refs/heads/main")
  })
})

describe("refLogArgs", () => {
  test("matches lazygit's branchLogCmd, with the ref behind --end-of-options", () => {
    expect(refLogArgs("refs/heads/main", 300)).toEqual([
      "log",
      "--graph",
      "--color=always",
      "--abbrev-commit",
      "--decorate",
      "--date=relative",
      "--pretty=medium",
      "-n",
      "300",
      "--end-of-options",
      "refs/heads/main",
      "--",
    ])
  })

  test("a ref that looks like an option cannot become one", () => {
    expect(refLogArgs("refs/heads/--help", 10)).toContain("--end-of-options")
    expect(refLogArgs("refs/heads/--help", 10).at(-2)).toBe("refs/heads/--help")
  })
})

describe("loadRefLog", () => {
  let repository: TempRepository | undefined
  afterEach(async () => {
    await repository?.cleanup()
    repository = undefined
  })

  test("returns git's own coloured graph for a branch", async () => {
    repository = await createTempRepository()
    await repository.write("file.txt", "base\n")
    await repository.git(["add", "file.txt"])
    await repository.git(["commit", "-m", "base commit"])
    const runner = new GitRunner(repository.path)
    const head = (await runner.run(["symbolic-ref", "--short", "HEAD"])).stdout.trim()

    const raw = await loadRefLog(runner, `refs/heads/${head}`)

    expect(raw).toContain("base commit")
    expect(raw).toContain("Author:")
    // --color=always means git, not a pager, emits the SGR sequences we re-render.
    expect(raw).toContain("\u001b[")
  })

  test("an unknown ref surfaces git's error rather than an empty pane", async () => {
    repository = await createTempRepository()
    await repository.write("file.txt", "base\n")
    await repository.git(["add", "file.txt"])
    await repository.git(["commit", "-m", "base commit"])
    const runner = new GitRunner(repository.path)

    await expect(loadRefLog(runner, "refs/heads/does-not-exist")).rejects.toThrow()
  })
})
