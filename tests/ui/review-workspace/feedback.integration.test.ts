import { describe, expect, test } from "bun:test"
import { ReviewWorkspaceController } from "../../../src/ui/review-workspace/controller"
import { FeedbackPane } from "../../../src/ui/review-workspace/feedback-pane"
import { FeedbackComposer } from "../../../src/ui/review-workspace/feedback-composer"
import { createReviewDocument, createReviewHunk } from "../../../src/review/core/document"
import { createReviewIdentity, createReviewGeneration } from "../../../src/review/core/identity"
import { createRangeAnchor, createFileAnchor } from "../../../src/review/core/anchors"
import { reduceReviewState } from "../../../src/review/core/reducer"
import { planReviewIntent } from "../../../src/review/core/intents"
import type { GitRunner } from "../../../src/git/runner"
import type { ReviewFile } from "../../../src/review/core/types"

function fakeRunner(): GitRunner {
  return { run: async () => ({ stdout: "", stderr: "", exitCode: 0 }) } as unknown as GitRunner
}

function makeHunk(index: number, lines: string[]) {
  return createReviewHunk({ index, oldStart: 1, oldCount: lines.length, newStart: 1, newCount: lines.length, lines })
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

function makeDoc(files: ReviewFile[]) {
  const identity = createReviewIdentity({ headRef: "refs/heads/feature", headOid: "a".repeat(40), baseRef: "refs/heads/main" })
  const generation = createReviewGeneration({ baseOid: "b".repeat(40), mergeBaseOid: "c".repeat(40), headOid: "a".repeat(40) })
  return createReviewDocument({ identity, generation, commits: [{ oid: "a".repeat(40), parents: [], author: "A", timestamp: 0, subject: "s", body: "" }], files })
}

describe("feedback view — filter/re-anchor, active/stale/orphaned, binary restriction", () => {
  test("feedback view groups active, stale, orphaned in document order", async () => {
    const h1 = makeHunk(0, [" a"])
    const h2 = makeHunk(0, [" b"])
    const h3 = makeHunk(0, [" c"])
    const fileA = makeFile({ key: "a", path: "src/a.ts", hunks: [h1] as unknown as ReviewFile["hunks"] })
    const fileB = makeFile({ key: "b", path: "src/b.ts", hunks: [h2] as unknown as ReviewFile["hunks"] })
    const fileC = makeFile({ key: "c", path: "src/c.ts", hunks: [h3] as unknown as ReviewFile["hunks"] })
    const doc = makeDoc([fileA, fileB, fileC])
    const controller = new ReviewWorkspaceController({ runner: fakeRunner(), loadDocument: async () => doc })
    await controller.open("refs/heads/main")
    // Create 3 feedback items in non-document order, then check grouping and sorting
    const anchorC = createRangeAnchor(fileC, { side: "new", startLine: 1, endLine: 1 })
    const anchorA = createRangeAnchor(fileA, { side: "new", startLine: 1, endLine: 1 })
    const anchorB = createRangeAnchor(fileB, { side: "new", startLine: 1, endLine: 1 })
    let state = controller.state!
    state = reduceReviewState(state, planReviewIntent(state, { type: "feedback/start-draft", anchor: anchorC, kind: "note", severity: "comment", body: "c note" }))
    state = reduceReviewState(state, planReviewIntent(state, { type: "feedback/create", id: "c1", createdAt: "2026-08-28T00:00:00.000Z" }))
    controller.dispatch({ type: "feedback/create", feedback: state.feedback.find(f => f.id === "c1")! } as unknown as never)
    // Instead use controller's state directly via dispatch; easier: use controller.dispatch with intents via plan
    // Reset and create via controller intents
    const ctrl2 = new ReviewWorkspaceController({ runner: fakeRunner(), loadDocument: async () => doc })
    await ctrl2.open("refs/heads/main")
    // create via composer for simplicity
    const composer = new FeedbackComposer({ controller: ctrl2 })
    composer.open(anchorC, "note", "comment", "c note")
    // override random id
    const c1State = ctrl2.state!
    const createA = planReviewIntent(c1State, { type: "feedback/create", id: "c1", createdAt: "2026-08-28T00:00:00.000Z" })
    ctrl2.dispatch(createA)
    const s2 = planReviewIntent(ctrl2.state!, { type: "feedback/start-draft", anchor: anchorA, kind: "note", severity: "comment", body: "a note" })
    ctrl2.dispatch(s2)
    const createA2 = planReviewIntent(ctrl2.state!, { type: "feedback/create", id: "a1", createdAt: "2026-08-28T00:01:00.000Z" })
    ctrl2.dispatch(createA2)
    const s3 = planReviewIntent(ctrl2.state!, { type: "feedback/start-draft", anchor: anchorB, kind: "note", severity: "comment", body: "b note" })
    ctrl2.dispatch(s3)
    const createB = planReviewIntent(ctrl2.state!, { type: "feedback/create", id: "b1", createdAt: "2026-08-28T00:02:00.000Z" })
    ctrl2.dispatch(createB)

    const pane = new FeedbackPane({ controller: ctrl2 })
    const grouped = pane.getGrouped()
    // All should be active initially
    expect(grouped.active.length).toBe(3)
    // Sorted document order: a, b, c
    expect(grouped.active.map(f => f.id)).toEqual(["a1", "b1", "c1"])

    // Manually mark one as stale and one as orphaned to test grouping
    const cur = ctrl2.state!
    const stale = { ...cur.feedback.find(f => f.id === "b1")!, resolution: "stale" as const }
    const orphaned = { ...cur.feedback.find(f => f.id === "c1")!, resolution: "orphaned" as const }
    const active = cur.feedback.find(f => f.id === "a1")!
    // Directly mutate via reducer? For test, we simulate reconciliation by directly setting feedback
    const nextState = { ...cur, feedback: [active, stale, orphaned] } as unknown as typeof cur
    // Inject via dispatch that sets feedback? Simplest: bypass and set private _state
    ;(ctrl2 as unknown as { _state: typeof cur })._state = nextState

    const grouped2 = pane.getGrouped()
    expect(grouped2.active.map(f => f.id)).toEqual(["a1"])
    expect(grouped2.stale.map(f => f.id)).toEqual(["b1"])
    expect(grouped2.orphaned.map(f => f.id)).toEqual(["c1"])
    // Labels
    expect(pane.getFeedbackLabel(active)).toBe("active")
    expect(pane.getFeedbackLabel(stale)).toBe("stale")
    expect(pane.getFeedbackLabel(orphaned)).toBe("orphaned")
  })

  test("selecting an active item reveals its anchor (document order navigation)", async () => {
    const h = makeHunk(0, [" a", " b"])
    const file = makeFile({ key: "a", path: "src/a.ts", hunks: [h] as unknown as ReviewFile["hunks"] })
    const file2 = makeFile({ key: "b", path: "src/b.ts", hunks: [makeHunk(0, [" x"])] as unknown as ReviewFile["hunks"] })
    const doc = makeDoc([file, file2])
    const controller = new ReviewWorkspaceController({ runner: fakeRunner(), loadDocument: async () => doc })
    await controller.open("refs/heads/main")
    const composer = new FeedbackComposer({ controller })
    const anchor = createRangeAnchor(file2, { side: "new", startLine: 1, endLine: 1 })
    composer.open(anchor, "note", "comment", "note on b")
    const stateBefore = controller.state!
    const create = planReviewIntent(stateBefore, { type: "feedback/create", id: "fb1", createdAt: "2026-08-28T00:00:00.000Z" })
    controller.dispatch(create)
    expect(controller.state?.selection.fileKey).not.toBe("b") // initially a
    const pane = new FeedbackPane({ controller })
    const ok = pane.selectFeedback("fb1")
    expect(ok).toBe(true)
    expect(controller.state?.selection.fileKey).toBe("b")
    // stale selection should not reveal
    const cur = controller.state!
    const staleFb = { ...cur.feedback[0]!, resolution: "stale" as const }
    ;(controller as unknown as { _state: typeof cur })._state = { ...cur, feedback: [staleFb] } as unknown as typeof cur
    expect(pane.selectFeedback("fb1")).toBe(false)
  })

  test("re-anchor enters range selection and dispatches validated feedback/reanchor intent", async () => {
    const h1 = makeHunk(0, [" a", " b"])
    const h2 = makeHunk(0, [" c", " d"])
    const fileA = makeFile({ key: "a", path: "src/a.ts", hunks: [h1] as unknown as ReviewFile["hunks"] })
    const fileB = makeFile({ key: "b", path: "src/b.ts", hunks: [h2] as unknown as ReviewFile["hunks"] })
    const doc = makeDoc([fileA, fileB])
    const controller = new ReviewWorkspaceController({ runner: fakeRunner(), loadDocument: async () => doc })
    await controller.open("refs/heads/main")
    const composer = new FeedbackComposer({ controller })
    const anchor = createRangeAnchor(fileA, { side: "new", startLine: 1, endLine: 1 })
    composer.open(anchor, "note", "comment", "orig")
    const create = planReviewIntent(controller.state!, { type: "feedback/create", id: "fb1", createdAt: "2026-08-28T00:00:00.000Z" })
    controller.dispatch(create)
    const pane = new FeedbackPane({ controller })
    expect(pane.beginReanchor("fb1")).toBe(true)
    expect(pane.isReanchoring()).toBe(true)
    const newAnchor = createRangeAnchor(fileB, { side: "new", startLine: 1, endLine: 1 })
    const ok = pane.confirmReanchor("fb1", newAnchor)
    expect(ok).toBe(true)
    expect(controller.state?.feedback[0]?.anchor.fileKey).toBe("b")
    expect(controller.state?.feedback[0]?.resolution).toBe("active")
    expect(pane.isReanchoring()).toBe(false)
    // Invalid reanchor (binary) should be rejected
    const binFile = makeFile({ key: "bin", path: "img.png", kind: "binary" as const, source: "binary" as const, hunks: [] as unknown as ReviewFile["hunks"], contentId: "content-bin" })
    const doc2 = makeDoc([binFile, fileA])
    const ctrl2 = new ReviewWorkspaceController({ runner: fakeRunner(), loadDocument: async () => doc2 })
    await ctrl2.open("refs/heads/main")
    const composer2 = new FeedbackComposer({ controller: ctrl2 })
    composer2.open(createFileAnchor(binFile), "note", "comment", "bin note")
    const cr2 = planReviewIntent(ctrl2.state!, { type: "feedback/create", id: "fb2", createdAt: "2026-08-28T00:00:00.000Z" })
    ctrl2.dispatch(cr2)
    const pane2 = new FeedbackPane({ controller: ctrl2 })
    pane2.beginReanchor("fb2")
    const badAnchor = { kind: "range" as const, fileKey: "bin", contentId: "content-bin", side: "new" as const, startLine: 1, endLine: 1, ownerHunkIndex: 0, contextDigest: "d" }
    expect(pane2.confirmReanchor("fb2", badAnchor)).toBe(false)
  })

  test("edit/delete, with confirmation for non-empty item", async () => {
    const h = makeHunk(0, [" a"])
    const file = makeFile({ key: "a", path: "src/a.ts", hunks: [h] as unknown as ReviewFile["hunks"] })
    const doc = makeDoc([file])
    const controller = new ReviewWorkspaceController({ runner: fakeRunner(), loadDocument: async () => doc })
    await controller.open("refs/heads/main")
    const composer = new FeedbackComposer({ controller })
    composer.open(createFileAnchor(file), "note", "comment", "orig")
    const create = planReviewIntent(controller.state!, { type: "feedback/create", id: "fb1", createdAt: "2026-08-28T00:00:00.000Z" })
    controller.dispatch(create)
    const pane = new FeedbackPane({ controller })
    // edit
    expect(pane.editFeedback("fb1", { body: "edited" })).toBe(true)
    expect(controller.state?.feedback[0]?.body).toBe("edited")
    // delete with confirmation needed for non-empty
    const req = pane.requestDelete("fb1")
    expect(req.needsConfirm).toBe(true)
    expect(pane.getPendingDeleteId()).toBe("fb1")
    // confirm
    expect(pane.confirmDelete("fb1")).toBe(true)
    expect(controller.state?.feedback.length).toBe(0)
    // empty body delete no confirm
    composer.open(createFileAnchor(file), "note", "comment", "")
    // But note body cannot be empty per validation; we need to bypass? For test, create empty via direct dispatch with empty body? That would be invalid, so we test via direct feedback with empty replacement?
    // Instead create via direct feedback injection for empty case
    const emptyFb = { id: "empty", kind: "note" as const, severity: "comment" as const, body: "", anchor: createFileAnchor(file), resolution: "active" as const, createdAt: "2026-08-28T00:00:00.000Z", updatedAt: "2026-08-28T00:00:00.000Z" }
    // Inject
    const cur = controller.state!
    ;(controller as unknown as { _state: typeof cur })._state = { ...cur, feedback: [emptyFb] } as unknown as typeof cur
    const req2 = pane.requestDelete("empty")
    expect(req2.needsConfirm).toBe(false)
    expect(req2.canDelete).toBe(true)
  })

  test("next/previous feedback labels in document order and keyboard/mouse parity", async () => {
    const h = makeHunk(0, [" a"])
    const fileA = makeFile({ key: "a", path: "src/a.ts", hunks: [h] as unknown as ReviewFile["hunks"] })
    const fileB = makeFile({ key: "b", path: "src/b.ts", hunks: [makeHunk(0, [" b"])] as unknown as ReviewFile["hunks"] })
    const doc = makeDoc([fileA, fileB])
    const controller = new ReviewWorkspaceController({ runner: fakeRunner(), loadDocument: async () => doc })
    await controller.open("refs/heads/main")
    for (const [id, file] of [["a1", fileA], ["b1", fileB]] as const) {
      const anchor = createRangeAnchor(file, { side: "new", startLine: 1, endLine: 1 })
      const start = planReviewIntent(controller.state!, { type: "feedback/start-draft", anchor, kind: "note", severity: "comment", body: id })
      controller.dispatch(start)
      const create = planReviewIntent(controller.state!, { type: "feedback/create", id, createdAt: "2026-08-28T00:00:00.000Z" })
      controller.dispatch(create)
    }
    const pane = new FeedbackPane({ controller })
    expect(pane.getNextLabel("a1")).toContain("b")
    expect(pane.getPreviousLabel("b1")).toContain("a")
    // Navigation via pane
    const before = controller.state?.selection.fileKey
    pane.goNext()
    const afterNext = controller.state?.selection.fileKey
    expect(afterNext).not.toBe(before)
    pane.goPrevious()
    const afterPrev = controller.state?.selection.fileKey
    expect(afterPrev).toBe(before)
    // Mouse parity: clickFeedback same as selectFeedback
    expect(pane.clickFeedback("a1")).toBe(pane.selectFeedback("a1"))
    expect(pane.clickReanchor("a1")).toBe(pane.beginReanchor("a1"))
    pane.cancelReanchor()
  })

  test("binary file-level restriction: suggestions blocked at file level, only file anchors allowed", async () => {
    const bin = makeFile({ key: "bin", path: "image.png", kind: "binary" as const, source: "binary" as const, hunks: [] as unknown as ReviewFile["hunks"], contentId: "content-bin" })
    const normal = makeFile({ key: "a", path: "src/a.ts", hunks: [makeHunk(0, [" a"])] as unknown as ReviewFile["hunks"] })
    const doc = makeDoc([bin, normal])
    const controller = new ReviewWorkspaceController({ runner: fakeRunner(), loadDocument: async () => doc })
    await controller.open("refs/heads/main")
    const pane = new FeedbackPane({ controller })
    // Try to create suggestion on binary via pane edit? Use composer for creation check
    const composer = new FeedbackComposer({ controller })
    const binAnchor = createFileAnchor(bin)
    expect(composer.open(binAnchor, "suggestion", "comment", "x", "rep")).toBe(false)
    // File note allowed
    expect(composer.open(binAnchor, "note", "comment", "bin note")).toBe(true)
    composer.cancel()
    // Range on binary should fail at anchor validation
    const fakeRange = { kind: "range" as const, fileKey: "bin", contentId: "content-bin", side: "new" as const, startLine: 1, endLine: 1, ownerHunkIndex: 0, contextDigest: "d" }
    expect(composer.open(fakeRange, "note", "comment", "x")).toBe(false)
    // Ensure pane's reanchor also enforces binary restriction (tested above)
  })

  test("active/stale/orphaned labels are visible and correctly assigned", async () => {
    const h = makeHunk(0, [" a"])
    const file = makeFile({ key: "a", path: "src/a.ts", hunks: [h] as unknown as ReviewFile["hunks"] })
    const doc = makeDoc([file])
    const controller = new ReviewWorkspaceController({ runner: fakeRunner(), loadDocument: async () => doc })
    await controller.open("refs/heads/main")
    const composer = new FeedbackComposer({ controller })
    composer.open(createFileAnchor(file), "note", "comment", "note")
    const create = planReviewIntent(controller.state!, { type: "feedback/create", id: "fb1", createdAt: "2026-08-28T00:00:00.000Z" })
    controller.dispatch(create)
    const pane = new FeedbackPane({ controller })
    const fb = controller.state!.feedback[0]!
    expect(pane.getFeedbackLabel(fb)).toBe("active")
    // Simulate stale via direct mutation
    const stale = { ...fb, resolution: "stale" as const }
    const cur = controller.state!
    ;(controller as unknown as { _state: typeof cur })._state = { ...cur, feedback: [stale] } as unknown as typeof cur
    expect(pane.getFeedbackLabel(pane.getSorted()[0]!)).toBe("stale")
    const orphaned = { ...fb, resolution: "orphaned" as const }
    ;(controller as unknown as { _state: typeof cur })._state = { ...cur, feedback: [orphaned] } as unknown as typeof cur
    expect(pane.getFeedbackLabel(pane.getSorted()[0]!)).toBe("orphaned")
  })
})
