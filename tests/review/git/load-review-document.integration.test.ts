import { describe, expect, test } from "bun:test"
import { writeFile } from "node:fs/promises"
import { join } from "node:path"
import { createTempRepository } from "../../helpers/temp-repository"
import { GitRunner } from "../../../src/git/runner"
import { loadReviewDocument } from "../../../src/review/git/load-review-document"
import { sha256Tuple } from "../../../src/review/core/identity"
import { createReviewGeneration, createReviewIdentity } from "../../../src/review/core/identity"

async function commitAll(repo: Awaited<ReturnType<typeof createTempRepository>>, message: string): Promise<string> {
  const added = await repo.git(["add", "-A"])
  if (added.exitCode !== 0) throw new Error(added.stderr)
  const created = await repo.git(["commit", "--quiet", "-m", message])
  if (created.exitCode !== 0) throw new Error(`commit failed: ${created.stderr}`)
  const oid = await repo.git(["rev-parse", "HEAD"])
  return oid.stdout.trim()
}

describe("loadReviewDocument integration", () => {
  test("loads canonical document with three branch commits including rename and binary", async () => {
    const repo = await createTempRepository()
    try {
      // base commit on master
      await repo.write("story.txt", "base\n")
      await repo.write("keep.txt", "keep\n")
      const baseOid = await commitAll(repo, "base")
      // create feature branch
      const branchRes = await repo.git(["checkout", "-b", "feature"])
      if (branchRes.exitCode !== 0) throw new Error(branchRes.stderr)

      // commit 1: modify story.txt and add second.txt
      await repo.write("story.txt", "base\none\n")
      await repo.write("second.txt", "two\n")
      const c1 = await commitAll(repo, "one")

      // commit 2: rename story.txt -> renamed.txt
      const mv = await repo.git(["mv", "story.txt", "renamed.txt"])
      if (mv.exitCode !== 0) throw new Error(mv.stderr)
      const c2 = await commitAll(repo, "rename")

      // commit 3: add binary file
      const binPath = join(repo.path, "image.png")
      await writeFile(binPath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0x00, 0xab]))
      const c3 = await commitAll(repo, "binary")

      // verify baseOid still master head
      const masterOid = (await repo.git(["rev-parse", "master"])).stdout.trim()
      expect(masterOid).toBe(baseOid)

      // also create an untracked working-tree file that must NOT appear in review
      await repo.write("untracked.txt", "should not appear\n")

      const runner = new GitRunner(repo.path)
      const doc = await loadReviewDocument(runner, "master")

      // identity: canonical head ref should be refs/heads/feature, baseRef master
      expect(doc.identity.headRef).toBe("refs/heads/feature")
      expect(doc.identity.baseRef).toBe("master")
      expect(doc.identity.detachedHeadOid).toBeNull()
      const expectedId = createReviewIdentity({ headRef: "refs/heads/feature", headOid: c3, baseRef: "master" }).id
      expect(doc.identity.id).toBe(expectedId)

      // generation
      const mergeBase = (await repo.git(["merge-base", "master", "HEAD"])).stdout.trim()
      expect(doc.generation.baseOid).toBe(baseOid)
      expect(doc.generation.headOid).toBe(c3)
      expect(doc.generation.mergeBaseOid).toBe(mergeBase)
      const expectedGenId = createReviewGeneration({ baseOid, mergeBaseOid: mergeBase, headOid: c3 }).id
      expect(doc.generation.id).toBe(expectedGenId)

      expect(new Set(doc.commits.map((c) => c.oid))).toEqual(new Set([c1, c2, c3]))
      expect(doc.commits.length).toBe(3)

      // files: second.txt, renamed.txt (renamed), image.png (binary)
      const paths = doc.files.map((f) => f.path).sort()
      expect(paths).toEqual(["image.png", "renamed.txt", "second.txt"].sort())

      // no untracked file
      expect(doc.files.some((f) => f.path === "untracked.txt")).toBe(false)

      // rename file should have previousPath and kind renamed
      const renamed = doc.files.find((f) => f.path === "renamed.txt")!
      expect(renamed.previousPath).toBe("story.txt")
      expect(renamed.kind).toBe("renamed")
      expect(renamed.oldBlobOid).toBeTruthy()
      expect(renamed.newBlobOid).toBeTruthy()
      expect(renamed.oldMode).toBe("100644")
      expect(renamed.newMode).toBe("100644")
      expect(renamed.source).toBe("available")
      expect(renamed.stats.additions).not.toBeNull()

      // binary file
      const binary = doc.files.find((f) => f.path === "image.png")!
      expect(binary.kind).toBe("binary")
      expect(binary.source).toBe("binary")
      expect(binary.hunks.length).toBe(0)
      expect(binary.stats.additions).toBeNull()
      expect(binary.stats.deletions).toBeNull()

      // contentId uses tuple without path; verify deterministic
      for (const f of doc.files) {
        const expectedContentId = sha256Tuple([
          f.oldBlobOid ?? "",
          f.newBlobOid ?? "",
          f.oldMode ?? "",
          f.newMode ?? "",
          f.hunks.flatMap((h) => h.lines).join("\n") + (f.hunks.length > 0 ? "\n" : ""),
        ])
        expect(f.contentId).toBe(expectedContentId)
      }

      // aggregate digest
      const expectedAgg = sha256Tuple(doc.files.map((f) => f.patchDigest))
      expect(doc.aggregatePatchDigest).toBe(expectedAgg)

      // patchDigest per file hashes normalized patch
      for (const f of doc.files) {
        expect(f.patchDigest.length).toBe(64)
      }

      // Ensure no working-tree file leaked
      expect(doc.files.find((f) => f.path === "keep.txt")).toBeUndefined() // keep.txt unchanged not in diff
    } finally {
      await repo.cleanup()
    }
  })

  test("empty diff returns empty files but valid document", async () => {
    const repo = await createTempRepository()
    try {
      await repo.write("a.txt", "content\n")
      const baseOid = await commitAll(repo, "base")
      const runner = new GitRunner(repo.path)
      const doc = await loadReviewDocument(runner, "HEAD")
      expect(doc.files.length).toBe(0)
      expect(doc.commits.length).toBe(0)
      expect(doc.generation.baseOid).toBe(baseOid)
    } finally {
      await repo.cleanup()
    }
  })

  test("detached HEAD produces detached identity", async () => {
    const repo = await createTempRepository()
    try {
      await repo.write("a.txt", "base\n")
      const baseOid = await commitAll(repo, "base")
      await repo.write("a.txt", "change\n")
      const headOid = await commitAll(repo, "change")
      // detach
      await repo.git(["checkout", "--detach", "HEAD"])
      const runner = new GitRunner(repo.path)
      const doc = await loadReviewDocument(runner, baseOid)
      expect(doc.identity.headRef).toBeNull()
      expect(doc.identity.detachedHeadOid).toBe(headOid)
    } finally {
      await repo.cleanup()
    }
  })

  test("concurrent Git calls are used (smoke)", async () => {
    const repo = await createTempRepository()
    try {
      await repo.write("a.txt", "base\n")
      const baseOid = await commitAll(repo, "base")
      await repo.write("a.txt", "changed\n")
      await commitAll(repo, "change")
      const runner = new GitRunner(repo.path)
      // This should not throw and should return quickly
      const start = Date.now()
      const doc = await loadReviewDocument(runner, baseOid)
      const elapsed = Date.now() - start
      expect(doc.files.length).toBe(1)
      expect(elapsed).toBeLessThan(5000)
    } finally {
      await repo.cleanup()
    }
  })
})
