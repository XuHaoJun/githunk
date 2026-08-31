import { describe, expect, test } from "bun:test"
import { testRender } from "@opentui/react/test-utils"
import { act } from "react"
import { createReviewDocument, createReviewHunk } from "../../../src/review/core/document"
import { createReviewGeneration, createReviewIdentity } from "../../../src/review/core/identity"
import { createInitialReviewState } from "../../../src/review/core/state"
import { ReviewWorkspaceApp } from "../../../src/ui/review-workspace/ReviewWorkspaceApp"
import { ReactReviewSession } from "../../../src/ui/review-workspace/react-review-session"
import type { ReviewWorkspaceController } from "../../../src/ui/review-workspace/controller"
import type { ReviewFile } from "../../../src/review/core/types"

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

type CapturedColor = Readonly<{ toInts: () => readonly number[] }>
type CapturedSpan = Readonly<{ text: string; fg?: CapturedColor }>

function makeSession(): ReactReviewSession {
  const file: ReviewFile = {
    key: "src/highlight.ts", path: "src/highlight.ts", kind: "modified", oldBlobOid: "o", newBlobOid: "n", oldMode: "100644", newMode: "100644",
    contentId: "content-highlight", patchDigest: "patch-highlight", stats: { additions: 1, deletions: 1 },
    hunks: [createReviewHunk({ index: 0, oldStart: 1, oldCount: 1, newStart: 1, newCount: 1, lines: ["-const answer = 41", "+const answer = 42"] })], source: "available",
  }
  const identity = createReviewIdentity({ headRef: "refs/heads/feature", headOid: "a".repeat(40), baseRef: "refs/heads/main" })
  const generation = createReviewGeneration({ baseOid: "b".repeat(40), mergeBaseOid: "c".repeat(40), headOid: "a".repeat(40) })
  const state = createInitialReviewState(createReviewDocument({ identity, generation, commits: [], files: [file] }))
  const controller = { state, error: undefined, subscribe: () => () => undefined } as unknown as ReviewWorkspaceController
  return new ReactReviewSession(controller, () => undefined)
}

async function flush(setup: Awaited<ReturnType<typeof testRender>>): Promise<void> {
  await act(async () => {
    await setup.renderOnce()
    await Bun.sleep(0)
    await setup.renderOnce()
  })
}

describe("React review syntax highlighting", () => {
  test("loads real adapter tokens through useReviewHighlights into rendered rows", async () => {
    const setup = await testRender(<ReviewWorkspaceApp session={makeSession()} />, { width: 120, height: 20 })
    try {
      for (let attempt = 0; attempt < 8; attempt += 1) await flush(setup)
      const spans = setup.captureSpans().lines.flatMap((line) => line.spans) as readonly CapturedSpan[]
      const answer = spans.find((span) => span.text.includes("answer"))
      expect(answer).toBeDefined()
      expect(answer?.fg?.toInts().slice(0, 3)).not.toEqual([185, 202, 74])
    } finally {
      await act(async () => setup.renderer.destroy())
    }
  })
})
