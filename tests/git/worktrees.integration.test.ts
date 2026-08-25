import { afterEach, describe, expect, test } from "bun:test"
import { rm } from "node:fs/promises"
import { join } from "node:path"
import { GitRunner } from "../../src/git/runner"
import { listWorktrees } from "../../src/git/worktrees"
import { createTempRepository, type TempRepository } from "../helpers/temp-repository"

describe("worktree loader against a real repository", () => {
  let repository: TempRepository | undefined
  afterEach(async () => {
    await repository?.cleanup()
    repository = undefined
  })

  test("lists the main worktree, linked worktrees, detached heads and missing paths", async () => {
    repository = await createTempRepository()
    await repository.write("file.txt", "base\n")
    await repository.git(["add", "file.txt"])
    await repository.git(["commit", "-m", "base commit"])
    expect((await repository.git(["worktree", "add", "wt-feature", "-b", "feature"])).exitCode).toBe(0)
    expect((await repository.git(["worktree", "add", "--detach", "wt-detached"])).exitCode).toBe(0)
    expect((await repository.git(["worktree", "add", "wt-gone", "-b", "gone"])).exitCode).toBe(0)
    await rm(join(repository.path, "wt-gone"), { recursive: true, force: true })

    const worktrees = await listWorktrees(new GitRunner(repository.path))
    const byName = new Map(worktrees.map((worktree) => [worktree.name, worktree]))
    expect([...byName.keys()].sort()).toEqual(["wt-detached", "wt-feature", "wt-gone", repository.path.split("/").pop()!].sort())

    const main = worktrees[0]!
    expect(main).toMatchObject({ path: repository.path, isMain: true, isCurrent: true, isPathMissing: false, branch: "master" })
    expect(main.gitDir).toBe(join(repository.path, ".git"))
    expect(main.head).toMatch(/^[0-9a-f]{40}$/)
    expect(main.shortHead).toBe(main.head!.slice(0, 8))

    const feature = byName.get("wt-feature")!
    expect(feature).toMatchObject({
      path: join(repository.path, "wt-feature"),
      branch: "feature",
      isMain: false,
      isCurrent: false,
      isPathMissing: false,
    })
    expect(feature.gitDir).toBe(join(repository.path, ".git", "worktrees", "wt-feature"))

    const detached = byName.get("wt-detached")!
    expect(detached.branch).toBeUndefined()
    expect(detached.head).toBe(main.head)
    expect(detached.isPathMissing).toBe(false)

    const gone = byName.get("wt-gone")!
    expect(gone).toMatchObject({ branch: "gone", isPathMissing: true, isMain: false, isCurrent: false })
    expect(gone.gitDir).toBeUndefined()
  })

  test("puts the current worktree first when run from a linked worktree", async () => {
    repository = await createTempRepository()
    await repository.write("file.txt", "base\n")
    await repository.git(["add", "file.txt"])
    await repository.git(["commit", "-m", "base commit"])
    await repository.git(["worktree", "add", "wt-feature", "-b", "feature"])

    const worktrees = await listWorktrees(new GitRunner(join(repository.path, "wt-feature")))
    expect(worktrees[0]).toMatchObject({ name: "wt-feature", isCurrent: true, isMain: false })
    expect(worktrees[1]).toMatchObject({ isCurrent: false, isMain: true, path: repository.path })
  })

  test("recovers the branch of a worktree that is mid-rebase", async () => {
    repository = await createTempRepository()
    await repository.write("file.txt", "one\n")
    await repository.git(["add", "file.txt"])
    await repository.git(["commit", "-m", "one"])
    await repository.git(["checkout", "-q", "-b", "topic"])
    await repository.write("file.txt", "two\n")
    await repository.git(["add", "file.txt"])
    await repository.git(["commit", "-m", "two"])
    await repository.git(["checkout", "-q", "master"])
    await repository.write("file.txt", "three\n")
    await repository.git(["add", "file.txt"])
    await repository.git(["commit", "-m", "three"])
    const rebase = await repository.git(["rebase", "master", "topic"])
    expect(rebase.exitCode).not.toBe(0)

    const worktrees = await listWorktrees(new GitRunner(repository.path))
    expect(worktrees[0]).toMatchObject({ isCurrent: true, isMain: true, branch: "topic" })
  })
})
