import { describe, expect, test } from "bun:test"
import { testRender } from "@opentui/react/test-utils"
import { act, createElement } from "react"
import { createReviewDocument, createReviewHunk } from "../../../src/review/core/document"
import { createReviewGeneration, createReviewIdentity } from "../../../src/review/core/identity"
import { createInitialReviewState } from "../../../src/review/core/state"
import { reduceReviewState } from "../../../src/review/core/reducer"
import { ReviewWorkspaceApp } from "../../../src/ui/review-workspace/ReviewWorkspaceApp"
import { ReactReviewSession } from "../../../src/ui/review-workspace/react-review-session"
import type { ReviewWorkspaceController } from "../../../src/ui/review-workspace/controller"
import type { ReviewFile } from "../../../src/review/core/types"

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function makeFile(index: number): ReviewFile {
  const key = `file-${index}.ts`
  return {
    key, path: key, kind: "modified", oldBlobOid: "o", newBlobOid: "n", oldMode: "100644", newMode: "100644",
    contentId: `content-${key}`, patchDigest: `patch-${key}`, stats: { additions: 1, deletions: 1 },
    hunks: [createReviewHunk({ index: 0, oldStart: 1, oldCount: 2, newStart: 1, newCount: 2, lines: [" context", `-old ${index}`, `+new ${index}`] })], source: "available",
  }
}

function makeSession(files: readonly ReviewFile[]) {
  const identity = createReviewIdentity({ headRef: "refs/heads/feature", headOid: "h".repeat(40), baseRef: "refs/remotes/origin/main" })
  const generation = createReviewGeneration({ baseOid: "b".repeat(40), mergeBaseOid: "m".repeat(40), headOid: "h".repeat(40) })
  let state = createInitialReviewState(createReviewDocument({ identity, generation, commits: [], files }))
  const listeners = new Set<() => void>()
  const controller = {
    get state() { return state }, error: undefined,
    subscribe(listener: () => void) { listeners.add(listener); return () => listeners.delete(listener) },
    dispatch(action: Parameters<typeof reduceReviewState>[1]) { state = reduceReviewState(state, action); for (const listener of listeners) listener() },
    getExpandedSourceByGap: () => new Map(), expandGap: async () => undefined,
  } as unknown as ReviewWorkspaceController
  return { session: new ReactReviewSession(controller, () => undefined), controller }
}

async function flush(setup: Awaited<ReturnType<typeof testRender>>): Promise<void> {
  await act(async () => { await setup.renderOnce(); await Bun.sleep(0) })
}

describe("conformance: active React review stream", () => {
  test("renders source rows, binary/sidebar files, and stable row ids on the active surface", async () => {
    const active = makeSession([makeFile(0), { ...makeFile(1), kind: "binary", source: "binary", hunks: [] }])
    const setup = await testRender(createElement(ReviewWorkspaceApp, { session: active.session }), { width: 120, height: 30 })
    try {
      await flush(setup)
      expect(setup.renderer.root.findDescendantById("review-file-row:file-0.ts")).toBeDefined()
      expect(setup.renderer.root.findDescendantById("review-file-row:file-1.ts")).toBeDefined()
      expect(setup.captureCharFrame()).toContain("new 0")
    } finally { await act(async () => setup.renderer.destroy()) }
  })

  test("windowing keeps a large changeset bounded to the rendered viewport", async () => {
    const active = makeSession(Array.from({ length: 200 }, (_, index) => makeFile(index)))
    const setup = await testRender(createElement(ReviewWorkspaceApp, { session: active.session }), { width: 100, height: 20 })
    try {
      await flush(setup)
      const frame = setup.captureCharFrame()
      expect(frame).toContain("file-0.ts")
      expect(frame).not.toContain("new 199")
    } finally { await act(async () => setup.renderer.destroy()) }
  })
})
