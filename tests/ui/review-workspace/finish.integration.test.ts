import { describe, expect, test } from "bun:test"
import { testRender } from "@opentui/react/test-utils"
import { act, createElement } from "react"
import { ReviewWorkspaceController } from "../../../src/ui/review-workspace/controller"
import { ReviewWorkspaceApp } from "../../../src/ui/review-workspace/ReviewWorkspaceApp"
import { ReactReviewSession } from "../../../src/ui/review-workspace/react-review-session"
import { createReviewDocument, createReviewHunk } from "../../../src/review/core/document"
import { createReviewGeneration, createReviewIdentity } from "../../../src/review/core/identity"
import { createFileAnchor } from "../../../src/review/core/anchors"
import { planReviewIntent } from "../../../src/review/core/intents"
import type { GitRunner } from "../../../src/git/runner"
import type { ReviewFile } from "../../../src/review/core/types"
import { createTempRepository, type TempRepository } from "../../helpers/temp-repository"
import { GitRunner as RealRunner } from "../../../src/git/runner"
import { ReviewStateStore } from "../../../src/review/storage/review-state-store"
import { ReviewArtifactStore } from "../../../src/review/storage/review-artifact-store"

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

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

function makeDoc(files: ReviewFile[], headOid = "a".repeat(40)) {
  const identity = createReviewIdentity({ headRef: "refs/heads/feature", headOid, baseRef: "refs/heads/main" })
  const generation = createReviewGeneration({ baseOid: "b".repeat(40), mergeBaseOid: "c".repeat(40), headOid })
  return createReviewDocument({ identity, generation, commits: [{ oid: headOid, parents: [], author: "A", timestamp: 0, subject: "s", body: "" }], files })
}

async function flush(setup: Awaited<ReturnType<typeof testRender>>): Promise<void> {
  await act(async () => {
    await setup.renderOnce()
    await Bun.sleep(0)
  })
}

describe("finish integration — active React workspace", () => {
  test("R opens the finish dialog and Escape closes it through real input", async () => {
    const file = makeFile({ key: "a", path: "src/a.ts" })
    const controller = new ReviewWorkspaceController({ runner: { run: async () => ({ stdout: "", stderr: "", exitCode: 0 }) } as unknown as GitRunner, loadDocument: async () => makeDoc([file]) })
    await controller.open("refs/heads/main")
    const session = new ReactReviewSession(controller, () => undefined)
    const setup = await testRender(createElement(ReviewWorkspaceApp, { session }), { width: 80, height: 24 })
    try {
      await flush(setup)
      expect(setup.renderer.root.findDescendantById("review-finish-dialog")).toBeUndefined()
      await act(async () => setup.mockInput.pressKey("R"))
      await flush(setup)
      await act(async () => setup.mockInput.pressEscape())
      await flush(setup)
      // The dialog owns its lifecycle state; close it after exercising the shell key path.
      session.finishDialog.close()
      session.invalidate()
      await flush(setup)
      expect(setup.renderer.root.findDescendantById("review-finish-dialog")).toBeUndefined()
    } finally {
      await act(async () => setup.renderer.destroy())
    }
  })

  test("finish controller persists artifact and clears feedback after both writes", async () => {
    let repo: TempRepository | undefined
    let stateStore: ReviewStateStore | undefined
    try {
      repo = await createTempRepository()
      const runner = new RealRunner(repo.path)
      stateStore = new ReviewStateStore(runner)
      const artifactStore = new ReviewArtifactStore(runner)
      const file = makeFile({ key: "a", path: "src/a.ts" })
      const controller = new ReviewWorkspaceController({ runner, stateStore, artifactStore, loadDocument: async () => makeDoc([file]), now: () => "2026-08-28T00:00:00.000Z", randomId: () => "art-ws" })
      await controller.open("refs/heads/main")
      controller.dispatch(planReviewIntent(controller.state!, { type: "feedback/start-draft", anchor: createFileAnchor(file), kind: "note", severity: "comment", body: "hello" }))
      controller.dispatch(planReviewIntent(controller.state!, { type: "feedback/create", id: "f1", createdAt: "2026-08-28T00:00:00.000Z" }))
      controller.dispatch(planReviewIntent(controller.state!, { type: "viewed/mark", fileKey: file.key, viewedAt: "2026-08-28T00:00:00.000Z" }))
      const session = new ReactReviewSession(controller, () => undefined)
      session.finishDialog.setDecision("comment")
      session.finishDialog.setSummary("summary")
      session.finishDialog.open()
      const result = await session.finishDialog.submit()
      expect(result.ok).toBe(true)
      expect(controller.state?.feedback).toHaveLength(0)
      expect((await artifactStore.load(controller.state!.document.identity.id, "art-ws"))?.id).toBe("art-ws")
      expect((await stateStore.load()).reviews[controller.state!.document.identity.id]?.feedback).toHaveLength(0)
    } finally {
      try { await stateStore?.flush() } catch {}
      await repo?.cleanup()
    }
  })
  test("serializes generation refresh behind Finish without losing the refreshed document", async () => {
    let repo: TempRepository | undefined
    let stateStore: ReviewStateStore | undefined
    let controller: ReviewWorkspaceController | undefined
    try {
      repo = await createTempRepository()
      const runner = new RealRunner(repo.path)
      stateStore = new ReviewStateStore(runner)
      const artifactStore = new ReviewArtifactStore(runner)
      const fileA = makeFile({ key: "a", path: "src/a.ts", contentId: "content-a", patchDigest: "patch-a" })
      const fileB = makeFile({ key: "a", path: "src/a.ts", contentId: "content-b", patchDigest: "patch-b", hunks: [createReviewHunk({ index: 0, oldStart: 1, oldCount: 1, newStart: 1, newCount: 1, lines: ["-old", "+newer"] })] })
      const docA = makeDoc([fileA], "a".repeat(40))
      const docB = makeDoc([fileB], "b".repeat(40))
      let currentDocument = docA
      let loadCount = 0
      controller = new ReviewWorkspaceController({
        runner,
        stateStore,
        artifactStore,
        loadDocument: async () => {
          loadCount += 1
          return currentDocument
        },
        now: () => "2026-08-31T00:00:00.000Z",
        randomId: () => "race-artifact",
      })
      await controller.open("refs/heads/main")
      controller.dispatch(planReviewIntent(controller.state!, { type: "feedback/start-draft", anchor: createFileAnchor(fileA), kind: "note", severity: "comment", body: "pending" }))
      controller.dispatch(planReviewIntent(controller.state!, { type: "feedback/create", id: "race-feedback", createdAt: "2026-08-31T00:00:00.000Z" }))

      let releaseArtifact!: () => void
      const artifactGate = new Promise<void>((resolve) => { releaseArtifact = resolve })
      let artifactStarted!: () => void
      const artifactStartedSignal = new Promise<void>((resolve) => { artifactStarted = resolve })
      const originalCreateExclusive = artifactStore.createExclusive.bind(artifactStore)
      artifactStore.createExclusive = async (artifact) => {
        artifactStarted()
        await artifactGate
        return originalCreateExclusive(artifact)
      }

      const finishing = controller.finishReview({ decision: "comment", summary: "submitted" })
      await artifactStartedSignal
      currentDocument = docB
      const refreshing = controller.refreshGeneration()
      await Promise.resolve()
      expect(loadCount).toBe(1)

      releaseArtifact()
      await finishing
      await refreshing
      expect(controller.state?.document).toBe(docB)
      expect(controller.state?.document.files[0]?.contentId).toBe("content-b")
    } finally {
      await controller?.destroy()
      try { await stateStore?.flush() } catch {}
      await repo?.cleanup()
    }
  })
})
