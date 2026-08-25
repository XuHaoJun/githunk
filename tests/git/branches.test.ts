import { afterEach, describe, expect, test } from "bun:test"
import { GitRunner } from "../../src/git/runner"
import { listBranches } from "../../src/git/branches"
import { createTempRepository, type TempRepository } from "../helpers/temp-repository"

describe("branch and remote loaders", () => {
  let repository: TempRepository | undefined
  let remote: TempRepository | undefined
  afterEach(async () => {
    await repository?.cleanup()
    await remote?.cleanup()
    repository = undefined
    remote = undefined
  })

  test("loads branch recency, subject, upstream track, and remote URLs", async () => {
    repository = await createTempRepository()
    await repository.write("file.txt", "base\n")
    await repository.git(["add", "file.txt"])
    await repository.git(["commit", "-m", "base commit"])
    remote = await createTempRepository()
    await remote.git(["config", "core.bare", "true"])
    await repository.git(["remote", "add", "origin", remote.path])
    await repository.git(["push", "-u", "origin", "master"])
    await repository.write("file.txt", "ahead\n")
    await repository.git(["add", "file.txt"])
    await repository.git(["commit", "-m", "ahead commit"])
    const runner = new GitRunner(repository.path)
    const listing = await listBranches(runner)
    const current = listing.localBranches.find((branch) => branch.isCurrent)!
    expect(current.committedAt!).toMatch(/^\d+$/)
    expect(current.subject!.length).toBeGreaterThan(0)
    expect(listing.remotes[0]).toMatchObject({
      name: "origin",
      fetchUrl: expect.any(String),
      pushUrl: expect.any(String),
    })
    expect(current.upstreamTrack!).toContain("ahead")
  })
})
