import { describe, expect, test } from "bun:test"
import { writeFile } from "node:fs/promises"
import { join } from "node:path"
import { createTempRepository, type TempRepository } from "../../helpers/temp-repository"
import { GitRunner } from "../../../src/git/runner"
import { loadReviewDocument } from "../../../src/review/git/load-review-document"
import {
  isAncestor,
  loadCommitProjection,
  loadSinceLastReviewProjection,
} from "../../../src/review/git/load-review-projection"
import { planReviewIntent } from "../../../src/review/core/intents"
import { createInitialReviewState } from "../../../src/review/core/state"
import { canMarkViewedInProjection } from "../../../src/review/core/selectors"
import { createReviewDocument } from "../../../src/review/core/document"
import { createReviewGeneration, createReviewIdentity } from "../../../src/review/core/identity"
import type { ReviewDocument } from "../../../src/review/core/types"

async function commitAll(repo: TempRepository, message: string): Promise<string> {
  const added = await repo.git(["add", "-A"])
  if (added.exitCode !== 0) throw new Error(added.stderr)
  const created = await repo.git(["commit", "--quiet", "-m", message])
  if (created.exitCode !== 0) throw new Error(`commit failed: ${created.stderr}`)
  const oid = await repo.git(["rev-parse", "HEAD"])
  return oid.stdout.trim()
}

describe("projections integration", () => {
  test("Since Last Review uses lastHead..HEAD and is view over same identity", async () => {
    const repo = await createTempRepository()
    try {
      await repo.write("base.txt", "base\n")
      const baseOid = await commitAll(repo, "base")
      await repo.git(["checkout", "-b", "feature"])

      await repo.write("a.txt", "one\n")
      const c1 = await commitAll(repo, "c1")
      await repo.write("a.txt", "one\ntwo\n")
      const c2 = await commitAll(repo, "c2")
      await repo.write("b.txt", "b\n")
      const c3 = await commitAll(repo, "c3")

      const runner = new GitRunner(repo.path)
      const doc = await loadReviewDocument(runner, "master")

      // since-last from c1 should include changes from c2 and c3 only, not c1's initial add?
      // lastHead..HEAD excludes lastHead itself, so diff c1..HEAD includes c2,c3
      const result = await loadSinceLastReviewProjection(runner, doc, c1)
      expect(result.kind).toBe("ok")
      if (result.kind !== "ok") throw new Error("expected ok")
      expect(result.document.reviewId).toBe(doc.identity.id)
      expect(result.document.generationId).toBe(doc.generation.id)
      expect(result.document.projection).toEqual({ kind: "since-last-review", fromHeadOid: c1 })
      // neither constructs a new ReviewIdentity
      expect(result.document.reviewId).not.toBe("different")

      // files should be delta c1..HEAD : a.txt modified to add "two", plus b.txt added
      const paths = result.document.files.map((f) => f.path).sort()
      // a.txt should be present (changed in c2) and b.txt (added in c3)
      expect(paths).toContain("a.txt")
      expect(paths).toContain("b.txt")
      // should NOT contain only c1's file alone? It should contain all since c1, which we verified
      // Check that a.txt contentId reflects diff since c1 (should be same as aggregate? Actually aggregate is base...HEAD includes all 3 commits, since-last is subset but for this repo base...HEAD also includes a.txt+b.txt so may be same. Need more precise: create file only in c1 not modified later, then since-last from c1 should NOT contain it.
      // Add a dedicated check: create file only in c1 that is not touched after, since-last should not include it.
      // To test includes all changes since submission, create c1-exclusive file
      // Already tested implicitly, now add explicit
      await repo.write("only-c1.txt", "only c1\n")
      // Actually need to create earlier, but we can test separate repo
    } finally {
      await repo.cleanup()
    }
  })

  test("Since Last Review is available only when last head is ancestor", async () => {
    const repo = await createTempRepository()
    try {
      await repo.write("x.txt", "0\n")
      await commitAll(repo, "base")
      await repo.git(["checkout", "-b", "feature"])
      await repo.write("x.txt", "1\n")
      const c1 = await commitAll(repo, "c1")
      await repo.write("x.txt", "2\n")
      const c2 = await commitAll(repo, "c2")

      const runner = new GitRunner(repo.path)
      const doc = await loadReviewDocument(runner, "master")

      // c1 is ancestor of HEAD (c2) => ok
      const ok = await loadSinceLastReviewProjection(runner, doc, c1)
      expect(ok.kind).toBe("ok")

      // non-ancestor oid (e.g., base's parent or unrelated) should be history-rewritten
      // Create unrelated commit on another branch and use its oid
      await repo.git(["checkout", "master"])
      await repo.write("unrelated.txt", "unrelated\n")
      const unrelated = await commitAll(repo, "unrelated")
      await repo.git(["checkout", "feature"])
      const doc2 = await loadReviewDocument(runner, "master")
      const rewritten = await loadSinceLastReviewProjection(runner, doc2, unrelated)
      expect(rewritten.kind).toBe("history-rewritten")
      if (rewritten.kind === "history-rewritten") {
        expect(rewritten.lastHeadOid).toBe(unrelated)
        expect(rewritten.headOid).toBe(doc2.generation.headOid)
      }

      // isAncestor helper directly
      expect(await isAncestor(runner, c1, c2)).toBe(true)
      expect(await isAncestor(runner, unrelated, c2)).toBe(false)
      expect(await isAncestor(runner, c2, c2)).toBe(true) // equality is ancestor
    } finally {
      await repo.cleanup()
    }
  })

  test("Since Last Review includes all changes since submission", async () => {
    const repo = await createTempRepository()
    try {
      await repo.write("base.txt", "base\n")
      await commitAll(repo, "base")
      await repo.git(["checkout", "-b", "feature"])
      await repo.write("only-c1.txt", "c1\n")
      const c1 = await commitAll(repo, "c1")
      await repo.write("only-c2.txt", "c2\n")
      const c2 = await commitAll(repo, "c2")
      await repo.write("only-c3.txt", "c3\n")
      const c3 = await commitAll(repo, "c3")

      const runner = new GitRunner(repo.path)
      const doc = await loadReviewDocument(runner, "master")

      const result = await loadSinceLastReviewProjection(runner, doc, c1)
      expect(result.kind).toBe("ok")
      if (result.kind !== "ok") throw new Error("expected ok")
      const paths = result.document.files.map((f) => f.path).sort()
      // since c1..HEAD includes c2 and c3 but NOT c1's own file
      expect(paths).not.toContain("only-c1.txt")
      expect(paths).toContain("only-c2.txt")
      expect(paths).toContain("only-c3.txt")

      // from c2 should only contain c3
      const result2 = await loadSinceLastReviewProjection(runner, doc, c2)
      expect(result2.kind).toBe("ok")
      if (result2.kind !== "ok") throw new Error("expected ok")
      const paths2 = result2.document.files.map((f) => f.path).sort()
      expect(paths2).toEqual(["only-c3.txt"])
    } finally {
      await repo.cleanup()
    }
  })

  test("Since Last Review disabled after amend/force rewrite returns typed history-rewritten not throw", async () => {
    const repo = await createTempRepository()
    try {
      await repo.write("f.txt", "base\n")
      await commitAll(repo, "base")
      await repo.git(["checkout", "-b", "feature"])
      await repo.write("f.txt", "one\n")
      const c1 = await commitAll(repo, "c1")
      await repo.write("f.txt", "two\n")
      const c2 = await commitAll(repo, "c2")
      const oldHead = c2

      // amend last commit (rewrites history, oldHead not ancestor of new HEAD)
      await repo.git(["commit", "--amend", "--quiet", "-m", "c2 amended"])
      const newHead = (await repo.git(["rev-parse", "HEAD"])).stdout.trim()
      expect(newHead).not.toBe(oldHead)

      const runner = new GitRunner(repo.path)
      const doc = await loadReviewDocument(runner, "master")
      expect(doc.generation.headOid).toBe(newHead)

      const result = await loadSinceLastReviewProjection(runner, doc, oldHead)
      expect(result.kind).toBe("history-rewritten")
      if (result.kind === "history-rewritten") {
        expect(result.reason).toMatch(/history/i)
      }

      // also test isAncestor reflects rewrite
      expect(await isAncestor(runner, oldHead, newHead)).toBe(false)

      // force rewrite via reset + new commit
      await repo.write("f.txt", "three\n")
      await repo.git(["add", "-A"])
      await repo.git(["commit", "--quiet", "-m", "c3 new"])
      const afterResetHead = (await repo.git(["rev-parse", "HEAD"])).stdout.trim()
      const doc2 = await loadReviewDocument(runner, "master")
      const result2 = await loadSinceLastReviewProjection(runner, doc2, oldHead)
      expect(result2.kind).toBe("history-rewritten")
    } finally {
      await repo.cleanup()
    }
  })

  test("commit projection contains only that commit", async () => {
    const repo = await createTempRepository()
    try {
      await repo.write("a.txt", "base\n")
      await commitAll(repo, "base")
      await repo.git(["checkout", "-b", "feature"])
      await repo.write("a.txt", "base\nc1\n")
      const c1 = await commitAll(repo, "c1")
      await repo.write("b.txt", "b1\n")
      const c2 = await commitAll(repo, "c2")
      await repo.write("a.txt", "base\nc1\nc3\n")
      const c3 = await commitAll(repo, "c3")

      const runner = new GitRunner(repo.path)
      const doc = await loadReviewDocument(runner, "master")

      // commit c2 should only contain b.txt, not a.txt changes from c1/c3
      const projC2 = await loadCommitProjection(runner, doc, c2)
      expect(projC2.reviewId).toBe(doc.identity.id)
      expect(projC2.generationId).toBe(doc.generation.id)
      expect(projC2.projection).toEqual({ kind: "commit", oid: c2 })
      const pathsC2 = projC2.files.map((f) => f.path).sort()
      expect(pathsC2).toEqual(["b.txt"])
      // ensure it does not construct new identity (reviewId same)
      expect(projC2.reviewId).toBe(doc.identity.id)

      // commit c1 should contain a.txt
      const projC1 = await loadCommitProjection(runner, doc, c1)
      expect(projC1.files.map((f) => f.path)).toContain("a.txt")
      expect(projC1.files.find((f) => f.path === "b.txt")).toBeUndefined()

      // commit c3 should contain a.txt with its own hunk
      const projC3 = await loadCommitProjection(runner, doc, c3)
      expect(projC3.files.map((f) => f.path)).toContain("a.txt")
    } finally {
      await repo.cleanup()
    }
  })

  test("commit projection for root commit uses empty-tree range", async () => {
    const repo = await createTempRepository()
    try {
      await repo.write("root.txt", "root\n")
      const rootOid = await commitAll(repo, "root")
      await repo.write("second.txt", "second\n")
      const second = await commitAll(repo, "second")
      // base is root, feature is second? Need to test root projection from document where root is only commit
      // Create a new repo where root is the commit to project
      const runner = new GitRunner(repo.path)
      // Create a feature branch from root and add another commit, aggregate will be root..HEAD which is second
      // But we want to test commit projection for root itself from a document that includes root
      // So create a document with base being its parent (empty tree) ??? Instead, test directly loadCommitProjection for rootOid
      // We'll create doc with base = rootOid^ (empty tree) ? Use master as base? Simplify: load document for master..HEAD where master is rootOid
      // Actually we have master at root, feature at second, aggregate base...HEAD with base master (root) => includes second only, not root itself. So root not in document.
      // To have root in document, we need base before root, but root is initial commit, no base. So we test projection loader directly without needing doc to contain root.
      // For this test, create a separate temp repo where we test root projection via loader's empty tree handling.
      // Create new repo with single commit root only, then loader should handle root.
      const repo2 = await createTempRepository()
      try {
        await repo2.write("only.txt", "only\n")
        const onlyRoot = await commitAll(repo2, "only")
        const runner2 = new GitRunner(repo2.path)
        // Need a document: we can create a synthetic document with that commit, or load aggregate with base that yields empty document and then request root projection
        // Simpler: create doc via loadReviewDocument where base is same as HEAD (empty diff) but commits will be empty, so we need to bypass that.
        // Instead, test that loadCommitProjection works for root even when doc doesn't contain it? We expect it to work via git.
        const identity = createReviewIdentity({ headRef: "refs/heads/master", headOid: onlyRoot, baseRef: "refs/heads/master" })
        const generation = createReviewGeneration({ baseOid: onlyRoot, mergeBaseOid: onlyRoot, headOid: onlyRoot })
        // Create empty doc then test loader with root
        const dummyDoc = createReviewDocument({
          identity,
          generation,
          commits: [{ oid: onlyRoot, parents: [], author: "a", timestamp: 1, subject: "only", body: "" }] as unknown as ReviewDocument["commits"],
          files: [],
        })
        const proj = await loadCommitProjection(runner2, dummyDoc, onlyRoot)
        expect(proj.files.map((f) => f.path)).toContain("only.txt")
        expect(proj.projection).toEqual({ kind: "commit", oid: onlyRoot })
      } finally {
        await repo2.cleanup()
      }
    } finally {
      await repo.cleanup()
    }
  })

  test("commit projection cannot mark aggregate coverage is projection-invariant", async () => {
    const repo = await createTempRepository()
    try {
      await repo.write("a.txt", "base\n")
      await commitAll(repo, "base")
      await repo.git(["checkout", "-b", "feature"])
      await repo.write("a.txt", "changed\n")
      const c1 = await commitAll(repo, "c1")
      const runner = new GitRunner(repo.path)
      const doc = await loadReviewDocument(runner, "master")
      const proj = await loadCommitProjection(runner, doc, c1)
      // Create state with aggregate document but commit projection
      const state = createInitialReviewState(doc)
      const stateWithCommit = { ...state, projection: proj.projection } as typeof state
      // attempting to mark viewed in commit projection must throw projection-invalid
      expect(() => planReviewIntent(stateWithCommit, { type: "viewed/mark", fileKey: doc.files[0]!.key, viewedAt: new Date().toISOString() })).toThrow()
      // Also via canMarkViewedInProjection selector
      expect(canMarkViewedInProjection(stateWithCommit)).toBe(false)
      // aggregate still allows
      expect(canMarkViewedInProjection({ projection: { kind: "aggregate" } } as unknown as Parameters<typeof canMarkViewedInProjection>[0])).toBe(true)
      expect(canMarkViewedInProjection({ projection: { kind: "since-last-review", fromHeadOid: c1 } } as unknown as Parameters<typeof canMarkViewedInProjection>[0])).toBe(true)
    } finally {
      await repo.cleanup()
    }
  })

  test("projections do not create new ReviewIdentity", async () => {
    const repo = await createTempRepository()
    try {
      await repo.write("x.txt", "0\n")
      await commitAll(repo, "base")
      await repo.git(["checkout", "-b", "feature"])
      await repo.write("x.txt", "1\n")
      const c1 = await commitAll(repo, "c1")
      const runner = new GitRunner(repo.path)
      const doc = await loadReviewDocument(runner, "master")
      const since = await loadSinceLastReviewProjection(runner, doc, c1)
      if (since.kind === "ok") {
        expect(since.document.reviewId).toBe(doc.identity.id)
      }
      const commitProj = await loadCommitProjection(runner, doc, c1)
      expect(commitProj.reviewId).toBe(doc.identity.id)
      // Ensure no new identity created (reviewId same as aggregate, not derived from headOid)
    } finally {
      await repo.cleanup()
    }
  })
})
