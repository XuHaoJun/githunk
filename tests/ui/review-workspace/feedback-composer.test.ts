import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import { ReviewWorkspaceController } from "../../../src/ui/review-workspace/controller"
import { FeedbackComposer } from "../../../src/ui/review-workspace/feedback-composer"
import { createReviewDocument, createReviewHunk } from "../../../src/review/core/document"
import { createReviewIdentity, createReviewGeneration } from "../../../src/review/core/identity"
import { createRangeAnchor, createFileAnchor } from "../../../src/review/core/anchors"
import type { GitRunner } from "../../../src/git/runner"
import type { ReviewFile } from "../../../src/review/core/types"
import { createTempRepository, type TempRepository } from "../../helpers/temp-repository"
import { GitRunner as RealRunner } from "../../../src/git/runner"
import { ReviewStateStore } from "../../../src/review/storage/review-state-store"

function fakeRunner(): GitRunner {
  return { run: async () => ({ stdout: "", stderr: "", exitCode: 0 }) } as unknown as GitRunner
}

function makeHunk(index: number, oldStart: number, newStart: number, lines: string[]) {
  return createReviewHunk({ index, oldStart, oldCount: lines.length, newStart, newCount: lines.length, lines })
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

describe("feedback-composer — focus/draft lifecycle with suggestion/blocking", () => {
  test("c opens composer for current file (file anchor) via openForCurrentSelection", async () => {
    const h = makeHunk(0, 1, 1, [" a"])
    const file = makeFile({ key: "a", path: "src/a.ts", hunks: [h] as unknown as ReviewFile["hunks"] })
    const doc = makeDoc([file])
    const controller = new ReviewWorkspaceController({ runner: fakeRunner(), loadDocument: async () => doc })
    await controller.open("refs/heads/main")
    const composer = new FeedbackComposer({ controller })
    expect(composer.isOpen()).toBe(false)
    const opened = composer.openForCurrentSelection()
    expect(opened).toBe(true)
    expect(composer.isOpen()).toBe(true)
    const draft = composer.getDraft()
    expect(draft?.anchor.kind).toBe("file")
    expect(draft?.anchor.fileKey).toBe("a")
  })

  test("c with active range opens range note (active semantic range)", async () => {
    const h = makeHunk(0, 1, 1, [" a", " b", " c"])
    const file = makeFile({ key: "a", path: "src/a.ts", hunks: [h] as unknown as ReviewFile["hunks"] })
    const doc = makeDoc([file])
    const controller = new ReviewWorkspaceController({ runner: fakeRunner(), loadDocument: async () => doc })
    await controller.open("refs/heads/main")
    const composer = new FeedbackComposer({ controller })
    const range = createRangeAnchor(file, { side: "new", startLine: 1, endLine: 2 })
    const opened = composer.openForCurrentSelection({ rangeAnchor: range })
    expect(opened).toBe(true)
    expect(composer.getDraft()?.anchor.kind).toBe("range")
    expect((composer.getDraft()?.anchor as { startLine: number }).startLine).toBe(1)
  })

  test("new-side suggestion exposes replacement, old-side blocked, file suggestion blocked", async () => {
    const h = makeHunk(0, 1, 1, [" a", " b"])
    const file = makeFile({ key: "a", path: "src/a.ts", hunks: [h] as unknown as ReviewFile["hunks"] })
    const doc = makeDoc([file])
    const controller = new ReviewWorkspaceController({ runner: fakeRunner(), loadDocument: async () => doc })
    await controller.open("refs/heads/main")
    const composer = new FeedbackComposer({ controller })
    const newRange = createRangeAnchor(file, { side: "new", startLine: 1, endLine: 1 })
    const oldRange = createRangeAnchor(file, { side: "old", startLine: 1, endLine: 1 })
    const fileAnchor = createFileAnchor(file)

    // new-side suggestion ok
    expect(composer.open(newRange, "suggestion", "comment", "fix", "replacement text")).toBe(true)
    expect(composer.canShowReplacement()).toBe(true)
    // cleanup
    composer.cancel()
    expect(composer.isOpen()).toBe(false)

    // old-side suggestion blocked
    expect(composer.open(oldRange, "suggestion", "comment", "fix", "rep")).toBe(false)
    expect(composer.isOpen()).toBe(false)

    // file suggestion blocked
    expect(composer.open(fileAnchor, "suggestion", "comment", "fix", "rep")).toBe(false)

    // note with file anchor ok
    expect(composer.open(fileAnchor, "note", "comment", "note body")).toBe(true)
    expect(composer.canShowReplacement()).toBe(false)
  })

  test("replacement editor only for new-side range suggestion; comment/blocking severity toggles", async () => {
    const h = makeHunk(0, 1, 1, [" a"])
    const file = makeFile({ key: "a", path: "src/a.ts", hunks: [h] as unknown as ReviewFile["hunks"] })
    const doc = makeDoc([file])
    const controller = new ReviewWorkspaceController({ runner: fakeRunner(), loadDocument: async () => doc })
    await controller.open("refs/heads/main")
    const composer = new FeedbackComposer({ controller })
    const range = createRangeAnchor(file, { side: "new", startLine: 1, endLine: 1 })
    composer.open(range, "note", "comment", "body")
    expect(composer.canShowReplacement()).toBe(false)
    // switching to suggestion should succeed because anchor is new-side range
    expect(composer.setKind("suggestion")).toBe(true)
    expect(composer.canShowReplacement()).toBe(true)
    expect(composer.setReplacement("new code")).toBe(true)
    expect(composer.getDraft()?.replacement).toBe("new code")
    // severity toggles
    expect(composer.setSeverity("blocking")).toBe(true)
    expect(composer.getDraft()?.severity).toBe("blocking")
    expect(composer.setSeverity("comment")).toBe(true)
    expect(composer.getDraft()?.severity).toBe("comment")
    // switching back to note should hide replacement
    expect(composer.setKind("note")).toBe(true)
    expect(composer.canShowReplacement()).toBe(false)
  })

  test("Ctrl+S creates pending feedback and Escape cancels (keyboard parity with mouse click)", async () => {
    const h = makeHunk(0, 1, 1, [" a"])
    const file = makeFile({ key: "a", path: "src/a.ts", hunks: [h] as unknown as ReviewFile["hunks"] })
    const doc = makeDoc([file])
    const controller = new ReviewWorkspaceController({ runner: fakeRunner(), loadDocument: async () => doc, now: () => "2026-08-28T00:00:00.000Z", randomId: () => "fb-1" })
    await controller.open("refs/heads/main")
    const composer = new FeedbackComposer({ controller })
    const anchor = createFileAnchor(file)
    composer.open(anchor, "note", "comment", "my note")
    expect(controller.state?.draft?.body).toBe("my note")
    // Ctrl+S via handleKey
    expect(composer.handleKey("ctrl+s")).toBe(true)
    // After save, draft cleared and feedback created
    expect(composer.isOpen()).toBe(false)
    expect(controller.state?.feedback.length).toBe(1)
    expect(controller.state?.feedback[0]?.body).toBe("my note")
    expect(controller.state?.feedback[0]?.id).toBe("fb-1")

    // keyboard parity: clickSave should also work for next feedback
    const anchor2 = createRangeAnchor(file, { side: "new", startLine: 1, endLine: 1 })
    const ctrl2 = new ReviewWorkspaceController({ runner: fakeRunner(), loadDocument: async () => doc, now: () => "2026-08-28T01:00:00.000Z", randomId: () => "fb-2" })
    await ctrl2.open("refs/heads/main")
    const composer2 = new FeedbackComposer({ controller: ctrl2 })
    composer2.open(anchor2, "note", "comment", "second")
    expect(composer2.clickSave()).toBe(true)
    expect(ctrl2.state?.feedback.length).toBe(1)
    expect(ctrl2.state?.feedback[0]?.id).toBe("fb-2")

    // Escape cancel
    const ctrl3 = new ReviewWorkspaceController({ runner: fakeRunner(), loadDocument: async () => doc })
    await ctrl3.open("refs/heads/main")
    const composer3 = new FeedbackComposer({ controller: ctrl3 })
    composer3.open(anchor, "note", "comment", "draft to cancel")
    expect(composer3.isOpen()).toBe(true)
    expect(composer3.handleKey("escape")).toBe(true)
    expect(composer3.isOpen()).toBe(false)
    expect(ctrl3.state?.feedback.length).toBe(0)
    // mouse parity: clickCancel
    composer3.open(anchor, "note", "comment", "again")
    expect(composer3.clickCancel()).toBe(true)
    expect(composer3.isOpen()).toBe(false)
  })

  test("tab stays inside composer controls until close", async () => {
    const h = makeHunk(0, 1, 1, [" a"])
    const file = makeFile({ key: "a", path: "src/a.ts", hunks: [h] as unknown as ReviewFile["hunks"] })
    const doc = makeDoc([file])
    const controller = new ReviewWorkspaceController({ runner: fakeRunner(), loadDocument: async () => doc })
    await controller.open("refs/heads/main")
    const composer = new FeedbackComposer({ controller })
    const anchor = createFileAnchor(file)
    composer.open(anchor, "note", "comment", "x")
    const initial = composer.getFocus()
    expect(["kind", "severity", "body", "save", "cancel"]).toContain(initial)
    // Tab should cycle within relevant controls, not leave composer
    const controls = composer.getRelevantControls()
    for (let i = 0; i < controls.length * 2; i++) {
      composer.handleKey("tab")
      const focus = composer.getFocus()
      expect(controls).toContain(focus)
    }
    // After cancel, tab no longer trapped (composer closed) — handleKey returns false
    composer.cancel()
    expect(composer.handleKey("tab")).toBe(false)
  })

  test("binary file-level restriction: only file-level notes, no suggestions, range blocked", async () => {
    const binFile = makeFile({ key: "bin", path: "image.png", kind: "binary" as const, source: "binary" as const, hunks: [] as unknown as ReviewFile["hunks"], contentId: "content-bin" })
    const doc = makeDoc([binFile])
    const controller = new ReviewWorkspaceController({ runner: fakeRunner(), loadDocument: async () => doc })
    await controller.open("refs/heads/main")
    const composer = new FeedbackComposer({ controller })
    const fileAnchor = createFileAnchor(binFile)
    // file note allowed
    expect(composer.open(fileAnchor, "note", "comment", "binary note")).toBe(true)
    expect(composer.getDraft()?.kind).toBe("note")
    composer.cancel()
    // suggestion blocked even with file anchor
    expect(composer.open(fileAnchor, "suggestion", "comment", "x", "rep")).toBe(false)
    // range anchor blocked
    const fakeRange = { kind: "range" as const, fileKey: "bin", contentId: "content-bin", side: "new" as const, startLine: 1, endLine: 1, ownerHunkIndex: 0, contextDigest: "d" }
    expect(composer.open(fakeRange, "note", "comment", "x")).toBe(false)
    // setKind to suggestion should fail for binary draft
    composer.open(fileAnchor, "note", "comment", "x")
    expect(composer.setKind("suggestion")).toBe(false)
  })

  test("draft debounce and flush: setBody triggers debounced save, flush persists", async () => {
    let repo: TempRepository | undefined
    try {
      repo = await createTempRepository()
      const runner = new RealRunner(repo.path)
      const store = new ReviewStateStore(runner)
      const h = makeHunk(0, 1, 1, [" a"])
      const file = makeFile({ key: "a", path: "src/a.ts", hunks: [h] as unknown as ReviewFile["hunks"] })
      const doc = makeDoc([file])
      const controller = new ReviewWorkspaceController({ runner, stateStore: store, loadDocument: async () => doc })
      await controller.open("refs/heads/main")
      const composer = new FeedbackComposer({ controller })
      const anchor = createFileAnchor(file)
      composer.open(anchor, "note", "comment", "initial")
      // Update body triggers debounced save (500ms)
      composer.setBody("updated body")
      expect(controller.state?.draft?.body).toBe("updated body")
      // Before flush, store may not have persisted yet due to debounce
      const beforeFlush = await store.load()
      // The draft pending is debounced, so before flush the persisted draft may still be old or null
      // But after flush, it should be persisted
      await composer.flush()
      const afterFlush = await store.load()
      const reviewId = doc.identity.id
      expect(afterFlush.reviews[reviewId]?.draft?.body).toBe("updated body")
      // Cancel should also flush and clear pending
      composer.cancel()
      await composer.flush()
      const afterCancel = await store.load()
      expect(afterCancel.reviews[reviewId]?.draft).toBeNull()
    } finally {
      await repo?.cleanup()
    }
  })

  test("suggestion requires non-empty replacement on save", async () => {
    const h = makeHunk(0, 1, 1, [" a", " b"])
    const file = makeFile({ key: "a", path: "src/a.ts", hunks: [h] as unknown as ReviewFile["hunks"] })
    const doc = makeDoc([file])
    const controller = new ReviewWorkspaceController({ runner: fakeRunner(), loadDocument: async () => doc, now: () => "2026-08-28T00:00:00.000Z", randomId: () => "s1" })
    await controller.open("refs/heads/main")
    const composer = new FeedbackComposer({ controller })
    const range = createRangeAnchor(file, { side: "new", startLine: 1, endLine: 1 })
    composer.open(range, "suggestion", "comment", "fix", "initial")
    composer.setReplacement("")
    const saved = composer.save()
    expect(saved).toBe(false)
    expect(controller.state?.feedback.length).toBe(0)
    expect(composer.isOpen()).toBe(true)
    composer.setReplacement("valid replacement")
    expect(composer.save()).toBe(true)
    expect(controller.state?.feedback.length).toBe(1)
  })
})
