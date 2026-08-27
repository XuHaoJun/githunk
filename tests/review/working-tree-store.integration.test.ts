import { describe, expect, test } from "bun:test"
import { access, mkdir, readdir, readFile, stat, symlink } from "node:fs/promises"
import { join } from "node:path"
import { WorkingTreeReviewStore, emptyWorkingTreeReviewDatabase } from "../../src/review/working-tree-store"
import { createTempRepository } from "../helpers/temp-repository"

describe("working tree review store", () => {
  test("persists below git metadata with atomic private file at new path", async () => {
    const repository = await createTempRepository()
    try {
      const store = new WorkingTreeReviewStore(repository.path)
      const database = emptyWorkingTreeReviewDatabase()
      database.targets["working-tree|all"] = { files: { "a.ts": { reviewedFingerprint: "fp", reviewedAt: "2026-01-01T00:00:00.000Z" } } }
      await store.save(database)
      const loaded = await store.load()
      expect(loaded).toEqual(database)
      expect(await stat(store.path)).toMatchObject({ mode: 0o100600 })
      // New path is used, old combined file not created
      await expect(access(join(repository.path, "githunk", "working-tree-review-state-v1.json"))).rejects.toThrow()
      expect((await readdir(join(repository.path, ".git", "githunk"))).sort()).toEqual(["working-tree-review-state-v1.json"])
      expect(JSON.parse(await readFile(store.path, "utf8"))).toEqual(database)
    } finally {
      await repository.cleanup()
    }
  })

  test("starts empty and never reads combined review-state-v1", async () => {
    const repository = await createTempRepository()
    try {
      const store = new WorkingTreeReviewStore(repository.path)
      // Write old combined file manually
      const combinedPath = join(repository.path, ".git", "githunk", "review-state-v1.json")
      await mkdir(join(repository.path, ".git", "githunk"), { recursive: true })
      await Bun.write(combinedPath, JSON.stringify({ version: 1, baseByBranch: { main: { ref: "origin/main" } }, targets: { "old-key": { files: { "a.ts": { reviewedFingerprint: "old-fp", reviewedAt: "2026-01-01T00:00:00.000Z" } } } } }))
      const loaded = await store.load()
      expect(loaded).toEqual(emptyWorkingTreeReviewDatabase())
      // Ensure old file not migrated
      expect(loaded.targets["old-key"]).toBeUndefined()
    } finally {
      await repository.cleanup()
    }
  })

  test("recovers malformed JSON and exposes a warning", async () => {
    const repository = await createTempRepository()
    try {
      const store = new WorkingTreeReviewStore(repository.path)
      await store.save(emptyWorkingTreeReviewDatabase())
      await Bun.write(store.path, "{malformed")
      const loaded = await store.load()
      expect(loaded).toEqual(emptyWorkingTreeReviewDatabase())
      expect(store.warning).toContain("corrupt")
      expect((await readdir(join(repository.path, ".git", "githunk"))).some((name) => name.startsWith("working-tree-review-state-v1.json.corrupt-") || name.startsWith("working-tree-review-state-v1.corrupt-"))).toBe(true)
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
      const store = new WorkingTreeReviewStore(repository.path)
      await expect(store.save(emptyWorkingTreeReviewDatabase())).rejects.toThrow("symlinked working-tree-review-state")
      await expect(access(join(outside, "working-tree-review-state-v1.json"))).rejects.toThrow()
    } finally {
      await repository.cleanup()
    }
  })
})
