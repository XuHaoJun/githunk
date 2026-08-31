import { describe, expect, test } from "bun:test"
import { testRender } from "@opentui/react/test-utils"
import { act, createElement } from "react"
import { createReviewDocument, createReviewHunk } from "../../../src/review/core/document"
import type { ReviewFile } from "../../../src/review/core/types"
import { createReviewGeneration, createReviewIdentity } from "../../../src/review/core/identity"
import { createInitialReviewState } from "../../../src/review/core/state"
import { reduceReviewState } from "../../../src/review/core/reducer"
import type { ReviewWorkspaceController } from "../../../src/ui/review-workspace/controller"
import { ReviewWorkspaceApp } from "../../../src/ui/review-workspace/ReviewWorkspaceApp"
import { ReactReviewSession } from "../../../src/ui/review-workspace/react-review-session"

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function makeFile(key: string, lines: readonly string[]): ReviewFile {
  const oldCount = lines.filter((line) => line[0] !== "+").length
  const newCount = lines.filter((line) => line[0] !== "-").length
  return {
    key,
    path: key,
    kind: "modified",
    oldBlobOid: "1".repeat(40),
    newBlobOid: "2".repeat(40),
    oldMode: "100644",
    newMode: "100644",
    contentId: `content-${key}`,
    patchDigest: `patch-${key}`,
    stats: { additions: 1, deletions: 1 },
    hunks: [createReviewHunk({ index: 0, oldStart: 1, oldCount, newStart: 1, newCount, lines })],
    source: "available",
  }
}

function makeSession(files: readonly ReviewFile[]): { session: ReactReviewSession; getState: () => ReturnType<typeof createInitialReviewState> } {
  const identity = createReviewIdentity({ headRef: "refs/heads/feature", headOid: "a".repeat(40), baseRef: "refs/heads/main" })
  const generation = createReviewGeneration({ baseOid: "b".repeat(40), mergeBaseOid: "c".repeat(40), headOid: "a".repeat(40) })
  let state = createInitialReviewState(createReviewDocument({ identity, generation, commits: [], files }))
  const listeners = new Set<() => void>()
  const controller = {
    get state() { return state },
    error: undefined,
    subscribe(listener: () => void) { listeners.add(listener); return () => listeners.delete(listener) },
    dispatch(action: Parameters<typeof reduceReviewState>[1]) {
      state = reduceReviewState(state, action)
      for (const listener of listeners) listener()
    },
    getExpandedSourceByGap: () => new Map(),
    expandGap: async () => undefined,
  } as unknown as ReviewWorkspaceController
  return { session: new ReactReviewSession(controller, () => undefined), getState: () => state }
}

async function flush(setup: Awaited<ReturnType<typeof testRender>>): Promise<void> {
  await act(async () => {
    await setup.renderOnce()
    await Bun.sleep(0)
    await setup.renderOnce()
  })
}

describe("React review stream surface", () => {
  test("renders the continuous diff stream and scrolls through it with real input", async () => {
    const file = makeFile("src/stream.ts", Array.from({ length: 40 }, (_, index) => `+const line${index} = ${index}`))
    const setup = await testRender(createElement(ReviewWorkspaceApp, { session: makeSession([file]).session }), { width: 100, height: 10 })
    try {
      await flush(setup)
      const scrollBox = setup.renderer.root.findDescendantById("review-diff-scrollbox") as unknown as { scrollTop: number }
      expect(scrollBox.scrollTop).toBe(0)
      await act(async () => setup.mockInput.pressKeys(["j", "j"]))
      await flush(setup)
      expect(scrollBox.scrollTop).toBe(2)
    } finally {
      await act(async () => setup.renderer.destroy())
    }
  })

  test("selects a sidebar file through its rendered id and updates controller state", async () => {
    const files = [makeFile("src/first.ts", ["-old", "+new"]), makeFile("src/second.ts", ["-before", "+after"])]
    const active = makeSession(files)
    const setup = await testRender(createElement(ReviewWorkspaceApp, { session: active.session }), { width: 120, height: 20, useMouse: true })
    try {
      await flush(setup)
      const row = setup.renderer.root.findDescendantById("review-file-row:src/second.ts") as unknown as { screenX: number; screenY: number; width: number; height: number }
      await act(async () => {
        await setup.mockMouse.click(row.screenX + 1, row.screenY)
        await flush(setup)
      })
      expect(active.getState().selection.fileKey).toBe("src/second.ts")
      expect(setup.captureCharFrame()).toContain("src/second.ts")
    } finally {
      await act(async () => setup.renderer.destroy())
    }
  })
})
