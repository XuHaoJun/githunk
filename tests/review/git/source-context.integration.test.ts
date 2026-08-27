import { describe, expect, test } from "bun:test"
import { writeFile } from "node:fs/promises"
import { join } from "node:path"
import { createTempRepository, type TempRepository } from "../../helpers/temp-repository"
import { GitRunner } from "../../../src/git/runner"
import { loadReviewDocument } from "../../../src/review/git/load-review-document"
import { loadSourceContext } from "../../../src/review/git/load-source-context"
import { createReviewDocument } from "../../../src/review/core/document"
import { createReviewGeneration, createReviewIdentity } from "../../../src/review/core/identity"
import type { ReviewFile } from "../../../src/review/core/types"

async function commitAll(repo: TempRepository, message: string): Promise<string> {
  const added = await repo.git(["add", "-A"])
  if (added.exitCode !== 0) throw new Error(added.stderr)
  const created = await repo.git(["commit", "--quiet", "-m", message])
  if (created.exitCode !== 0) throw new Error(`commit failed: ${created.stderr}`)
  const oid = await repo.git(["rev-parse", "HEAD"])
  return oid.stdout.trim()
}

function makeFileWithLines(path: string, lines: readonly string[]): string {
  return lines.join("\n") + "\n"
}

describe("source-context integration", () => {
  test("before gap expansion returns correct lines and echoes generation", async () => {
    const repo = await createTempRepository()
    try {
      // Create base with 10 lines
      const baseLines = ["a1", "a2", "a3", "a4", "a5", "a6", "a7", "a8", "a9", "a10"]
      await repo.write("file.txt", makeFileWithLines("file.txt", baseLines))
      await commitAll(repo, "base")
      await repo.git(["checkout", "-b", "feature"])
      // Modify middle lines 5-6, leaving gaps before (1-4) and after (7-10)
      const modified = [...baseLines]
      modified[4] = "A5 modified"
      modified[5] = "A6 modified"
      await repo.write("file.txt", makeFileWithLines("file.txt", modified))
      await commitAll(repo, "modify middle")

      const runner = new GitRunner(repo.path)
      const doc = await loadReviewDocument(runner, "master")
      const file = doc.files.find((f) => f.path === "file.txt")
      expect(file).toBeDefined()
      if (!file) throw new Error("file not found")
      expect(file.source).toBe("available")

      // Request before gap: lines 1-4 on new side (gap before first hunk)
      const req = {
        reviewId: doc.identity.id,
        generationId: doc.generation.id,
        fileKey: file.key,
        side: "new" as const,
        startLine: 1,
        endLine: 4,
      }
      const outcome = await loadSourceContext(runner, doc, req)
      expect(outcome.ok).toBe(true)
      if (!outcome.ok) throw new Error(`expected ok but got error ${JSON.stringify(outcome.error)}`)
      expect(outcome.result.reviewId).toBe(doc.identity.id)
      expect(outcome.result.generationId).toBe(doc.generation.id)
      expect(outcome.result.fileKey).toBe(file.key)
      expect(outcome.result.side).toBe("new")
      expect(outcome.result.startLine).toBe(1)
      expect(outcome.result.lines).toEqual(["a1", "a2", "a3", "a4"])
    } finally {
      await repo.cleanup()
    }
  })

  test("trailing gap expansion", async () => {
    const repo = await createTempRepository()
    try {
      const baseLines = ["b1", "b2", "b3", "b4", "b5", "b6", "b7", "b8", "b9", "b10"]
      await repo.write("file.txt", makeFileWithLines("file.txt", baseLines))
      await commitAll(repo, "base")
      await repo.git(["checkout", "-b", "feature"])
      const modified = ["b1", "b2", "MOD", "b4", "b5", "b6", "b7", "b8", "b9", "b10"]
      await repo.write("file.txt", makeFileWithLines("file.txt", modified))
      await commitAll(repo, "modify")

      const runner = new GitRunner(repo.path)
      const doc = await loadReviewDocument(runner, "master")
      const file = doc.files.find((f) => f.path === "file.txt")!
      // trailing gap after hunk: lines after modified region, e.g., 4-10
      const req = {
        reviewId: doc.identity.id,
        generationId: doc.generation.id,
        fileKey: file.key,
        side: "new" as const,
        startLine: 4,
        endLine: 10,
      }
      const outcome = await loadSourceContext(runner, doc, req)
      expect(outcome.ok).toBe(true)
      if (!outcome.ok) throw new Error(JSON.stringify(outcome.error))
      // Should contain lines 4,5,6,7,8,9,10 from new side
      expect(outcome.result.lines).toEqual(["b4", "b5", "b6", "b7", "b8", "b9", "b10"])
    } finally {
      await repo.cleanup()
    }
  })

  test("deleted file old side available, new side unavailable; added file opposite", async () => {
    const repo = await createTempRepository()
    try {
      await repo.write("keep.txt", "keep\n")
      await repo.write("toDelete.txt", "delete me\nline2\nline3\n")
      await commitAll(repo, "base")
      await repo.git(["checkout", "-b", "feature"])
      // delete file
      await repo.git(["rm", "toDelete.txt"])
      // add new file
      await repo.write("newFile.txt", "new1\nnew2\nnew3\n")
      await commitAll(repo, "adddelete")

      const runner = new GitRunner(repo.path)
      const doc = await loadReviewDocument(runner, "master")
      const deleted = doc.files.find((f) => f.path === "toDelete.txt")!
      expect(deleted.kind).toBe("deleted")
      const added = doc.files.find((f) => f.path === "newFile.txt")!
      expect(added.kind).toBe("added")

      // deleted: old side ok, new side unavailable
      const oldReq = {
        reviewId: doc.identity.id,
        generationId: doc.generation.id,
        fileKey: deleted.key,
        side: "old" as const,
        startLine: 1,
        endLine: 2,
      }
      const oldOut = await loadSourceContext(runner, doc, oldReq)
      expect(oldOut.ok).toBe(true)
      if (oldOut.ok) expect(oldOut.result.lines).toEqual(["delete me", "line2"])

      const newReqDeleted = {
        reviewId: doc.identity.id,
        generationId: doc.generation.id,
        fileKey: deleted.key,
        side: "new" as const,
        startLine: 1,
        endLine: 1,
      }
      const newOutDeleted = await loadSourceContext(runner, doc, newReqDeleted)
      expect(newOutDeleted.ok).toBe(false)
      if (!newOutDeleted.ok) expect(newOutDeleted.error.kind).toBe("unavailable")

      // added: new side ok, old side unavailable
      const newReqAdded = {
        reviewId: doc.identity.id,
        generationId: doc.generation.id,
        fileKey: added.key,
        side: "new" as const,
        startLine: 1,
        endLine: 2,
      }
      const newOutAdded = await loadSourceContext(runner, doc, newReqAdded)
      expect(newOutAdded.ok).toBe(true)
      if (newOutAdded.ok) expect(newOutAdded.result.lines).toEqual(["new1", "new2"])

      const oldReqAdded = {
        reviewId: doc.identity.id,
        generationId: doc.generation.id,
        fileKey: added.key,
        side: "old" as const,
        startLine: 1,
        endLine: 1,
      }
      const oldOutAdded = await loadSourceContext(runner, doc, oldReqAdded)
      expect(oldOutAdded.ok).toBe(false)
      if (!oldOutAdded.ok) expect(oldOutAdded.error.kind).toBe("unavailable")
    } finally {
      await repo.cleanup()
    }
  })

  test("binary file refusal", async () => {
    const repo = await createTempRepository()
    try {
      await repo.write("base.txt", "base\n")
      await commitAll(repo, "base")
      await repo.git(["checkout", "-b", "feature"])
      const binPath = join(repo.path, "image.png")
      await writeFile(binPath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0x00, 0xab]))
      await commitAll(repo, "binary")

      const runner = new GitRunner(repo.path)
      const doc = await loadReviewDocument(runner, "master")
      const binary = doc.files.find((f) => f.path === "image.png")!
      expect(binary.source).toBe("binary")

      const req = {
        reviewId: doc.identity.id,
        generationId: doc.generation.id,
        fileKey: binary.key,
        side: "new" as const,
        startLine: 1,
        endLine: 1,
      }
      const out = await loadSourceContext(runner, doc, req)
      expect(out.ok).toBe(false)
      if (!out.ok) expect(out.error.kind).toBe("binary")

      const oldReq = {
        reviewId: doc.identity.id,
        generationId: doc.generation.id,
        fileKey: binary.key,
        side: "old" as const,
        startLine: 1,
        endLine: 1,
      }
      const outOld = await loadSourceContext(runner, doc, oldReq)
      // old side for binary added file is unavailable, but may also be binary/unavailable; we accept either unavailable or binary
      expect(outOld.ok).toBe(false)
    } finally {
      await repo.cleanup()
    }
  })

  test("too-large refusal", async () => {
    const repo = await createTempRepository()
    try {
      await repo.write("base.txt", "base\n")
      await commitAll(repo, "base")
      await repo.git(["checkout", "-b", "feature"])
      // create file larger than 1MB
      const largeContent = "x".repeat(1_100_000) // 1.1MB single line
      await repo.write("large.txt", largeContent + "\n")
      await commitAll(repo, "large")

      const runner = new GitRunner(repo.path)
      const doc = await loadReviewDocument(runner, "master")
      const large = doc.files.find((f) => f.path === "large.txt")!
      // source may be available but loadSourceContext should detect too-large via blob size
      const req = {
        reviewId: doc.identity.id,
        generationId: doc.generation.id,
        fileKey: large.key,
        side: "new" as const,
        startLine: 1,
        endLine: 1,
      }
      const out = await loadSourceContext(runner, doc, req, { maxBytes: 1_000_000 })
      expect(out.ok).toBe(false)
      if (!out.ok) expect(out.error.kind).toBe("too-large")
    } finally {
      await repo.cleanup()
    }
  })

  test("request generation echo and stale generation rejection", async () => {
    const repo = await createTempRepository()
    try {
      await repo.write("a.txt", "one\ntwo\nthree\nfour\nfive\n")
      await commitAll(repo, "base")
      await repo.git(["checkout", "-b", "feature"])
      await repo.write("a.txt", "one\nTWO\nthree\nfour\nfive\n")
      await commitAll(repo, "c1")
      const runner = new GitRunner(repo.path)
      const doc1 = await loadReviewDocument(runner, "master")
      const file1 = doc1.files.find((f) => f.path === "a.txt")!
      const reqOk = {
        reviewId: doc1.identity.id,
        generationId: doc1.generation.id,
        fileKey: file1.key,
        side: "new" as const,
        startLine: 1,
        endLine: 2,
      }
      const ok = await loadSourceContext(runner, doc1, reqOk)
      expect(ok.ok).toBe(true)
      if (ok.ok) {
        expect(ok.result.reviewId).toBe(doc1.identity.id)
        expect(ok.result.generationId).toBe(doc1.generation.id)
      }

      // advance generation: new commit
      await repo.write("a.txt", "one\nTWO\nTHREE\nfour\nfive\n")
      await commitAll(repo, "c2")
      const doc2 = await loadReviewDocument(runner, "master")
      expect(doc2.generation.id).not.toBe(doc1.generation.id)

      // stale request with old generationId against new doc should be rejected
      const stale = await loadSourceContext(runner, doc2, reqOk)
      expect(stale.ok).toBe(false)
      if (!stale.ok) expect(stale.error.kind).toBe("stale-generation")

      // stale reviewId also rejected
      const badReviewReq = {
        reviewId: "different-review-id",
        generationId: doc2.generation.id,
        fileKey: file1.key,
        side: "new" as const,
        startLine: 1,
        endLine: 1,
      }
      const badReview = await loadSourceContext(runner, doc2, badReviewReq)
      expect(badReview.ok).toBe(false)
      if (!badReview.ok) expect(badReview.error.kind).toBe("stale-review")
    } finally {
      await repo.cleanup()
    }
  })

  test("range enforcement: invalid range and out-of-bounds", async () => {
    const repo = await createTempRepository()
    try {
      await repo.write("a.txt", "l1\nl2\nl3\n")
      await commitAll(repo, "base")
      await repo.git(["checkout", "-b", "feature"])
      await repo.write("a.txt", "l1\nL2\nl3\n")
      await commitAll(repo, "c1")
      const runner = new GitRunner(repo.path)
      const doc = await loadReviewDocument(runner, "master")
      const file = doc.files.find((f) => f.path === "a.txt")!

      const baseReq = {
        reviewId: doc.identity.id,
        generationId: doc.generation.id,
        fileKey: file.key,
        side: "new" as const,
      } as const

      // start <1
      const r1 = await loadSourceContext(runner, doc, { ...baseReq, startLine: 0, endLine: 1 })
      expect(r1.ok).toBe(false)
      if (!r1.ok) expect(r1.error.kind).toBe("invalid-range")

      // end < start
      const r2 = await loadSourceContext(runner, doc, { ...baseReq, startLine: 2, endLine: 1 })
      expect(r2.ok).toBe(false)
      if (!r2.ok) expect(r2.error.kind).toBe("invalid-range")

      // out of bounds beyond file length (file has 3 lines)
      const r3 = await loadSourceContext(runner, doc, { ...baseReq, startLine: 1, endLine: 10 })
      expect(r3.ok).toBe(false)
      if (!r3.ok) expect(["invalid-range", "unavailable"]).toContain(r3.error.kind)

      // file not found
      const r4 = await loadSourceContext(runner, doc, {
        reviewId: doc.identity.id,
        generationId: doc.generation.id,
        fileKey: "nonexistent",
        side: "new",
        startLine: 1,
        endLine: 1,
      })
      expect(r4.ok).toBe(false)
      if (!r4.ok) expect(r4.error.kind).toBe("file-not-found")
    } finally {
      await repo.cleanup()
    }
  })

  test("uses git show with blobOid from aggregate file metadata", async () => {
    const repo = await createTempRepository()
    try {
      const lines = ["alpha", "beta", "gamma", "delta"]
      await repo.write("tracked.txt", makeFileWithLines("tracked.txt", lines))
      await commitAll(repo, "base")
      await repo.git(["checkout", "-b", "feature"])
      const mod = ["alpha", "BETA", "gamma", "delta"]
      await repo.write("tracked.txt", makeFileWithLines("tracked.txt", mod))
      await commitAll(repo, "mod")

      const runner = new GitRunner(repo.path)
      const doc = await loadReviewDocument(runner, "master")
      const file = doc.files.find((f) => f.path === "tracked.txt")!
      // file should have blob OIDs
      expect(file.oldBlobOid).toBeTruthy()
      expect(file.newBlobOid).toBeTruthy()
      // request old side should fetch old blob content (alpha,beta,gamma,delta)
      const oldReq = {
        reviewId: doc.identity.id,
        generationId: doc.generation.id,
        fileKey: file.key,
        side: "old" as const,
        startLine: 2,
        endLine: 3,
      }
      const oldOut = await loadSourceContext(runner, doc, oldReq)
      expect(oldOut.ok).toBe(true)
      if (oldOut.ok) expect(oldOut.result.lines).toEqual(["beta", "gamma"])
      // new side should fetch new blob content (alpha,BETA...)
      const newReq = {
        reviewId: doc.identity.id,
        generationId: doc.generation.id,
        fileKey: file.key,
        side: "new" as const,
        startLine: 2,
        endLine: 2,
      }
      const newOut = await loadSourceContext(runner, doc, newReq)
      expect(newOut.ok).toBe(true)
      if (newOut.ok) expect(newOut.result.lines).toEqual(["BETA"])
    } finally {
      await repo.cleanup()
    }
  })
})
