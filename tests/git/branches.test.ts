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

/**
 * lazygit's branch status inputs: `parseUpstreamInfo` (branch_loader.go:466-481) turns
 * `%(upstream:short)` and `%(upstream:track)` into ahead/behind counts plus a `gone` flag, and
 * `branch.<name>.remote`/`.merge` (branch_loader.go:120-127) say whether the branch tracks
 * anything at all — including when its remote-tracking ref is not in this repo.
 */
describe("branch upstream state", () => {
  let repository: TempRepository | undefined
  let remote: TempRepository | undefined
  afterEach(async () => {
    await repository?.cleanup()
    await remote?.cleanup()
    repository = undefined
    remote = undefined
  })

  test("a branch level with its upstream reads as zero ahead, zero behind", async () => {
    repository = await createTempRepository()
    await repository.write("file.txt", "base\n")
    await repository.git(["add", "file.txt"])
    await repository.git(["commit", "-m", "base commit"])
    remote = await createTempRepository()
    await remote.git(["config", "core.bare", "true"])
    await repository.git(["remote", "add", "origin", remote.path])
    await repository.git(["push", "-u", "origin", "master"])
    const runner = new GitRunner(repository.path)

    const current = (await listBranches(runner)).localBranches.find((branch) => branch.isCurrent)!
    expect(current.upstreamRemote).toBe("origin")
    expect(current.upstreamBranch).toBe("master")
    expect(current.aheadForPull).toBe("0")
    expect(current.behindForPull).toBe("0")
    expect(current.upstreamGone).toBe(false)
  })

  test("divergence is reported as separate ahead and behind counts", async () => {
    repository = await createTempRepository()
    await repository.write("file.txt", "base\n")
    await repository.git(["add", "file.txt"])
    await repository.git(["commit", "-m", "base commit"])
    remote = await createTempRepository()
    await remote.git(["config", "core.bare", "true"])
    await repository.git(["remote", "add", "origin", remote.path])
    await repository.git(["push", "-u", "origin", "master"])
    // Move the remote-tracking ref forward without moving the branch, then move the branch too.
    await repository.write("file.txt", "remote side\n")
    await repository.git(["add", "file.txt"])
    await repository.git(["commit", "-m", "remote commit"])
    await repository.git(["push", "origin", "master"])
    await repository.git(["reset", "--hard", "HEAD~1", "--quiet"])
    await repository.write("file.txt", "local side\n")
    await repository.git(["add", "file.txt"])
    await repository.git(["commit", "-m", "local commit"])
    const runner = new GitRunner(repository.path)

    const current = (await listBranches(runner)).localBranches.find((branch) => branch.isCurrent)!
    expect(current.aheadForPull).toBe("1")
    expect(current.behindForPull).toBe("1")
  })

  test("a deleted upstream reads as gone with unknown counts", async () => {
    repository = await createTempRepository()
    await repository.write("file.txt", "base\n")
    await repository.git(["add", "file.txt"])
    await repository.git(["commit", "-m", "base commit"])
    remote = await createTempRepository()
    await remote.git(["config", "core.bare", "true"])
    await repository.git(["remote", "add", "origin", remote.path])
    await repository.git(["push", "-u", "origin", "master"])
    await repository.git(["update-ref", "-d", "refs/remotes/origin/master"])
    const runner = new GitRunner(repository.path)

    const current = (await listBranches(runner)).localBranches.find((branch) => branch.isCurrent)!
    // Configured upstream, ref gone: lazygit's `(upstream gone)` row.
    expect(current.upstreamRemote).toBe("origin")
    expect(current.upstreamGone).toBe(true)
    expect(current.aheadForPull).toBe("?")
    expect(current.behindForPull).toBe("?")
  })

  test("a branch tracking nothing reports no upstream remote", async () => {
    repository = await createTempRepository()
    await repository.write("file.txt", "base\n")
    await repository.git(["add", "file.txt"])
    await repository.git(["commit", "-m", "base commit"])
    const runner = new GitRunner(repository.path)

    const current = (await listBranches(runner)).localBranches.find((branch) => branch.isCurrent)!
    expect(current.upstreamRemote).toBeUndefined()
  })
})

describe("listBranches process count", () => {
  let repository: TempRepository | undefined
  afterEach(async () => {
    await repository?.cleanup()
    repository = undefined
  })

  test("stays flat as remotes are added, rather than two `remote get-url` per remote", async () => {
    repository = await createTempRepository()
    await repository.write("file.txt", "base\n")
    await repository.git(["add", "file.txt"])
    await repository.git(["commit", "-m", "base commit"])
    for (const name of ["origin", "fork", "upstream", "mirror", "backup"]) {
      await repository.git(["remote", "add", name, `https://example.com/${name}.git`])
    }
    const runner = new GitRunner(repository.path)

    // listBranches's reads are readOnly, so they are no longer logged (readOnly implies dontLog) —
    // spy on run() calls directly to count spawned processes instead of reading the command log.
    let spawned = 0
    const countingRunner: Pick<GitRunner, "run"> = {
      run: (args, options) => {
        spawned++
        return runner.run(args, options)
      },
    }
    const listing = await listBranches(countingRunner)

    expect(listing.remotes.map((remote) => remote.name).sort()).toEqual(["backup", "fork", "mirror", "origin", "upstream"])
    expect(listing.remotes.find((remote) => remote.name === "fork")!.fetchUrl).toBe("https://example.com/fork.git")
    // One `for-each-ref` for the branches and one `config --get-regexp` for everything else.
    expect(spawned).toBe(2)
  })
})
