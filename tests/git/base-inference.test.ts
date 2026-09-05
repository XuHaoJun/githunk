import { describe, expect, test } from "bun:test"
import { createTempRepository, type TempRepository } from "../helpers/temp-repository"
import { GitCommandError, GitRunner } from "../../src/git/runner"
import { inferReviewBase } from "../../src/git/base-inference"

async function git(repository: TempRepository, args: readonly string[]): Promise<string> {
  const result = await repository.git(args)
  if (result.exitCode !== 0) throw new Error(result.stderr)
  return result.stdout.trim()
}

async function commit(repository: TempRepository, message: string): Promise<string> {
  await repository.write("file.txt", `${message}\n`)
  await git(repository, ["add", "file.txt"])
  await git(repository, ["commit", "--quiet", "-m", message])
  return git(repository, ["rev-parse", "HEAD"])
}

async function configureRemoteHead(repository: TempRepository, remote: string, branch: string, oid: string): Promise<void> {
  await git(repository, ["remote", "add", remote, `https://example.invalid/${remote}.git`])
  await git(repository, ["update-ref", `refs/remotes/${remote}/${branch}`, oid])
  await git(repository, ["symbolic-ref", `refs/remotes/${remote}/HEAD`, `refs/remotes/${remote}/${branch}`])
}

describe("inferReviewBase", () => {
  test("offers remote defaults in upstream, origin, then deterministic other-remote order without choosing", async () => {
    const repository = await createTempRepository()
    try {
      const base = await commit(repository, "base")
      for (const remote of ["zeta", "upstream", "origin", "backup"]) {
        await configureRemoteHead(repository, remote, "main", base)
      }
      await git(repository, ["checkout", "--quiet", "-b", "feature"])
      await commit(repository, "feature")
      await git(repository, ["config", "branch.feature.remote", "upstream"])
      await git(repository, ["config", "branch.feature.merge", "refs/heads/feature"])
      const result = await inferReviewBase(new GitRunner(repository.path))
      expect(result.kind).toBe("choose")
      expect(result.candidates.map(({ ref }) => ref)).toEqual([
        "refs/remotes/upstream/main", "refs/remotes/origin/main",
        "refs/remotes/backup/main", "refs/remotes/zeta/main", "refs/heads/master",
      ])
    } finally {
      await repository.cleanup()
    }
  })

  test("ranks the nearest stacked first-parent tip before remote defaults and preserves an explicit preference", async () => {
    const repository = await createTempRepository()
    try {
      const base = await commit(repository, "base")
      await configureRemoteHead(repository, "origin", "main", base)
      await git(repository, ["checkout", "--quiet", "-b", "stack-parent"])
      await commit(repository, "parent")
      await git(repository, ["checkout", "--quiet", "-b", "feature"])
      await commit(repository, "feature")
      const runner = new GitRunner(repository.path)
      const result = await inferReviewBase(runner)
      expect(result.candidates[0]?.ref).toBe("refs/heads/stack-parent")
      const preferred = await inferReviewBase(runner, "refs/remotes/origin/main")
      expect(preferred.candidates.map(({ ref }) => ref)).toEqual([
        "refs/remotes/origin/main", "refs/heads/stack-parent", "refs/heads/master",
      ])
      const stale = await inferReviewBase(runner, "refs/heads/deleted")
      expect(stale.candidates.map(({ ref }) => ref)).toEqual(result.candidates.map(({ ref }) => ref))
    } finally {
      await repository.cleanup()
    }
  })

  test("excludes the checked-out branch and demotes its remote tracking branch even when it is behind", async () => {
    const repository = await createTempRepository()
    try {
      await commit(repository, "base")
      await git(repository, ["checkout", "--quiet", "-b", "feature"])
      const prior = await commit(repository, "feature one")
      await configureRemoteHead(repository, "origin", "feature", prior)
      await commit(repository, "feature two")
      await git(repository, ["branch", "same-head"])
      const before = await git(repository, ["show-ref"])
      const result = await inferReviewBase(new GitRunner(repository.path))
      expect(result.candidates.map(({ ref }) => ref)).toEqual([
        "refs/heads/master", "refs/heads/same-head", "refs/remotes/origin/feature",
      ])
      expect(await git(repository, ["symbolic-ref", "HEAD"])).toBe("refs/heads/feature")
      expect(await git(repository, ["show-ref"])).toBe(before)
      expect(await git(repository, ["status", "--porcelain"])).toBe("")
    } finally {
      await repository.cleanup()
    }
  })

  test("keeps diverged branches available behind conventional fallback names", async () => {
    const repository = await createTempRepository()
    try {
      await commit(repository, "base")
      await git(repository, ["checkout", "--quiet", "-b", "feature"])
      await commit(repository, "feature")
      await git(repository, ["checkout", "--quiet", "master"])
      await commit(repository, "diverged")
      for (const branch of ["zebra", "develop", "main", "alpha"]) await git(repository, ["branch", branch])
      await git(repository, ["checkout", "--quiet", "feature"])
      const result = await inferReviewBase(new GitRunner(repository.path))
      expect(result.candidates.map(({ label }) => label)).toEqual(["main", "master", "develop", "alpha", "zebra"])
    } finally {
      await repository.cleanup()
    }
  })

  test("returns ranked candidates for detached HEAD without excluding another branch at HEAD", async () => {
    const repository = await createTempRepository()
    try {
      const base = await commit(repository, "base")
      await configureRemoteHead(repository, "origin", "main", base)
      await commit(repository, "next")
      await git(repository, ["checkout", "--detach", "--quiet"])
      const result = await inferReviewBase(new GitRunner(repository.path))
      expect(result.kind).toBe("choose")
      expect(result.candidates.map(({ ref }) => ref)).toEqual(["refs/remotes/origin/main", "refs/heads/master"])
    } finally {
      await repository.cleanup()
    }
  })

  test("ignores a stale symbolic remote default rather than inventing a branch", async () => {
    const repository = await createTempRepository()
    try {
      const base = await commit(repository, "base")
      await configureRemoteHead(repository, "backup", "main", base)
      await git(repository, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/missing"])
      const result = await inferReviewBase(new GitRunner(repository.path))
      expect(result.kind).toBe("choose")
      expect(result.candidates.map(({ ref }) => ref)).toEqual(["refs/remotes/backup/main"])
    } finally {
      await repository.cleanup()
    }
  })

  test("returns an empty picker for an unborn branch", async () => {
    const repository = await createTempRepository()
    try {
      const result = await inferReviewBase(new GitRunner(repository.path))
      expect(result.kind).toBe("choose")
      expect(result.candidates).toEqual([])
    } finally {
      await repository.cleanup()
    }
  })

  test("propagates real Git errors instead of fabricating fallback candidates", async () => {
    const repository = await createTempRepository()
    try {
      await repository.write("nested/file", "not a repository\n")
      await expect(inferReviewBase(new GitRunner(`${repository.path}/nested/file`))).rejects.toBeInstanceOf(GitCommandError)
    } finally {
      await repository.cleanup()
    }
  })
})
