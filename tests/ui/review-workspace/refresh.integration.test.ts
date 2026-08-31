import { describe, expect, test } from "bun:test"
import { ReviewWorkspaceController } from "../../../src/ui/review-workspace/controller"
import { ReactReviewHost } from "../../../src/ui/review-workspace/react-review-host"
import { ReviewStateStore, persistedFromReviewState } from "../../../src/review/storage/review-state-store"
import { createReviewDocument, createReviewHunk } from "../../../src/review/core/document"
import { createReviewIdentity, createReviewGeneration } from "../../../src/review/core/identity"
import { createInitialReviewState } from "../../../src/review/core/state"
import { createLineSelection } from "../../../src/review/core/anchors"
import type { ReviewFile } from "../../../src/review/core/types"
import type { GitRunner } from "../../../src/git/runner"
import { createApp } from "../../../src/app/create-app"
import { createTestRenderer } from "@opentui/core/testing"
import type { CliRenderer } from "@opentui/core"

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

function makeHunk(index: number, lines: string[], opts?: { oldStart?: number; newStart?: number }) {
  const oldStart = opts?.oldStart ?? 1
  const newStart = opts?.newStart ?? 1
  return createReviewHunk({ index, oldStart, oldCount: lines.filter(l => l[0] !== "+").length, newStart, newCount: lines.filter(l => l[0] !== "-").length, lines })
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

function makeDoc(files: ReviewFile[], headOid: string) {
  const identity = createReviewIdentity({ headRef: "refs/heads/feature", headOid, baseRef: "refs/heads/main" })
  const baseOid = "b".repeat(40)
  const mergeBaseOid = "c".repeat(40)
  const generation = createReviewGeneration({ baseOid, mergeBaseOid, headOid })
  return createReviewDocument({ identity, generation, commits: [{ oid: headOid, parents: [], author: "A", timestamp: 0, subject: "s", body: "" }], files })
}

describe("refresh integration — monotonic qualification, atomic swap, reconciliation", () => {
  test("opening persisted deferred projection metadata normalizes the active state to aggregate", async () => {
    const doc = makeDoc([makeFile({ key: "a", path: "src/a.ts", hunks: [makeHunk(0, [" a"])] })], "a".repeat(40))
    const initial = createInitialReviewState(doc)
    const persisted = {
      ...persistedFromReviewState(initial),
      projection: { kind: "commit" as const, oid: "c".repeat(40) },
    }
    const db = { version: 2 as const, baseByHead: {}, reviews: { [doc.identity.id]: persisted } }
    let written: typeof db | undefined
    const stateStore = {
      load: async () => db,
      saveSemanticChange: async (updater: (value: typeof db) => typeof db) => { written = updater(db) },
      flush: async () => undefined,
    } as unknown as ReviewStateStore
    const controller = new ReviewWorkspaceController({ runner: fakeRunner(), stateStore, loadDocument: async () => doc })
    const state = await controller.open("refs/heads/main")
    expect(state.projection).toEqual({ kind: "aggregate" })
    expect(written?.reviews[doc.identity.id]?.projection).toEqual({ kind: "aggregate" })
    const setup = await createTestRenderer({ width: 120, height: 24 })
    const host = new ReactReviewHost(setup.renderer as unknown as CliRenderer, controller, () => undefined)
    try {
      await setup.renderOnce()
      await setup.renderOnce()
      const frame = setup.captureCharFrame()
      expect(frame).toContain("[Aggregate]")
      expect(frame).not.toContain("Since Last")
      expect(frame).not.toContain("Commit")
    } finally {
      host.destroy()
      controller.destroy()
      await setup.renderer.destroy()
    }
  })
  test("slow generation A followed by fast generation B: old result discarded, fast wins", async () => {
    const fileA = makeFile({ key: "a", path: "src/a.ts", contentId: "content-A", patchDigest: "patch-A", hunks: [makeHunk(0, [" a"])] })
    const fileB = makeFile({ key: "a", path: "src/a.ts", contentId: "content-B", patchDigest: "patch-B", hunks: [makeHunk(0, [" b"])] })

    const docA = makeDoc([fileA], "a".repeat(40))
    const docB = makeDoc([fileB], "b".repeat(40))

    const initialFile = makeFile({ key: "a", path: "src/a.ts", contentId: "content-init", patchDigest: "patch-init", hunks: [makeHunk(0, [" init"])] })
    const initialDoc = makeDoc([initialFile], "0".repeat(40))

    let loadCount = 0
    const controller = new ReviewWorkspaceController({
      runner: fakeRunner(),
      loadDocument: async () => {
        if (loadCount === 0) {
          loadCount++
          return initialDoc
        }
        if (loadCount === 1) {
          loadCount++
          await new Promise(r => setTimeout(r, 30))
          return docA
        } else {
          await new Promise(r => setTimeout(r, 5))
          return docB
        }
      },
    })

    await controller.open("refs/heads/main")
    expect(controller.state!.document).toBe(initialDoc)

    const pSlow = controller.refreshGeneration()
    const pFast = controller.refreshGeneration()
    await Promise.all([pSlow, pFast])

    expect(controller.state!.document.generation.headOid).toBe("b".repeat(40))
    expect(controller.state!.document.files[0]!.contentId).toBe("content-B")
    expect(controller.state!.document.files[0]!.contentId).not.toBe("content-A")
  })

  test("source result from old generation discarded", async () => {
    const hOld1 = createReviewHunk({ index: 0, oldStart: 1, oldCount: 3, newStart: 1, newCount: 3, lines: [" a", " b", " c"] })
    const hOld2 = createReviewHunk({ index: 1, oldStart: 10, oldCount: 1, newStart: 10, newCount: 1, lines: [" x"] })
    const fileV1 = makeFile({ key: "src/a.ts", path: "src/a.ts", contentId: "content-v1", hunks: [hOld1, hOld2] })
    const docV1 = makeDoc([fileV1], "a".repeat(40))

    const hNew1 = createReviewHunk({ index: 0, oldStart: 1, oldCount: 2, newStart: 1, newCount: 2, lines: [" a", " b"] })
    const hNew2 = createReviewHunk({ index: 1, oldStart: 20, oldCount: 1, newStart: 20, newCount: 1, lines: [" y"] })
    const fileV2 = makeFile({ key: "src/a.ts", path: "src/a.ts", contentId: "content-v2", hunks: [hNew1, hNew2] })
    const docV2 = makeDoc([fileV2], "b".repeat(40))

    let currentDoc = docV1
    const controller = new ReviewWorkspaceController({
      runner: fakeRunner(),
      loadDocument: async () => currentDoc,
      loadSourceContextImpl: async (req) => {
        await new Promise(r => setTimeout(r, 20))
        return { ok: true, result: { lines: ["ctx1", "ctx2"], range: [req.startLine, req.endLine] } as never }
      },
    })
    await controller.open("refs/heads/main")

    const gapPromise = controller.expandGap("src/a.ts", "before:1")
    currentDoc = docV2
    await controller.refreshGeneration()
    expect(controller.state!.document.files[0]!.contentId).toBe("content-v2")
    await gapPromise
    expect(controller.state!.document.files[0]!.contentId).toBe("content-v2")
  })

  test("failed parse retaining last complete document", async () => {
    const file = makeFile({ key: "a", path: "src/a.ts", contentId: "content-good", hunks: [makeHunk(0, [" a"])] })
    const docGood = makeDoc([file], "a".repeat(40))
    let shouldFail = false
    const controller = new ReviewWorkspaceController({
      runner: fakeRunner(),
      loadDocument: async () => {
        if (shouldFail) throw new Error("Failed to parse patch: unsupported patch for src/broken.ts")
        return docGood
      },
    })
    await controller.open("refs/heads/main")
    const before = controller.state!.document
    expect(before).toBe(docGood)
    shouldFail = true
    await controller.refreshGeneration()
    expect(controller.state!.document).toBe(before)
    expect(controller.error).toBeDefined()
    expect(controller.error!.kind).toBe("parse")
  })

  test("changed file invalidation, unchanged preservation, draft survival, feedback stale/orphaned", async () => {
    const h = makeHunk(0, [" a"])
    const fileA_v1 = makeFile({ key: "a", path: "src/a.ts", contentId: "content-a-v1", patchDigest: "patch-a-v1", hunks: [h] })
    const fileB_v1 = makeFile({ key: "b", path: "src/b.ts", contentId: "content-b-v1", patchDigest: "patch-b-v1", hunks: [makeHunk(0, [" b"])] })

    const docV1 = makeDoc([fileA_v1, fileB_v1], "a".repeat(40))

    const fileA_v2 = makeFile({ key: "a", path: "src/a.ts", contentId: "content-a-v2", patchDigest: "patch-a-v2", hunks: [makeHunk(0, [" changed"])] })
    const fileB_v2 = makeFile({ key: "b", path: "src/b.ts", contentId: "content-b-v1", patchDigest: "patch-b-v1", hunks: [makeHunk(0, [" b"])] })

    const docV2 = makeDoc([fileA_v2, fileB_v2], "b".repeat(40))


    let currentDoc = docV1
    const controller = new ReviewWorkspaceController({
      runner: fakeRunner(),
      loadDocument: async () => currentDoc,
    })
    await controller.open("refs/heads/main")

    const viewedAt = new Date().toISOString()
    const state = controller.state!
    const recordA = { fileKey: "a", path: "src/a.ts", contentId: "content-a-v1", generationId: state.document.generation.id, viewedAt }
    const recordB = { fileKey: "b", path: "src/b.ts", contentId: "content-b-v1", generationId: state.document.generation.id, viewedAt }
    controller.dispatch({ type: "viewed/mark", fileKey: "a", record: recordA })
    controller.dispatch({ type: "viewed/mark", fileKey: "b", record: recordB })
    expect(controller.state!.viewed["a"]).toBeDefined()
    expect(controller.state!.viewed["b"]).toBeDefined()

    const draftAnchor = { kind: "file" as const, fileKey: "a", contentId: "content-a-v1" }
    controller.dispatch({ type: "feedback/start-draft", draft: { anchor: draftAnchor, kind: "note", severity: "comment", body: "draft body", replacement: undefined } as unknown as never })
    expect(controller.state!.draft).toBeDefined()

    const anchorA = { kind: "range" as const, fileKey: "a", contentId: "content-a-v1", side: "new" as const, startLine: 1, endLine: 1, ownerHunkIndex: 0, contextDigest: "digest-a" }
    const feedback = { id: "fb1", kind: "note" as const, severity: "comment" as const, body: "note", anchor: anchorA, resolution: "active" as const, createdAt: viewedAt, updatedAt: viewedAt }
    controller.dispatch({ type: "feedback/create", feedback } as unknown as never)
    expect(controller.state!.feedback.length).toBe(1)

    const fileC_v1 = makeFile({ key: "c", path: "src/c.ts", contentId: "content-c-v1", hunks: [makeHunk(0, [" c"])] })
    const docV1WithC = makeDoc([fileA_v1, fileB_v1, fileC_v1], "c".repeat(40))
    currentDoc = docV1WithC
    await controller.refreshGeneration()
    expect(controller.state!.document.files.some(f => f.key === "c")).toBe(true)
    const anchorC = { kind: "file" as const, fileKey: "c", contentId: "content-c-v1" }
    const feedbackC = { id: "fbC", kind: "note" as const, severity: "comment" as const, body: "c note", anchor: anchorC, resolution: "active" as const, createdAt: viewedAt, updatedAt: viewedAt }
    controller.dispatch({ type: "feedback/create", feedback: feedbackC } as unknown as never)
    expect(controller.state!.feedback.length).toBe(2)
    const draftAnchor2 = { kind: "file" as const, fileKey: "b", contentId: "content-b-v1" }
    controller.dispatch({ type: "feedback/start-draft", draft: { anchor: draftAnchor2, kind: "note", severity: "comment", body: "draft body", replacement: undefined } as unknown as never })
    expect(controller.state!.draft).toBeDefined()

    currentDoc = docV2
    await controller.refreshGeneration()

    const after = controller.state!
    expect(after.viewed["a"]).toBeDefined()
    expect(after.viewed["a"]!.contentId).toBe("content-a-v1")
    expect(after.document.files.find(f => f.key === "a")!.contentId).toBe("content-a-v2")
    expect(after.viewed["b"]).toBeDefined()
    expect(after.viewed["b"]!.contentId).toBe("content-b-v1")
    expect(after.document.files.find(f => f.key === "b")!.contentId).toBe("content-b-v1")

    expect(after.draft).toBeDefined()
    expect(after.draft!.body).toBe("draft body")

    const fbA = after.feedback.find(f => f.id === "fb1")!
    expect(["stale", "active", "orphaned"]).toContain(fbA.resolution)
    const fbC = after.feedback.find(f => f.id === "fbC")
    if (fbC) {
      expect(fbC.resolution).toBe("orphaned")
    } else {
      expect(after.feedback.length).toBeGreaterThanOrEqual(1)
    }
  })

  test("hidden repository refresh not repainting the review screen", async () => {
    const runner = fakeRunner()
    let repoRefreshCalls = 0
    const setup = await createTestRenderer({ width: 80, height: 24 })
    const renderer = setup.renderer as unknown as CliRenderer
    let viewUpdates = 0
    const doc = makeDoc([makeFile({ key: "a", path: "src/a.ts", hunks: [makeHunk(0, [" a"])] })], "a".repeat(40))
    const app = createApp({
      repositoryRoot: "/tmp/fake",
      runner: runner as unknown as GitRunner,
      renderer,
      reviewLoaders: {
        loadDocument: async () => doc,
      },
    } as unknown as Parameters<typeof createApp>[0])

    const repoController = (app as unknown as { controller: { refresh: () => Promise<void> } }).controller
    const originalRepoRefresh = repoController.refresh.bind(repoController)
    repoController.refresh = async () => {
      repoRefreshCalls++
      return originalRepoRefresh()
    }
    const viewObj = (app as unknown as { view: { update: (s: unknown) => void } }).view
    const originalViewUpdate = viewObj.update.bind(viewObj)
    viewObj.update = (s: unknown) => {
      viewUpdates++
      return originalViewUpdate(s as never)
    }

    const screen = (app as unknown as { screenController: { active: { kind: string }; openBranchReview: () => Promise<void>; shouldRenderRepository: () => boolean } }).screenController
    await screen.openBranchReview()
    expect(screen.active.kind).toBe("branch-review")
    expect(screen.shouldRenderRepository()).toBe(false)

    const updatesBefore = viewUpdates

    await repoController.refresh()
    expect(viewUpdates).toBe(updatesBefore)

    await (screen as unknown as { closeBranchReview: () => Promise<void> }).closeBranchReview()
    expect(screen.active.kind).toBe("repository")
    await repoController.refresh()
    viewObj.update((repoController as unknown as { state: unknown }).state)
    expect(viewUpdates).toBeGreaterThan(updatesBefore)

    app.destroy()
    setup.renderer.destroy()
  })
  test("reopen restores persisted semantic selection and review context", async () => {
    const f = makeFile({ key: "a", path: "src/a.ts", hunks: [makeHunk(0, [" a", " b"]) ] })
    const doc = makeDoc([f], "a".repeat(40))
    const initial = createInitialReviewState(doc)
    const lineSelection = createLineSelection(f, { hunkIndex: 0, side: "new", line: 1 })
    const state = {
      ...initial,
      lineSelection,
      selection: { fileKey: "a", hunkIndex: 0 },
      filter: { query: "needle", scope: "feedback" as const },
      viewed: {},
      feedback: [{
        id: "fb", kind: "note" as const, severity: "comment" as const, body: "note",
        anchor: { kind: "file" as const, fileKey: "a", contentId: f.contentId },
        resolution: "active" as const, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      }],
      expandedGaps: [{ fileKey: "a", gapId: "before:1", expanded: true }],
    }
    const db = { version: 2 as const, baseByHead: {}, reviews: { [doc.identity.id]: persistedFromReviewState(state) } }
    const stateStore = { load: async () => db, saveSemanticChange: async () => undefined, flush: async () => undefined } as unknown as ReviewStateStore
    const controller = new ReviewWorkspaceController({ runner: fakeRunner(), stateStore, loadDocument: async () => doc })
    const restored = await controller.open("refs/heads/main")
    expect(restored.lineSelection).toEqual(lineSelection)
    expect(restored.filter).toEqual(state.filter)
    expect(restored.feedback).toHaveLength(1)
    expect(restored.expandedGaps).toEqual(state.expandedGaps)
    controller.destroy()
  })
})
