import { describe, expect, test } from "bun:test"
import { ReviewWorkspaceController } from "../../../src/ui/review-workspace/controller"
import { createReviewDocument, createReviewHunk } from "../../../src/review/core/document"
import { createReviewIdentity, createReviewGeneration } from "../../../src/review/core/identity"
import { createFileAnchor } from "../../../src/review/core/anchors"
import type { ReviewDocument, ReviewFile } from "../../../src/review/core/types"
import type { SinceLastProjectionResult } from "../../../src/review/git/load-review-projection"
import type { GitRunner } from "../../../src/git/runner"

const HEAD_OID = "a".repeat(40)
const LAST_REVIEWED_OID = "d".repeat(40)

function fakeRunner(): GitRunner {
  const log = {
    logIntro: () => {},
    logAction: () => {},
    logCommand: () => {},
    logTip: () => {},
    lines: () => [] as unknown[],
    autoscrollArms: () => false,
    commandLogSnapshot: () => ({ entries: [] }),
  } as unknown as GitRunner["log"]
  return { run: async () => ({ stdout: "", stderr: "", exitCode: 0 }), log, cwd: "/tmp/fake" } as unknown as GitRunner
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
    hunks: [createReviewHunk({ index: 0, oldStart: 1, oldCount: 1, newStart: 1, newCount: 1, lines: ["-old", "+new"] })],
    source: "available",
    ...overrides,
  }
}

const AGGREGATE_FILES = [
  makeFile({ key: "a", path: "src/a.ts" }),
  makeFile({ key: "b", path: "src/b.ts" }),
  makeFile({ key: "c", path: "src/c.ts" }),
]
// The lens covers lastHead..HEAD, so the same file carries a narrower contentId.
const LENS_FILES = [makeFile({ key: "b", path: "src/b.ts", contentId: "content-b@lens" })]

function makeDoc(files: readonly ReviewFile[], headOid = HEAD_OID): ReviewDocument {
  return createReviewDocument({
    identity: createReviewIdentity({ headRef: "refs/heads/feature", headOid, baseRef: "refs/heads/main" }),
    generation: createReviewGeneration({ baseOid: "b".repeat(40), mergeBaseOid: "c".repeat(40), headOid }),
    commits: [{ oid: headOid, parents: [], author: "A", timestamp: 0, subject: "s", body: "" }],
    files: [...files],
  })
}

function makeController(
  loadSinceLastReview: (aggregate: ReviewDocument, fromHeadOid: string) => Promise<SinceLastProjectionResult>,
  files: readonly ReviewFile[] = AGGREGATE_FILES,
) {
  return new ReviewWorkspaceController({
    runner: fakeRunner(),
    loadDocument: async () => makeDoc(files),
    loadSinceLastReview,
  })
}

function okLens(): (aggregate: ReviewDocument, fromHeadOid: string) => Promise<SinceLastProjectionResult> {
  return async (aggregate, fromHeadOid) => ({
    kind: "ok",
    document: {
      reviewId: aggregate.identity.id,
      generationId: aggregate.generation.id,
      projection: { kind: "since-last-review", fromHeadOid },
      files: LENS_FILES,
    },
  })
}

/** A finished review is what makes "since last review" meaningful. */
function withLastSubmission(controller: ReviewWorkspaceController): void {
  const state = controller.state!
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(controller as unknown as { _state: unknown })._state = {
    ...state,
    lastSubmission: {
      artifactId: "artifact-1",
      generationId: state.document.generation.id,
      headOid: LAST_REVIEWED_OID,
      submittedAt: "2026-09-01T00:00:00.000Z",
    },
  }
}

describe("Since-last-review projection lens", () => {
  test("refuses to open without a previous finished review", async () => {
    const controller = makeController(okLens())
    await controller.open("refs/heads/main")

    expect(await controller.enterSinceLastReview()).toEqual({ ok: false, reason: "no-previous-review" })
    expect(controller.state?.projection).toEqual({ kind: "aggregate" })
  })

  test("narrows the stream to the files changed since the last review", async () => {
    const controller = makeController(okLens())
    await controller.open("refs/heads/main")
    withLastSubmission(controller)

    const result = await controller.enterSinceLastReview()

    expect(result).toEqual({ ok: true, fileCount: 1 })
    expect(controller.state?.projection).toEqual({ kind: "since-last-review", fromHeadOid: LAST_REVIEWED_OID })
    expect(controller.state?.document.files.map((file) => file.path)).toEqual(["src/b.ts"])
  })

  test("passes the previous head to the loader as the range start", async () => {
    let seen: string | undefined
    const controller = makeController(async (aggregate, fromHeadOid) => {
      seen = fromHeadOid
      return okLens()(aggregate, fromHeadOid)
    })
    await controller.open("refs/heads/main")
    withLastSubmission(controller)
    await controller.enterSinceLastReview()

    expect(seen).toBe(LAST_REVIEWED_OID)
  })

  test("keeps feedback and viewed records with the aggregate", async () => {
    const controller = makeController(okLens())
    await controller.open("refs/heads/main")
    withLastSubmission(controller)
    const before = controller.state!
    ;(controller as unknown as { _state: unknown })._state = {
      ...before,
      feedback: [{
        id: "feedback-1",
        kind: "note" as const,
        severity: "comment" as const,
        body: "keep me",
        anchor: createFileAnchor(AGGREGATE_FILES[0]!),
        resolution: "active" as const,
        createdAt: "2026-09-01T00:00:00.000Z",
        updatedAt: "2026-09-01T00:00:00.000Z",
      }],
    }
    const withFeedback = controller.state!

    await controller.enterSinceLastReview()

    expect(controller.state?.feedback).toBe(withFeedback.feedback)
    expect(controller.state?.lastSubmission).toBe(withFeedback.lastSubmission)
  })

  test("reports a rewritten history instead of showing a wrong range", async () => {
    const controller = makeController(async () => ({
      kind: "history-rewritten",
      lastHeadOid: LAST_REVIEWED_OID,
      headOid: HEAD_OID,
      reason: "history rewritten: last submission head is not an ancestor of current HEAD",
    }))
    await controller.open("refs/heads/main")
    withLastSubmission(controller)

    const result = await controller.enterSinceLastReview()

    expect(result.ok).toBe(false)
    expect(result.ok === false ? result.reason : "").toBe("history-rewritten")
    expect(controller.state?.projection).toEqual({ kind: "aggregate" })
  })

  test("surfaces a loader failure without leaving a half-applied lens", async () => {
    const controller = makeController(async () => { throw new Error("git exploded") })
    await controller.open("refs/heads/main")
    withLastSubmission(controller)

    const result = await controller.enterSinceLastReview()

    expect(result).toEqual({ ok: false, reason: "load-failed", message: "git exploded" })
    expect(controller.state?.projection).toEqual({ kind: "aggregate" })
    expect(controller.state?.document.files).toHaveLength(3)
  })

  test("refuses to stack a second lens on an open one", async () => {
    const controller = makeController(okLens())
    await controller.open("refs/heads/main")
    withLastSubmission(controller)
    await controller.enterSinceLastReview()

    expect(await controller.enterSinceLastReview()).toEqual({ ok: false, reason: "already-projected" })
  })

  test("restores the aggregate document on exit", async () => {
    const controller = makeController(okLens())
    await controller.open("refs/heads/main")
    withLastSubmission(controller)
    const aggregateDocument = controller.state!.document
    await controller.enterSinceLastReview()

    expect(controller.exitProjection()).toBe(true)
    expect(controller.state?.projection).toEqual({ kind: "aggregate" })
    expect(controller.state?.document).toBe(aggregateDocument)
    // A second exit has nothing to restore.
    expect(controller.exitProjection()).toBe(false)
  })

  test("drops the lens when a refresh brings a new generation", async () => {
    let head = HEAD_OID
    const controller = new ReviewWorkspaceController({
      runner: fakeRunner(),
      loadDocument: async () => makeDoc(AGGREGATE_FILES, head),
      loadSinceLastReview: okLens(),
    })
    await controller.open("refs/heads/main")
    withLastSubmission(controller)
    await controller.enterSinceLastReview()
    expect(controller.state?.projection.kind).toBe("since-last-review")

    // The lens was computed against the previous generation.
    head = "e".repeat(40)
    await controller.refreshGeneration()

    expect(controller.state?.projection).toEqual({ kind: "aggregate" })
    expect(controller.state?.document.files).toHaveLength(3)
    // The stale stash must not resurrect the old document on a later exit.
    expect(controller.exitProjection()).toBe(false)
  })
})
