import { describe, expect, test } from "bun:test"
import { createTempRepository, type TempRepository } from "../helpers/temp-repository"
import { GitRunner } from "../../src/git/runner"
import { loadBranchReview } from "../../src/git/branch-review"

async function commit(repository: TempRepository, path: string, content: string, message: string): Promise<string> {
  await repository.write(path, content)
  const added = await repository.git(["add", path])
  if (added.exitCode !== 0) throw new Error(added.stderr)
  const created = await repository.git(["commit", "--quiet", "-m", message])
  if (created.exitCode !== 0) throw new Error(created.stderr)
  const oid = await repository.git(["rev-parse", "HEAD"])
  return oid.stdout.trim()
}

describe("loadBranchReview", () => {
  test("loads aggregate changes from every commit after the selected base", async () => {
    const repository = await createTempRepository()
    try {
      const baseOid = await commit(repository, "story.txt", "base\n", "base")
      await commit(repository, "story.txt", "base\none\n", "one")
      await commit(repository, "second.txt", "two\n", "two")
      const headOid = await commit(repository, "story.txt", "base\none\nthree\n", "three")

      const snapshot = await loadBranchReview(new GitRunner(repository.path), baseOid)
      expect(snapshot.reviewTarget).toEqual({ kind: "branch", baseRef: baseOid, baseOid, headOid })
      expect(snapshot.mergeBaseOid).toBe(baseOid)
      expect(snapshot.commitCount).toBe(3)
      expect(snapshot.files.map((file) => file.path)).toEqual(["second.txt", "story.txt"])
      expect(snapshot.files.find((file) => file.path === "story.txt")?.additions).toBe(2)
      expect(snapshot.patches[0]?.text).toContain("+one")
      expect(snapshot.patches[0]?.text).toContain("+three")
    } finally {
      await repository.cleanup()
    }
  })
})
