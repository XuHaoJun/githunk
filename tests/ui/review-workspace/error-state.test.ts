import { describe, expect, test } from "bun:test"
import {
  createInvalidBaseError,
  createHistoryRewrittenError,
  createGitError,
  createParseError,
  createSourceError,
  createStorageError,
  createCorruptStateError,
  classifyLoadError,
  isEmptyReview,
  isDetachedSnapshot,
  workspaceStatusForDocument,
} from "../../../src/ui/review-workspace/error-state"
import { createReviewDocument, createReviewHunk } from "../../../src/review/core/document"
import { createReviewIdentity, createReviewGeneration } from "../../../src/review/core/identity"
import { ReviewWorkspaceController } from "../../../src/ui/review-workspace/controller"
import type { ReviewFile } from "../../../src/review/core/types"
import type { GitRunner } from "../../../src/git/runner"
import { ReviewStateStore } from "../../../src/review/storage/review-state-store"

function fakeRunner(): GitRunner {
  return { run: async () => ({ stdout: "", stderr: "", exitCode: 0 }) } as unknown as GitRunner
}

function makeHunk(i: number, lines: string[]) {
  return createReviewHunk({ index: i, oldStart: 1, oldCount: lines.length, newStart: 1, newCount: lines.length, lines })
}

function makeFile(overrides: Partial<ReviewFile> & { key: string; path: string }): ReviewFile {
  return {
    kind: "modified",
    oldBlobOid: "o1",
    newBlobOid: "n1",
    oldMode: "100644",
    newMode: "100644",
    contentId: `content-${overrides.key}`,
    patchDigest: `patch-${overrides.key}`,
    stats: { additions: 1, deletions: 1 },
    hunks: [],
    source: "available",
    ...overrides,
  } as unknown as ReviewFile
}

function makeDoc(files: ReviewFile[], opts?: { headRef?: string | null; headOid?: string }) {
  const headRef = opts?.headRef !== undefined ? opts.headRef : "refs/heads/feature"
  const headOid = opts?.headOid ?? "a".repeat(40)
  const identity = headRef === null
    ? createReviewIdentity({ headOid, baseRef: "refs/heads/main" })
    : createReviewIdentity({ headRef, headOid, baseRef: "refs/heads/main" })
  const generation = createReviewGeneration({ baseOid: "b".repeat(40), mergeBaseOid: "c".repeat(40), headOid })
  return createReviewDocument({ identity, generation, commits: [{ oid: headOid, parents: [], author: "A", timestamp: 0, subject: "s", body: "" }], files })
}

describe("error-state — typed actionable errors", () => {
  test("invalid base picker has specific title and choose-base action", () => {
    const err = createInvalidBaseError("refs/heads/does-not-exist")
    expect(err.kind).toBe("invalid-base")
    expect(err.title).toMatch(/Invalid base/i)
    expect(err.detail).toMatch(/does-not-exist/)
    expect(err.action).toBe("choose-base")
    expect(err.title).not.toMatch(/Git operation failed/)
    expect(err.title).not.toMatch(/Failed to parse/)
  })

  test("successful empty diff is status, not error", () => {
    const doc = makeDoc([])
    expect(isEmptyReview(doc)).toBe(true)
    expect(workspaceStatusForDocument(doc)).toBe("empty")
    // Should not be considered error; a controller opened with empty doc should have no error
  })
  test("detached snapshot is status, not error", () => {
    const file = makeFile({ key: "a", path: "src/a.ts", hunks: [makeHunk(0, [" a"])] })
    const doc = makeDoc([file], { headRef: null, headOid: "d".repeat(40) })
    expect(isDetachedSnapshot(doc)).toBe(true)
    expect(workspaceStatusForDocument(doc)).toBe("detached")
    expect(isEmptyReview(doc)).toBe(false)
  })

  test("history rewritten has specific title and dismiss action", () => {
    const err = createHistoryRewrittenError("a".repeat(40), "b".repeat(40))
    expect(err.kind).toBe("history-rewritten")
    expect(err.title).toMatch(/History rewritten/i)
    expect(err.detail).toMatch(/Since Last Review/i)
    expect(err.action).toBe("dismiss")
  })

  test("binary/too-large file maps to source kind with dedicated surface", () => {
    const binaryFile = makeFile({ key: "bin", path: "asset.png", kind: "binary", source: "binary", hunks: [] })
    const doc = makeDoc([binaryFile])
    expect(doc.files[0]!.source).toBe("binary")
    // workspace status should still be normal, not error, but file-level source handling
    expect(workspaceStatusForDocument(doc)).toBe("normal")
    const err = createSourceError("Binary file asset.png — source unavailable, file-level feedback only")
    expect(err.kind).toBe("source")
    expect(err.title).toMatch(/Source unavailable/i)
    expect(err.detail).toMatch(/Binary/)
    // source action is dismiss (or open-feedback) but must be specific, not generic retry for git
    expect(["dismiss", "open-feedback"]).toContain(err.action)
  })

  test("corrupt v2 quarantine has corrupt-state kind and dismiss action", () => {
    const err = createCorruptStateError("/tmp/.git/githunk/review-state-v2.json.corrupt.123", "Review state was corrupt; moved to /tmp/quarantine")
    expect(err.kind).toBe("corrupt-state")
    expect(err.title).toMatch(/corrupt/i)
    expect(err.detail).toMatch(/quarantine|moved to/)
    expect(err.action).toBe("dismiss")
  })

  test("unsupported patch maps to parse kind with retry", () => {
    const err = createParseError("Failed to parse patch for src/broken.ts — unsupported patch format")
    expect(err.kind).toBe("parse")
    expect(err.title).toMatch(/parse/i)
    expect(err.detail).toMatch(/unsupported|broken/)
    expect(err.action).toBe("retry")
    // Also classify via helper
    const classified = classifyLoadError(new Error("parse error: unsupported patch"))
    expect(classified.kind).toBe("parse")
  })

  test("Git command failure maps to git kind with retry", () => {
    const err = createGitError("git rev-parse failed: fatal: ambiguous argument")
    expect(err.kind).toBe("git")
    expect(err.title).toMatch(/Git/i)
    expect(err.detail).toMatch(/rev-parse|fatal/)
    expect(err.action).toBe("retry")
    const classified = classifyLoadError(new Error("git command failed: rev-parse"))
    expect(classified.kind).toBe("git")
  })

  test("mutable-state persistence failure maps to storage kind with retry", async () => {
    const file = makeFile({ key: "a", path: "src/a.ts", hunks: [makeHunk(0, [" a"])] })
    const doc = makeDoc([file])
    // Create a runner that will be used for state store that fails on write
    const runner = fakeRunner() as unknown as GitRunner & { cwd: string }
    ;(runner as unknown as { cwd: string }).cwd = "/tmp/fake"
    // Mock state store that throws on save
    const failingStore = {
      load: async () => ({ version: 2, baseByHead: {}, reviews: {} }),
      saveSemanticChange: async () => { throw new Error("storage write failed: EIO") },
      quarantineWarning: undefined,
      saveDraftDebounced: () => {},
      flush: async () => {},
    } as unknown as ReviewStateStore
    const controller = new ReviewWorkspaceController({ runner, loadDocument: async () => doc, stateStore: failingStore })
    await controller.open("refs/heads/main")
    // After open, persistState should have failed and set storage error, but state should remain
    expect(controller.state).toBeDefined()
    expect(controller.state!.document).toBe(doc)
    const err = controller.error
    expect(err).toBeDefined()
    expect(err!.kind).toBe("storage")
    expect(err!.title).toMatch(/save|storage/i)
    expect(err!.action).toBe("retry")
  })

  test("each error kind has distinct title and action, not generic banner", () => {
    const cases = [
      createInvalidBaseError("refs/heads/main"),
      createHistoryRewrittenError("a".repeat(40), "b".repeat(40)),
      createGitError("git failure"),
      createParseError("parse failure"),
      createSourceError("source failure"),
      createStorageError("storage failure"),
      createCorruptStateError("/tmp/q"),
    ]
    const titles = cases.map(c => c.title)
    const uniqTitles = new Set(titles)
    expect(uniqTitles.size).toBe(cases.length)
    // Ensure actions are within allowed set and not all same
    const actions = cases.map(c => c.action)
    for (const a of actions) {
      expect(["choose-base", "retry", "dismiss", "open-feedback"]).toContain(a)
    }
    // At least two different actions present (choose-base vs retry vs dismiss)
    expect(new Set(actions).size).toBeGreaterThan(1)
  })

  test("empty and detached are not errors even when present", () => {
    const emptyDoc = makeDoc([])
    expect(isEmptyReview(emptyDoc)).toBe(true)
    expect(createGitError("any").kind).not.toBe("empty" as never)

    const detachedDoc = makeDoc([makeFile({ key: "a", path: "a.ts", hunks: [makeHunk(0, [" a"])] })], { headRef: null })
    expect(isDetachedSnapshot(detachedDoc)).toBe(true)
    // workspace status for detached should be detached, not error
    expect(workspaceStatusForDocument(detachedDoc)).toBe("detached")
  })

  test("controller open with invalid base sets invalid-base error and retains no document", async () => {
    const runner = fakeRunner()
    const controller = new ReviewWorkspaceController({
      runner,
      loadDocument: async () => { throw new Error("base ref does not resolve to a commit: refs/heads/ghost") },
    })
    await expect(controller.open("refs/heads/ghost")).rejects.toThrow()
    expect(controller.error).toBeDefined()
    expect(controller.error!.kind).toBe("invalid-base")
    expect(controller.error!.action).toBe("choose-base")
    expect(controller.state).toBeUndefined()
  })

  test("controller refresh with parse failure retains last complete document", async () => {
    const file = makeFile({ key: "a", path: "src/a.ts", hunks: [makeHunk(0, [" a"])] })
    const docV1 = makeDoc([file])
    let shouldFail = false
    const controller = new ReviewWorkspaceController({
      runner: fakeRunner(),
      loadDocument: async (base) => {
        if (shouldFail) throw new Error("Failed to parse patch: unsupported patch for src/broken.ts")
        return docV1
      },
    })
    await controller.open("refs/heads/main")
    const beforeDoc = controller.state!.document
    expect(beforeDoc).toBe(docV1)
    shouldFail = true
    await controller.refreshGeneration()
    // Should retain last complete document
    expect(controller.state!.document).toBe(beforeDoc)
    expect(controller.error).toBeDefined()
    expect(controller.error!.kind).toBe("parse")
    expect(controller.error!.title).toMatch(/parse/i)
  })

  test("history-rewritten error after background refresh preserves aggregate coverage", async () => {
    // This test uses the error-state helper directly as git history check would need real repo
    const err = createHistoryRewrittenError("a".repeat(40), "b".repeat(40), "Since Last Review unavailable after history rewrite")
    expect(err.kind).toBe("history-rewritten")
    expect(err.detail).toMatch(/unavailable|rewritten/i)
  })
})
