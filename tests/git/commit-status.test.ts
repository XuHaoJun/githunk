import { afterEach, describe, expect, test } from "bun:test"
import { GitRunner } from "../../src/git/runner"
import { listCommits } from "../../src/git/commits"
import { commitStatusFor, loadCommitStatusSets, resolveMainBranches } from "../../src/git/commit-status"
import { createTempRepository, type TempRepository } from "../helpers/temp-repository"

/**
 * lazygit's `setCommitStatuses` table (pkg/commands/git_commands/commit_loader.go:543-558): the
 * merged question is asked first, and a set that could not be built is nil rather than empty.
 */
describe("commit status classification", () => {
  test("reads merged, pushed and unpushed off the two reachability sets", () => {
    const sets = { unpushed: new Set(["a"]), unmerged: new Set(["a", "b"]) }
    expect(commitStatusFor("a", sets)).toBe("unpushed")
    expect(commitStatusFor("b", sets)).toBe("pushed")
    expect(commitStatusFor("c", sets)).toBe("merged")
  })

  test("treats every commit as unmerged when no main branch exists", () => {
    expect(commitStatusFor("a", { unpushed: new Set(["a"]) })).toBe("unpushed")
    expect(commitStatusFor("b", { unpushed: new Set(["a"]) })).toBe("pushed")
  })

  test("never reports unpushed when the unpushed query was skipped", () => {
    // A detached HEAD gives lazygit no ref for the pushed question, so nothing renders red.
    expect(commitStatusFor("a", { unmerged: new Set(["a"]) })).toBe("pushed")
  })
})

describe("commit status queries", () => {
  let repository: TempRepository | undefined
  let remote: TempRepository | undefined
  afterEach(async () => {
    await repository?.cleanup()
    await remote?.cleanup()
    repository = undefined
    remote = undefined
  })

  test("colours a branch's commits merged, pushed and unpushed against master and its upstream", async () => {
    repository = await createTempRepository()
    await repository.write("file.txt", "base\n")
    await repository.git(["add", "file.txt"])
    await repository.git(["commit", "-m", "base"])
    const merged = (await repository.git(["rev-parse", "HEAD"])).stdout.trim()
    remote = await createTempRepository()
    await remote.git(["config", "core.bare", "true"])
    await repository.git(["remote", "add", "origin", remote.path])
    await repository.git(["push", "-q", "origin", "master"])
    await repository.git(["checkout", "-q", "-b", "feature"])
    await repository.write("file.txt", "pushed\n")
    await repository.git(["add", "file.txt"])
    await repository.git(["commit", "-m", "pushed"])
    const pushed = (await repository.git(["rev-parse", "HEAD"])).stdout.trim()
    await repository.git(["push", "-q", "-u", "origin", "feature"])
    await repository.write("file.txt", "local\n")
    await repository.git(["add", "file.txt"])
    await repository.git(["commit", "-m", "local"])
    const unpushed = (await repository.git(["rev-parse", "HEAD"])).stdout.trim()

    const runner = new GitRunner(repository.path)
    const byOid = new Map((await listCommits(runner, "HEAD")).map((commit) => [commit.oid, commit.status]))
    expect(byOid.get(unpushed)).toBe("unpushed")
    expect(byOid.get(pushed)).toBe("pushed")
    expect(byOid.get(merged)).toBe("merged")
  })

  test("skips the unpushed query on a detached HEAD", async () => {
    repository = await createTempRepository()
    await repository.write("file.txt", "base\n")
    await repository.git(["add", "file.txt"])
    await repository.git(["commit", "-m", "base"])
    await repository.git(["checkout", "-q", "--detach"])
    const runner = new GitRunner(repository.path)
    const sets = await loadCommitStatusSets(runner)
    expect(sets.unpushed).toBeUndefined()
  })

  test("resolves master through the local ref when the repository has no remote", async () => {
    repository = await createTempRepository()
    await repository.write("file.txt", "base\n")
    await repository.git(["add", "file.txt"])
    await repository.git(["commit", "-m", "base"])
    const runner = new GitRunner(repository.path)
    expect(await resolveMainBranches(runner)).toEqual(["refs/heads/master"])
  })

  test("caches the resolved main branches for the lifetime of the runner", async () => {
    const calls: string[][] = []
    const runner = {
      run: async (args: readonly string[]) => {
        calls.push([...args])
        return { exitCode: 0, stdout: "refs/remotes/origin/main\n", stderr: "", record: {} as never }
      },
    }
    const first = await resolveMainBranches(runner as never)
    const second = await resolveMainBranches(runner as never)
    expect(second).toBe(first)
    expect(calls).toHaveLength(2)
  })
})
