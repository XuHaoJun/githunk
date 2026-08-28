import { describe, expect, test } from "bun:test"
import { testRender } from "@opentui/react/test-utils"
import { act, useEffect, useState } from "react"
import { createReviewDocument, createReviewHunk } from "../../../src/review/core/document"
import { createReviewGeneration, createReviewIdentity } from "../../../src/review/core/identity"
import { createInitialReviewState } from "../../../src/review/core/state"
import { toHunkReviewFile } from "../../../src/ui/review-workspace/hunk-review-model"
import { useReviewHighlights } from "../../../src/ui/review-workspace/hooks/useReviewHighlights"
import type { HighlightPayload } from "../../../src/review/git/highlight/highlight-payload"
import type { ReviewFile } from "../../../src/review/core/types"

function makeFile(): ReviewFile {
  return {
    key: "src/example.ts",
    path: "src/example.ts",
    kind: "modified",
    oldBlobOid: "1".repeat(40),
    newBlobOid: "2".repeat(40),
    oldMode: "100644",
    newMode: "100644",
    contentId: "content-example",
    patchDigest: "patch-example",
    stats: { additions: 1, deletions: 1 },
    hunks: [createReviewHunk({ index: 0, oldStart: 1, oldCount: 1, newStart: 1, newCount: 1, lines: ["-const old = 1", "+const next = 2"] })],
    source: "available",
  }
}

function makeState(file: ReviewFile) {
  const identity = createReviewIdentity({ headRef: "refs/heads/feature", headOid: "a".repeat(40), baseRef: "refs/heads/main" })
  const generation = createReviewGeneration({ baseOid: "b".repeat(40), mergeBaseOid: "c".repeat(40), headOid: "a".repeat(40) })
  return createInitialReviewState(createReviewDocument({ identity, generation, commits: [], files: [file] }))
}

const payload = (fileKey: string, text: string): HighlightPayload => ({
  fileKey,
  additionLines: [[{ text, fg: "#fff" }]],
  deletionLines: [[{ text, fg: "#f00" }]],
  theme: "dark",
})

async function flush(setup: Awaited<ReturnType<typeof testRender>>) {
  await act(async () => {
    await setup.renderOnce()
    await Bun.sleep(0)
    await setup.renderOnce()
  })
}

describe("useReviewHighlights", () => {
  test("deduplicates the selected file request and publishes its result", async () => {
    const file = makeFile()
    const hunkFile = toHunkReviewFile(file)
    const hunkFiles = [hunkFile]
    const state = makeState(file)
    let calls = 0
    const loader = async () => {
      calls += 1
      return payload(file.key, "const next = 2")
    }
    function Probe() {
      const result = useReviewHighlights({ files: hunkFiles, state, selectedFileKey: file.key, appearance: "dark", loadHighlight: loader })
      return <text content={`${result.highlights.size}:${calls}`} />
    }
    const setup = await testRender(<Probe />, { width: 80, height: 10 })
    try {
      await flush(setup)
      await flush(setup)
      expect(calls).toBe(1)
      expect(setup.captureCharFrame()).toContain("1:1")
    } finally {
      await act(async () => setup.renderer.destroy())
    }
  })

  test("ignores a result from a superseded generation", async () => {
    const file = makeFile()
    const hunkFile = toHunkReviewFile(file)
    const hunkFiles = [hunkFile]
    const state = makeState(file)
    let changeGeneration: ((value: string) => void) | undefined
    let resolveFirst: ((value: HighlightPayload) => void) | undefined
    let resolveSecond: ((value: HighlightPayload) => void) | undefined
    let call = 0
    const loader = () => {
      call += 1
      return new Promise<HighlightPayload>((resolve) => {
        if (call === 1) resolveFirst = resolve
        else resolveSecond = resolve
      })
    }
    function Probe() {
      const [generationId, setGenerationId] = useState("generation-1")
      useEffect(() => { changeGeneration = setGenerationId }, [])
      const result = useReviewHighlights({ files: hunkFiles, state, reviewId: "review", generationId, selectedFileKey: file.key, appearance: "dark", loadHighlight: loader })
      return <text content={`${generationId}:${result.highlights.size}`} />
    }
    const setup = await testRender(<Probe />, { width: 80, height: 10 })
    try {
      await flush(setup)
      await act(async () => changeGeneration?.("generation-2"))
      resolveFirst?.(payload(file.key, "stale"))
      await flush(setup)
      expect(setup.captureCharFrame()).toContain("generation-2:0")
      resolveSecond?.(payload(file.key, "current"))
      await flush(setup)
      await flush(setup)
      expect(setup.captureCharFrame()).toContain("generation-2:1")
    } finally {
      await act(async () => setup.renderer.destroy())
    }
  })
})
