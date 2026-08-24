import { afterEach, describe, expect, test } from "bun:test"
import { createTempRepository, type TempRepository } from "../helpers/temp-repository"
import { GitRunner } from "../../src/git/runner"
import { listCommits, loadCommit, loadCommitFilePatch } from "../../src/git/commits"

describe("commit history loaders", () => {
  let repository: TempRepository | undefined
  afterEach(async () => { await repository?.cleanup() })

  test("parses Unicode, multiline, signatures, root, and merge commits", async () => {
    repository = await createTempRepository()
    await repository.write("one.txt", "one\n")
    await repository.git(["add", "one.txt"])
    await repository.git(["commit", "-m", "初回コミット\n\nbody line one\nbody line two\nSigned-off-by: Githunk <githunk@example.invalid>"])
    const root = (await repository.git(["rev-parse", "HEAD"])).stdout.trim()
    await repository.write("two.txt", "two\n")
    await repository.git(["add", "two.txt"])
    await repository.git(["commit", "-m", "feature subject"])
    const feature = (await repository.git(["rev-parse", "HEAD"])).stdout.trim()
    await repository.git(["checkout", "-q", "-b", "side", root])
    await repository.write("side.txt", "side\n")
    await repository.git(["add", "side.txt"])
    await repository.git(["commit", "-m", "side subject"])
    const side = (await repository.git(["rev-parse", "HEAD"])).stdout.trim()
    await repository.git(["checkout", "-q", "master"])
    await repository.git(["merge", "--no-ff", "side", "-m", "merge subject"])
    const runner = new GitRunner(repository.path)
    const commits = await listCommits(runner, `${root}..HEAD`)
    expect(commits.length).toBe(3)
    expect(commits[0]?.subject).toBe("merge subject")
    expect(commits[0]?.parentOids.length).toBe(2)
    expect(commits.some((commit) => commit.oid === side)).toBe(true)
    const rootCommit = (await listCommits(runner, root))[0]
    expect(rootCommit?.subject).toBe("初回コミット")
    expect(rootCommit?.body).toContain("body line one\nbody line two")
    expect(rootCommit?.body).toContain("Signed-off-by")
    expect(feature).toHaveLength(40)
  })

  test("loads commit details and safely scopes a file patch after --", async () => {
    repository = await createTempRepository()
    await repository.write("space name.txt", "before\n")
    await repository.git(["add", "."])
    await repository.git(["commit", "-m", "base"])
    await repository.write("space name.txt", "after\n")
    await repository.git(["add", "."])
    await repository.git(["commit", "-m", "change"])
    const oid = (await repository.git(["rev-parse", "HEAD"])).stdout.trim()
    const runner = new GitRunner(repository.path)
    const details = await loadCommit(runner, oid)
    expect(details.oid).toBe(oid)
    expect(details.subject).toBe("change")
    expect(details.document.files).toHaveLength(1)
    const file = await loadCommitFilePatch(runner, oid, "space name.txt")
    expect(file.files).toHaveLength(1)
    expect(file.text).toContain("+after")
    const command = runner.log.records().at(-1)
    expect(command?.args.slice(-2)).toEqual(["--", "space name.txt"])
  })
})
