import { describe, expect, test } from "bun:test"
import { createTempRepository, type TempRepository } from "../helpers/temp-repository"
import { GitRunner } from "../../src/git/runner"
import { inferReviewBase } from "../../src/git/base-inference"

async function commit(repository: TempRepository, path: string, content: string, message: string): Promise<string> {
  await repository.write(path, content)
  const added = await repository.git(["add", path])
  if (added.exitCode !== 0) throw new Error(added.stderr)
  const created = await repository.git(["commit", "--quiet", "-m", message])
  if (created.exitCode !== 0) throw new Error(created.stderr)
  const oid = await repository.git(["rev-parse", "HEAD"])
  return oid.stdout.trim()
}

async function configureRemoteHead(repository: TempRepository, remote: string, branch: string, oid: string): Promise<void> {
  const updated = await repository.git(["update-ref", `refs/remotes/${remote}/${branch}`, oid])
  if (updated.exitCode !== 0) throw new Error(updated.stderr)
  const symbolic = await repository.git(["symbolic-ref", `refs/remotes/${remote}/HEAD`, `refs/remotes/${remote}/${branch}`])
  if (symbolic.exitCode !== 0) throw new Error(symbolic.stderr)
}

describe("inferReviewBase", () => {
  test("prefers the current branch upstream remote symbolic default", async () => {
    const repository = await createTempRepository()
    try {
      const baseOid = await commit(repository, "base.txt", "base\n", "base")
      const configured = await repository.git(["remote", "add", "origin", "https://example.invalid/origin.git"])
      if (configured.exitCode !== 0) throw new Error(configured.stderr)
      await configureRemoteHead(repository, "origin", "main", baseOid)
      const tracked = await repository.git(["config", "branch.master.remote", "origin"])
      if (tracked.exitCode !== 0) throw new Error(tracked.stderr)
      const merged = await repository.git(["config", "branch.master.merge", "refs/heads/main"])
      if (merged.exitCode !== 0) throw new Error(merged.stderr)

      const result = await inferReviewBase(new GitRunner(repository.path))
      expect(result).toEqual({ kind: "confident", ref: "origin/main", oid: baseOid, reason: expect.any(String) })
    } finally {
      await repository.cleanup()
    }
  })

  test("uses origin HEAD when it is valid and no upstream is configured", async () => {
    const repository = await createTempRepository()
    try {
      const baseOid = await commit(repository, "base.txt", "base\n", "base")
      const configured = await repository.git(["remote", "add", "origin", "https://example.invalid/origin.git"])
      if (configured.exitCode !== 0) throw new Error(configured.stderr)
      await configureRemoteHead(repository, "origin", "main", baseOid)
      const result = await inferReviewBase(new GitRunner(repository.path))
      expect(result.kind).toBe("confident")
      if (result.kind === "confident") {
        expect(result.ref).toBe("origin/main")
        expect(result.oid).toBe(baseOid)
      }
    } finally {
      await repository.cleanup()
    }
  })

  test("returns a picker instead of guessing without an authoritative default", async () => {
    const repository = await createTempRepository()
    try {
      await commit(repository, "base.txt", "base\n", "base")
      await repository.git(["branch", "feature"])
      const result = await inferReviewBase(new GitRunner(repository.path))
      expect(result.kind).toBe("choose")
      if (result.kind === "choose") {
        expect(result.candidates).toContain("master")
        expect(result.candidates).toContain("feature")
      }
    } finally {
      await repository.cleanup()
    }
  })

  test("returns a picker for detached HEAD even when origin HEAD exists", async () => {
    const repository = await createTempRepository()
    try {
      const baseOid = await commit(repository, "base.txt", "base\n", "base")
      const configured = await repository.git(["remote", "add", "origin", "https://example.invalid/origin.git"])
      if (configured.exitCode !== 0) throw new Error(configured.stderr)
      await configureRemoteHead(repository, "origin", "main", baseOid)
      const detached = await repository.git(["checkout", "--detach", "--quiet", baseOid])
      if (detached.exitCode !== 0) throw new Error(detached.stderr)
      const result = await inferReviewBase(new GitRunner(repository.path))
      expect(result.kind).toBe("choose")
    } finally {
      await repository.cleanup()
    }
  })

  test("does not guess when origin HEAD is stale or multiple remote defaults compete", async () => {
    const repository = await createTempRepository()
    try {
      const baseOid = await commit(repository, "base.txt", "base\n", "base")
      for (const remote of ["origin", "backup"]) {
        const configured = await repository.git(["remote", "add", remote, `https://example.invalid/${remote}.git`])
        if (configured.exitCode !== 0) throw new Error(configured.stderr)
      }
      const stale = await repository.git(["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/missing"])
      if (stale.exitCode !== 0) throw new Error(stale.stderr)
      await configureRemoteHead(repository, "backup", "main", baseOid)
      const result = await inferReviewBase(new GitRunner(repository.path))
      expect(result.kind).toBe("choose")
    } finally {
      await repository.cleanup()
    }
  })

  test("returns a picker for an unborn branch", async () => {
    const repository = await createTempRepository()
    try {
      const result = await inferReviewBase(new GitRunner(repository.path))
      expect(result.kind).toBe("choose")
    } finally {
      await repository.cleanup()
    }
  })
})
