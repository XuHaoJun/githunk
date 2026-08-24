import { describe, expect, test } from "bun:test"
import { GitRunner } from "../../src/git/runner"
import { applyStash, createStash, dropStash, listStashes, loadStash, popStash } from "../../src/git/stash"
import { createTempRepository } from "../helpers/temp-repository"

describe("stash operations", () => {
  test("creates, lists, inspects, applies, pops, and drops stashes", async () => {
    const repository = await createTempRepository()
    try {
      await repository.write("tracked.txt", "base\n")
      await repository.git(["add", "tracked.txt"])
      await repository.git(["commit", "-m", "base"])
      await repository.write("tracked.txt", "changed\n")
      await repository.write("untracked.txt", "new\n")
      const runner = new GitRunner(repository.path)
      const created = await createStash(runner, "Unicode stash ✨", { includeUntracked: true })
      expect(created).toBeDefined()
      const stashes = await listStashes(runner)
      expect(stashes).toHaveLength(1)
      expect(stashes[0]?.message).toContain("Unicode stash")
      const patch = await loadStash(runner, stashes[0]!.ref)
      expect(patch.patch).toContain("tracked.txt")
      await applyStash(runner, stashes[0]!.ref)
      expect((await listStashes(runner))).toHaveLength(1)
      await repository.git(["reset", "--hard"])
      await repository.git(["clean", "-fd"])
      await popStash(runner, stashes[0]!.ref)
      expect((await listStashes(runner))).toHaveLength(0)
      await repository.write("tracked.txt", "again\n")
      await createStash(runner, "drop me", { includeUntracked: false })
      const dropped = (await listStashes(runner))[0]!
      await dropStash(runner, dropped.ref, { confirmed: true })
      expect(await listStashes(runner)).toHaveLength(0)
    } finally {
      await repository.cleanup()
    }
  })

  test("preserves stash and exposes conflicts from apply/pop", async () => {
    const repository = await createTempRepository()
    try {
      await repository.write("file.txt", "base\n")
      await repository.git(["add", "file.txt"])
      await repository.git(["commit", "-m", "base"])
      await repository.write("file.txt", "stash\n")
      const runner = new GitRunner(repository.path)
      await createStash(runner, "conflict", { includeUntracked: false })
      await repository.write("file.txt", "local\n")
      await expect(applyStash(runner, "stash@{0}")).rejects.toThrow()
      expect(await listStashes(runner)).toHaveLength(1)
    } finally {
      await repository.cleanup()
    }
  })
})
