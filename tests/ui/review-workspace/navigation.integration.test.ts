import { describe, expect, test } from "bun:test"
import { testRender } from "@opentui/react/test-utils"
import { act, createElement } from "react"
import { ReviewWorkspaceController } from "../../../src/ui/review-workspace/controller"
import { ReviewWorkspaceApp } from "../../../src/ui/review-workspace/ReviewWorkspaceApp"
import { ReactReviewSession } from "../../../src/ui/review-workspace/react-review-session"
import { createReviewDocument, createReviewHunk } from "../../../src/review/core/document"
import { createReviewGeneration, createReviewIdentity } from "../../../src/review/core/identity"
import { createInitialReviewState } from "../../../src/review/core/state"
import { reduceReviewState } from "../../../src/review/core/reducer"
import type { ReviewFile } from "../../../src/review/core/types"
import type { GitRunner } from "../../../src/git/runner"

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function makeFile(key: string, line = "new"): ReviewFile {
  return {
    key, path: key, kind: "modified", oldBlobOid: "o", newBlobOid: "n", oldMode: "100644", newMode: "100644",
    contentId: `content-${key}`, patchDigest: `patch-${key}`, stats: { additions: 1, deletions: 1 },
    hunks: [createReviewHunk({ index: 0, oldStart: 1, oldCount: 1, newStart: 1, newCount: 1, lines: ["-old", `+${line}`] })], source: "available",
  }
}

function makeSession(files: readonly ReviewFile[]) {
  const identity = createReviewIdentity({ headRef: "refs/heads/feature", headOid: "a".repeat(40), baseRef: "refs/heads/main" })
  const generation = createReviewGeneration({ baseOid: "b".repeat(40), mergeBaseOid: "c".repeat(40), headOid: "a".repeat(40) })
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

describe("React review navigation", () => {
  test("sidebar click selects a file through the rendered row", async () => {
    const active = makeSession([makeFile("src/a.ts"), makeFile("src/b.ts")])
    const setup = await testRender(createElement(ReviewWorkspaceApp, { session: active.session }), { width: 120, height: 24, useMouse: true })
    try {
      await flush(setup)
      const row = setup.renderer.root.findDescendantById("review-file-row:src/b.ts") as unknown as { screenX: number; screenY: number }
      await act(async () => setup.mockMouse.click(row.screenX + 1, row.screenY))
      await flush(setup)
      expect(active.controller.state?.selection.fileKey).toBe("src/b.ts")
    } finally { await act(async () => setup.renderer.destroy()) }
  })

  test("R opens finish and slash focuses the actual filter input", async () => {
    const active = makeSession([makeFile("src/a.ts")])
    const setup = await testRender(createElement(ReviewWorkspaceApp, { session: active.session }), { width: 100, height: 24 })
    try {
      await flush(setup)
      await act(async () => setup.mockInput.pressKey("/"))
      await flush(setup)
      const filter = setup.renderer.root.findDescendantById("review-file-filter-input") as unknown as { focused: boolean }
      expect(filter.focused).toBe(true)
      await act(async () => setup.mockInput.pressKey("ESCAPE"))
      await act(async () => setup.mockInput.pressKey("R"))
      await flush(setup)
      expect(setup.renderer.root.findDescendantById("review-finish-dialog")).toBeDefined()
    } finally { await act(async () => setup.renderer.destroy()) }
  })

  test("semantic file and hunk commands update controller state via input", async () => {
    const active = makeSession([makeFile("src/a.ts"), makeFile("src/b.ts")])
    const setup = await testRender(createElement(ReviewWorkspaceApp, { session: active.session }), { width: 100, height: 24 })
    try {
      await flush(setup)
      await act(async () => setup.mockInput.pressKeys(["."]))
      await flush(setup)
      expect(active.controller.state?.selection.fileKey).toBe("src/b.ts")
    } finally { await act(async () => setup.renderer.destroy()) }
  })
})
