import { afterEach, describe, expect, test } from "bun:test"
import { RefsWatcher } from "../../src/app/refs-watcher"
import { loadRefsSnapshot } from "../../src/git/refs-snapshot"
import { GitRunner } from "../../src/git/runner"
import { createTempRepository, type TempRepository } from "../helpers/temp-repository"

describe("loadRefsSnapshot", () => {
  let repository: TempRepository | undefined
  afterEach(async () => {
    await repository?.cleanup()
    repository = undefined
  })

  async function repositoryWithCommit(): Promise<TempRepository> {
    const created = await createTempRepository()
    await created.write("a.txt", "one\n")
    await created.git(["add", "a.txt"])
    await created.git(["commit", "-m", "first"])
    return created
  }

  test("changes when a branch moves", async () => {
    repository = await repositoryWithCommit()
    const runner = new GitRunner(repository.path)
    const before = await loadRefsSnapshot(runner)
    await repository.write("a.txt", "two\n")
    await repository.git(["add", "a.txt"])
    await repository.git(["commit", "-m", "second"])
    expect(await loadRefsSnapshot(runner)).not.toBe(before)
  })

  test("changes when a branch is created or deleted", async () => {
    repository = await repositoryWithCommit()
    const runner = new GitRunner(repository.path)
    const before = await loadRefsSnapshot(runner)
    await repository.git(["branch", "feature"])
    const withBranch = await loadRefsSnapshot(runner)
    expect(withBranch).not.toBe(before)
    await repository.git(["branch", "-D", "feature"])
    expect(await loadRefsSnapshot(runner)).toBe(before)
  })

  test("changes when HEAD detaches from a branch it still points at", async () => {
    // The refs half alone cannot see this — no hash moved — and it is exactly what happens at the
    // end of a rebase, in reverse (status.go:111-121).
    repository = await repositoryWithCommit()
    const runner = new GitRunner(repository.path)
    const attached = await loadRefsSnapshot(runner)
    await repository.git(["checkout", "--detach", "HEAD", "--quiet"])
    const detached = await loadRefsSnapshot(runner)
    expect(detached).not.toBe(attached)
  })

  test("is stable when nothing changes, and survives a repo with no commits", async () => {
    repository = await repositoryWithCommit()
    const runner = new GitRunner(repository.path)
    expect(await loadRefsSnapshot(runner)).toBe(await loadRefsSnapshot(runner))

    const empty = await createTempRepository()
    try {
      const emptyRunner = new GitRunner(empty.path)
      expect(await loadRefsSnapshot(emptyRunner)).toBe(await loadRefsSnapshot(emptyRunner))
    } finally {
      await empty.cleanup()
    }
  })
})

describe("RefsWatcher", () => {
  function watcherOver(snapshots: string[], isBusy?: () => boolean): {
    readonly watcher: RefsWatcher
    refreshes(): number
  } {
    let refreshes = 0
    const watcher = new RefsWatcher({
      snapshot: async () => snapshots[0] ?? "",
      onExternalChange: async () => { refreshes += 1 },
      ...(isBusy === undefined ? {} : { isBusy }),
    })
    return { watcher, refreshes: () => refreshes }
  }

  test("the first poll seeds the baseline and reports nothing", async () => {
    const snapshots = ["a"]
    const { watcher, refreshes } = watcherOver(snapshots)
    expect(await watcher.check()).toBe(false)
    expect(refreshes()).toBe(0)
    expect(watcher.lastSnapshot).toBe("a")
  })

  test("a change refreshes once, and the new state becomes the baseline", async () => {
    const snapshots = ["a"]
    const { watcher, refreshes } = watcherOver(snapshots)
    await watcher.check()
    snapshots[0] = "b"
    expect(await watcher.check()).toBe(true)
    expect(refreshes()).toBe(1)
    expect(await watcher.check()).toBe(false)
    expect(refreshes()).toBe(1)
  })

  test("a change seen while githunk is busy is left alone until it settles", async () => {
    const snapshots = ["a"]
    let busy = true
    const { watcher, refreshes } = watcherOver(snapshots, () => busy)
    await watcher.check()
    snapshots[0] = "b"
    expect(await watcher.check()).toBe(false)
    expect(refreshes()).toBe(0)
    // The baseline was not moved, so nothing is swallowed.
    expect(watcher.lastSnapshot).toBe("a")
    busy = false
    expect(await watcher.check()).toBe(true)
    expect(refreshes()).toBe(1)
  })

  test("resync adopts the current state without refreshing", async () => {
    const snapshots = ["a"]
    const { watcher, refreshes } = watcherOver(snapshots)
    await watcher.check()
    snapshots[0] = "b"
    await watcher.resync()
    expect(watcher.lastSnapshot).toBe("b")
    expect(await watcher.check()).toBe(false)
    expect(refreshes()).toBe(0)
  })

  test("a failed snapshot keeps the baseline and refreshes nothing", async () => {
    let refreshes = 0
    let fail = true
    const watcher = new RefsWatcher({
      snapshot: async () => {
        if (fail) throw new Error("git could not start")
        return "a"
      },
      onExternalChange: async () => { refreshes += 1 },
    })
    expect(await watcher.check()).toBe(false)
    expect(watcher.lastSnapshot).toBeUndefined()
    fail = false
    expect(await watcher.check()).toBe(false)
    expect(watcher.lastSnapshot).toBe("a")
    expect(refreshes).toBe(0)
  })
})
