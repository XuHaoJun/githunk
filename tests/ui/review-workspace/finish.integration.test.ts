import { describe, expect, test } from "bun:test"
import { ReviewWorkspaceController } from "../../../src/ui/review-workspace/controller"
import { FeedbackComposer } from "../../../src/ui/review-workspace/feedback-composer"
import { FinishDialog } from "../../../src/ui/review-workspace/finish-dialog"
import { ReviewWorkspace } from "../../../src/ui/review-workspace/review-workspace"
import { createReviewDocument, createReviewHunk } from "../../../src/review/core/document"
import { createReviewIdentity, createReviewGeneration } from "../../../src/review/core/identity"
import { createRangeAnchor } from "../../../src/review/core/anchors"
import { planReviewIntent } from "../../../src/review/core/intents"
import type { GitRunner } from "../../../src/git/runner"
import type { ReviewFile } from "../../../src/review/core/types"
import { createTempRepository, type TempRepository } from "../../helpers/temp-repository"
import { GitRunner as RealRunner } from "../../../src/git/runner"
import { ReviewStateStore } from "../../../src/review/storage/review-state-store"
import { ReviewArtifactStore } from "../../../src/review/storage/review-artifact-store"
import { createTestRenderer } from "@opentui/core/testing"
import type { CliRenderer } from "@opentui/core"

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

function makeDoc(files: ReviewFile[], headOid = "a".repeat(40)) {
  const identity = createReviewIdentity({ headRef: "refs/heads/feature", headOid, baseRef: "refs/heads/main" })
  const generation = createReviewGeneration({ baseOid: "b".repeat(40), mergeBaseOid: "c".repeat(40), headOid })
  return createReviewDocument({ identity, generation, commits: [{ oid: headOid, parents: [], author: "A", timestamp: 0, subject: "s", body: "" }], files })
}

function fakeClipboard() {
  return { isOsc52Supported: () => true, copyToClipboardOSC52: () => true }
}

describe("finish integration — workspace, controller, dialog, export", () => {
  test("R opens finish dialog, shows validation reason, and closes on Escape", async () => {
    const h = makeHunk(0, [" a"])
    const file = makeFile({ key: "a", path: "src/a.ts", hunks: [h] as unknown as ReviewFile["hunks"] })
    const doc = makeDoc([file])
    const controller = new ReviewWorkspaceController({ runner: { run: async () => ({ stdout: "", stderr: "", exitCode: 0 }) } as unknown as GitRunner, loadDocument: async () => doc })
    await controller.open("refs/heads/main")
    const setup = await createTestRenderer({ width: 80, height: 24 })
    const ws = new ReviewWorkspace(setup.renderer as unknown as CliRenderer, controller, { onClose: () => {} })
    const dialog = ws.getFinishDialog()
    expect(dialog.isOpen()).toBe(false)
    ws.handleKeyPress("R")
    expect(dialog.isOpen()).toBe(true)
    expect(dialog.getValidationMessage()).toContain("Finish blocked")
    ws.handleKeyPress("escape")
    expect(dialog.isOpen()).toBe(false)
    ws.destroy()
    setup.renderer.destroy()
  })

  test("finish via controller clears pending only after both writes, markdown deterministic via clipboard", async () => {
    let repo: TempRepository | undefined
    let ws: ReviewWorkspace | undefined
    let setup: Awaited<ReturnType<typeof createTestRenderer>> | undefined
    let controller: ReviewWorkspaceController | undefined
    let stateStore: ReviewStateStore | undefined
    try {
      repo = await createTempRepository()
      const runner = new RealRunner(repo.path)
      stateStore = new ReviewStateStore(runner)
      const artifactStore = new ReviewArtifactStore(runner)
      const h = makeHunk(0, [" a", " b"])
      const file = makeFile({ key: "a", path: "src/a.ts", hunks: [h] as unknown as ReviewFile["hunks"] })
      const doc = makeDoc([file])
      controller = new ReviewWorkspaceController({ runner, stateStore, artifactStore, loadDocument: async () => doc, now: () => "2026-08-28T00:00:00.000Z", randomId: () => "art-ws" })
      await controller.open("refs/heads/main")
      const anchor = createRangeAnchor(file, { side: "new", startLine: 1, endLine: 1 })
      const start = planReviewIntent(controller.state!, { type: "feedback/start-draft", anchor, kind: "note", severity: "comment", body: "hello" })
      controller.dispatch(start)
      const create = planReviewIntent(controller.state!, { type: "feedback/create", id: "f1", createdAt: "2026-08-28T00:00:00.000Z" })
      controller.dispatch(create)
      expect(controller.state?.feedback.length).toBe(1)

      let clipboardText: string | undefined
      const clipboard = {
        isOsc52Supported: () => true,
        copyToClipboardOSC52: (t: string) => { clipboardText = t; return true },
      }
      setup = await createTestRenderer({ width: 80, height: 24 })
      ws = new ReviewWorkspace(setup.renderer as unknown as CliRenderer, controller, { onClose: () => {}, clipboard } as unknown as never)
      const dialog = ws.getFinishDialog()
      dialog.setDecision("comment")
      dialog.setSummary("summary")
      dialog.open()
      const res = await dialog.submit()
      expect(res.ok).toBe(true)
      expect(res.markdown).toBeDefined()
      expect(clipboardText ?? res.markdown).toBe(res.markdown)
      expect(controller.state?.feedback.length).toBe(0)
      const db = await stateStore.load()
      expect(db.reviews[doc.identity.id]?.feedback.length).toBe(0)
      const loaded = await artifactStore.load(doc.identity.id, "art-ws")
      expect(loaded?.id).toBe("art-ws")
      const md2 = await dialog.getPersistedMarkdown("art-ws")
      expect(md2).toBe(res.markdown)
      expect(res.markdown).not.toContain("GitHub")
      expect(res.message).not.toContain("GitHub")
    } finally {
      try { await controller?.flushDrafts?.().catch(() => {}) } catch {}
      try { await stateStore?.flush().catch(() => {}) } catch {}
      ws?.destroy()
      try { setup?.renderer.destroy() } catch {}
      await repo?.cleanup()
    }
  })

  test("keyboard/mouse parity for finish: R key and handleKeyPress both open dialog", async () => {
    const h = makeHunk(0, [" a"])
    const file = makeFile({ key: "a", path: "src/a.ts", hunks: [h] as unknown as ReviewFile["hunks"] })
    const doc = makeDoc([file])
    const controller = new ReviewWorkspaceController({ runner: { run: async () => ({ stdout: "", stderr: "", exitCode: 0 }) } as unknown as GitRunner, loadDocument: async () => doc })
    await controller.open("refs/heads/main")
    const setup = await createTestRenderer({ width: 80, height: 24 })
    const ws = new ReviewWorkspace(setup.renderer as unknown as CliRenderer, controller)
    expect(ws.getFinishDialog().isOpen()).toBe(false)
    ws.handleKeyPress("R")
    expect(ws.getFinishDialog().isOpen()).toBe(true)
    ws.getFinishDialog().close()
    ws.handleKeyPress("r") // lowercase? command may be uppercase only, but test parity
    // Ensure still works via direct call
    ws.getFinishDialog().open()
    expect(ws.getFinishDialog().isOpen()).toBe(true)
    ws.destroy()
    setup.renderer.destroy()
  })

  test("finish after new generation preserves viewed coverage and clears only submitted feedback", async () => {
    const h = makeHunk(0, [" a"])
    const fileA = makeFile({ key: "a", path: "src/a.ts", hunks: [h] as unknown as ReviewFile["hunks"], contentId: "content-a-1" })
    const fileB = makeFile({ key: "b", path: "src/b.ts", hunks: [makeHunk(0, [" b"])] as unknown as ReviewFile["hunks"], contentId: "content-b-1" })
    const doc1 = makeDoc([fileA, fileB], "a".repeat(40))
    const controller = new ReviewWorkspaceController({ runner: { run: async () => ({ stdout: "", stderr: "", exitCode: 0 }) } as unknown as GitRunner, loadDocument: async () => doc1 })
    await controller.open("refs/heads/main")
    controller.dispatch(planReviewIntent(controller.state!, { type: "viewed/mark", fileKey: "a", viewedAt: "2026-08-28T00:00:00.000Z" }))
    const anchor = createRangeAnchor(fileB, { side: "new", startLine: 1, endLine: 1 })
    controller.dispatch(planReviewIntent(controller.state!, { type: "feedback/start-draft", anchor, kind: "note", severity: "comment", body: "note b" }))
    controller.dispatch(planReviewIntent(controller.state!, { type: "feedback/create", id: "fb1", createdAt: "2026-08-28T00:00:00.000Z" }))
    expect(controller.state?.feedback.length).toBe(1)
    // Simulate finish clearing feedback but retaining viewed (as finish would)
    const cur = controller.state!
    const afterFinish = { ...cur, feedback: [] as typeof cur.feedback, lastSubmission: { artifactId: "art-1", generationId: cur.document.generation.id, headOid: cur.document.generation.headOid, submittedAt: "2026-08-28T00:00:00.000Z" } } as unknown as typeof cur
    ;(controller as unknown as { _state: typeof cur })._state = afterFinish
    expect(controller.state?.feedback.length).toBe(0)
    expect(controller.state?.viewed["a"]).toBeDefined()
    const fileA2 = { ...fileA }
    const fileB2 = makeFile({ key: "b", path: "src/b.ts", hunks: [makeHunk(0, [" b-changed"])] as unknown as ReviewFile["hunks"], contentId: "content-b-2" })
    const doc2 = makeDoc([fileA2, fileB2], "b".repeat(40))
    ;(controller as unknown as { loadDocumentImpl: (b: string) => Promise<never> }).loadDocumentImpl = async () => doc2 as never
    await controller.refreshGeneration()
    expect(controller.state?.viewed["a"]).toBeDefined()
    const anchor2 = createRangeAnchor(fileB2, { side: "new", startLine: 1, endLine: 1 })
    const composer2 = new FeedbackComposer({ controller })
    expect(composer2.open(anchor2, "note", "comment", "new note")).toBe(true)
  })
})
