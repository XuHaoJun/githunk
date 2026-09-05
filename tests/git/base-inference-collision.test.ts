import { describe, expect, test } from "bun:test"
import { createTempRepository } from "../helpers/temp-repository"
import { GitRunner } from "../../src/git/runner"
import { inferReviewBase, resolveRefOid } from "../../src/git/base-inference"

describe("base ref identity", () => {
  test("keeps colliding local and remote labels independently selectable with canonical refs", async () => {
    const repository = await createTempRepository()
    try {
      const runner = new GitRunner(repository.path)
      await repository.write("base.txt", "base\n")
      await runner.run(["add", "base.txt"])
      await runner.run(["commit", "--quiet", "-m", "base"])
      const baseOid = (await runner.run(["rev-parse", "HEAD"])).stdout.trim()
      await runner.run(["remote", "add", "origin", "https://example.invalid/origin.git"])
      await runner.run(["update-ref", "refs/remotes/origin/main", baseOid])
      await runner.run(["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"])
      await runner.run(["checkout", "--quiet", "-b", "origin/main"])
      await repository.write("base.txt", "local branch\n")
      await runner.run(["commit", "--quiet", "-am", "local branch"])
      const localOid = (await runner.run(["rev-parse", "HEAD"])).stdout.trim()
      await runner.run(["checkout", "--quiet", "-b", "feature"])
      await repository.write("base.txt", "feature\n")
      await runner.run(["commit", "--quiet", "-am", "feature"])

      const result = await inferReviewBase(runner)
      expect(result.kind).toBe("choose")
      expect(result.candidates.filter(({ label }) => label === "origin/main").map(({ ref }) => ref)).toEqual([
        "refs/heads/origin/main", "refs/remotes/origin/main",
      ])
      expect(await resolveRefOid(runner, "refs/heads/origin/main")).toBe(localOid)
      expect(await resolveRefOid(runner, "refs/remotes/origin/main")).toBe(baseOid)
      const preferred = await inferReviewBase(runner, "refs/remotes/origin/main")
      expect(preferred.candidates[0]?.ref).toBe("refs/remotes/origin/main")
      expect(preferred.candidates[1]?.ref).toBe("refs/heads/origin/main")
    } finally {
      await repository.cleanup()
    }
  })
})
