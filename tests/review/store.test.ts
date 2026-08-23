import { describe, expect, test } from "bun:test"
import { access, mkdir, readdir, readFile, stat, symlink } from "node:fs/promises"
import { join } from "node:path"
import { ReviewStore, emptyReviewDatabase } from "../../src/review/store"
import { createTempRepository } from "../helpers/temp-repository"

describe("review store", () => {
  test("persists below git metadata with atomic private file", async () => {
    const repository = await createTempRepository()
    try {
      const store = new ReviewStore(repository.path)
      const database = emptyReviewDatabase()
      database.targets["working-tree|all"] = { files: { "a.ts": { reviewedFingerprint: "fp", reviewedAt: "2026-01-01T00:00:00.000Z" } } }
      await store.save(database)
      const loaded = await store.load()
      expect(loaded).toEqual(database)
      expect(await stat(store.path)).toMatchObject({ mode: 0o100600 })
      await expect(access(join(repository.path, "githunk", "review-state-v1.json"))).rejects.toThrow()
      expect((await readdir(join(repository.path, ".git", "githunk"))).sort()).toEqual(["review-state-v1.json"])
      expect(JSON.parse(await readFile(store.path, "utf8"))).toEqual(database)
    } finally {
      await repository.cleanup()
    }
  })

  test("recovers malformed JSON and exposes a warning", async () => {
    const repository = await createTempRepository()
    try {
      const store = new ReviewStore(repository.path)
      await store.save(emptyReviewDatabase())
      await Bun.write(store.path, "{malformed")
      const loaded = await store.load()
      expect(loaded).toEqual(emptyReviewDatabase())
      expect(store.warning).toContain("corrupt")
      expect((await readdir(join(repository.path, ".git", "githunk"))).some((name) => name.startsWith("review-state-v1.json.corrupt-") || name.startsWith("review-state-v1.corrupt-"))).toBe(true)
    } finally {
      await repository.cleanup()
    }
  })
  test("rejects symlinked metadata directories before writing", async () => {
    const repository = await createTempRepository()
    try {
      const outside = join(repository.path, "outside-state")
      await mkdir(outside)
      await symlink(outside, join(repository.path, ".git", "githunk"), "dir")
      const store = new ReviewStore(repository.path)
      await expect(store.save(emptyReviewDatabase())).rejects.toThrow("symlinked review-state path component")
      await expect(access(join(outside, "review-state-v1.json"))).rejects.toThrow()
    } finally {
      await repository.cleanup()
    }
  })
})
