import { afterEach, describe, expect, test } from "bun:test"
import { GitRunner } from "../../src/git/runner"
import { listReflog } from "../../src/git/reflog"
import { createTempRepository, type TempRepository } from "../helpers/temp-repository"

describe("reflog loader against a real repository", () => {
  let repository: TempRepository | undefined
  afterEach(async () => { await repository?.cleanup() })

  test("loads checkout, commit, and merge entries newest first", async () => {
    repository = await createTempRepository()
    await repository.write("one.txt", "one\n")
    await repository.git(["add", "one.txt"])
    await repository.git(["commit", "-m", "root: colons: and spaces"])
    await repository.git(["checkout", "-q", "-b", "feature"])
    await repository.write("two.txt", "two\n")
    await repository.git(["add", "two.txt"])
    await repository.git(["commit", "-m", "second"])
    await repository.git(["checkout", "-q", "master"])
    await repository.git(["merge", "--no-ff", "feature", "-m", "merge feature"])
    const runner = new GitRunner(repository.path)
    const entries = await listReflog(runner)
    expect(entries.length).toBeGreaterThanOrEqual(5)
    expect(entries[0]?.subject).toContain("merge feature")
    expect(entries[0]?.parentOids).toHaveLength(2)
    expect(entries.map((entry) => entry.index)).toEqual(entries.map((_entry, index) => index))
    expect(entries.map((entry) => entry.selector)).toEqual(entries.map((_entry, index) => `HEAD@{${index}}`))
    expect(new Set(entries.map((entry) => entry.id)).size).toBe(entries.length)
    expect(entries.some((entry) => entry.subject.startsWith("checkout: moving from"))).toBe(true)
    const initial = entries.at(-1)
    expect(initial?.subject).toContain("commit (initial)")
    expect(initial?.parentOids).toEqual([])
    expect(initial?.shortOid).toBe(initial?.oid.slice(0, 8))
    expect(Number.isNaN(new Date(initial?.committedAt ?? "").getTime())).toBe(false)
  })

  test("returns an empty list for a repository with no commits", async () => {
    repository = await createTempRepository()
    const runner = new GitRunner(repository.path)
    expect(await listReflog(runner)).toEqual([])
  })

  test("returns an empty list when ref logging is disabled", async () => {
    repository = await createTempRepository()
    await repository.git(["config", "core.logAllRefUpdates", "false"])
    await repository.write("one.txt", "one\n")
    await repository.git(["add", "one.txt"])
    await repository.git(["commit", "-m", "no reflog"])
    const runner = new GitRunner(repository.path)
    expect(await listReflog(runner)).toEqual([])
  })

  test("caps the number of loaded entries", async () => {
    repository = await createTempRepository()
    for (let index = 0; index < 4; index += 1) {
      await repository.write("one.txt", `${index}\n`)
      await repository.git(["add", "one.txt"])
      await repository.git(["commit", "-m", `commit ${index}`])
    }
    const runner = new GitRunner(repository.path)
    const entries = await listReflog(runner, { limit: 2 })
    expect(entries).toHaveLength(2)
    expect(entries[0]?.subject).toContain("commit 3")
  })
})
