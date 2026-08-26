import { afterEach, describe, expect, test } from "bun:test"
import { createTempRepository, type TempRepository } from "../helpers/temp-repository"
import { GitRunner } from "../../src/git/runner"
import { listCommits, loadCommit, loadCommitFilePatch, parseCommitLog } from "../../src/git/commits"

describe("commit history loaders", () => {
  test("does not treat control separators in free-form fields as delimiters", () => {
    const parsed = parseCommitLog("oid\nshort\nparent\nA\u001futhor\n2026-01-01T00:00:00Z\nsubject\u001ftext\nbody\u001fline\0")
    expect(parsed[0]?.authorName).toBe("A\u001futhor")
    expect(parsed[0]?.subject).toBe("subject\u001ftext")
    expect(parsed[0]?.body).toBe("body\u001fline")
  })
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
    expect(details.parentOids).toHaveLength(1)
    expect(details.subject).toBe("change")
    expect(details.document.files).toHaveLength(1)
    expect(details.preamble).toContain("Author:")
    expect(details.preamble).toContain("1 file changed")
    expect(details.preamble).not.toContain("diff --git")
    expect(details.document.text).toContain("diff --git")
    // loadCommitFilePatch is readOnly, so it is no longer logged (readOnly implies dontLog) — spy on
    // the argv directly instead of reading it back out of the command log, to keep checking that the
    // filename is scoped safely behind `--` rather than treated as a revision or option.
    const seenArgs: string[][] = []
    const spyRunner: Pick<GitRunner, "run"> = {
      run: (args, options) => {
        seenArgs.push([...args])
        return runner.run(args, options)
      },
    }
    const file = await loadCommitFilePatch(spyRunner, oid, "space name.txt")
    expect(file.files).toHaveLength(1)
    expect(file.text).toContain("+after")
    expect(seenArgs.at(-1)?.slice(-2)).toEqual(["--", "space name.txt"])
  })

  test("loads a large 5000-line patch without file-list fallback", async () => {
    repository = await createTempRepository()
    const lines = Array.from({ length: 5000 }, (_, i) => `line ${i + 1}`)
    await repository.write("large.txt", lines.join("\n") + "\n")
    await repository.git(["add", "large.txt"])
    await repository.git(["commit", "-m", "large"])
    const oid = (await repository.git(["rev-parse", "HEAD"])).stdout.trim()
    const runner = new GitRunner(repository.path)
    const details = await loadCommit(runner, oid)
    expect(details.preamble).toContain("5000 insertions")
    expect(details.document.text).toContain("+line 1")
    expect(details.document.text).toContain("+line 5000")
    expect(details.document.files).toHaveLength(1)
  })
})

describe("commit log ordering", () => {
  test("requests topo-order so the graph renders as contiguous lanes", async () => {
    const calls: string[][] = []
    const runner = {
      run: async (args: readonly string[]) => {
        calls.push([...args])
        return { exitCode: 0, stdout: "", stderr: "", record: {} as never }
      },
    }
    await listCommits(runner as never, "HEAD")
    // Matches lazygit's default `git.log.order: topo-order`.
    expect(calls[0]).toContain("--topo-order")
  })
})
