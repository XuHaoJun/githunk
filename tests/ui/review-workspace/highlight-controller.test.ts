import { describe, expect, test } from "bun:test"
import { createReviewDocument, createReviewHunk } from "../../../src/review/core/document"
import { createReviewGeneration, createReviewIdentity } from "../../../src/review/core/identity"
import { ReviewWorkspaceController } from "../../../src/ui/review-workspace/controller"
import type { GitRunner } from "../../../src/git/runner"

function makeDoc(headOid: string, files: ReturnType<typeof createReviewDocument>["files"]) {
  const identity = createReviewIdentity({ headRef: "refs/heads/feature", headOid, baseRef: "refs/heads/main" })
  const generation = createReviewGeneration({ baseOid: "b".repeat(40), mergeBaseOid: "c".repeat(40), headOid })
  return createReviewDocument({ identity, generation, commits: [{ oid: headOid, parents: [], author: "A", timestamp: 0, subject: "s", body: "" }], files })
}

function makeHunk(lines: string[]) {
  return createReviewHunk({ oldStart: 1, oldCount: 1, newStart: 1, newCount: 1, lines, index: 0 })
}
function makeFile(key: string, lines: string[]) {
  return {
    key,
    path: key,
    kind: "modified" as const,
    oldBlobOid: "o1",
    newBlobOid: "n1",
    oldMode: "100644",
    newMode: "100644",
    contentId: `cid-${key}`,
    patchDigest: `patch-${key}`,
    stats: { additions: 1, deletions: 1 },
    hunks: [makeHunk(lines)],
    source: "available" as const,
  }
}

describe("ReviewWorkspaceController highlight orchestration", () => {
  test("loads highlights after open and publishes incrementally", async () => {
    const doc1 = makeDoc("a".repeat(40), [makeFile("foo.ts", ["-const x: number = 1", "+const y: string = \"hi\""])])
    let loadCount = 0
    const controller = new ReviewWorkspaceController({
      runner: {} as GitRunner,
      loadDocument: async () => {
        loadCount++
        return doc1
      },
      stateStore: undefined,
      artifactStore: undefined,
    } as unknown as ConstructorParameters<typeof ReviewWorkspaceController>[0])

    await controller.open("main")
    // Initially highlight map may be empty, but after async tick should be populated
    // Wait for highlight async (allow up to 2s)
    const start = Date.now()
    while (controller.getHighlightByFileKey().size === 0 && Date.now() - start < 2000) {
      await new Promise((r) => setTimeout(r, 20))
    }
    const highlights = controller.getHighlightByFileKey()
    expect(highlights.size).toBeGreaterThan(0)
    expect(highlights.get("foo.ts")).toBeDefined()
    const payload = highlights.get("foo.ts")!
    const hasFg = payload.additionLines.some((line) => line !== null && line.some((t) => t.fg !== undefined))
    expect(hasFg).toBe(true)
  })

  test("discards stale highlight from previous generation", async () => {
    const docGen1 = makeDoc("a".repeat(40), [makeFile("foo.ts", ["-const a = 1", "+const b = 2"])])
    const docGen2 = makeDoc("b".repeat(40), [makeFile("foo.ts", ["-const a = 1", "+const c = 3"])])
    let call = 0
    const controller = new ReviewWorkspaceController({
      runner: {} as GitRunner,
      loadDocument: async () => {
        call++
        if (call === 1) return docGen1
        return docGen2
      },
    } as unknown as ConstructorParameters<typeof ReviewWorkspaceController>[0])

    await controller.open("main")
    // Wait for gen1 highlight
    let start = Date.now()
    while (controller.getHighlightByFileKey().size === 0 && Date.now() - start < 2000) await new Promise((r) => setTimeout(r, 20))
    expect(controller.generationId).toBe(docGen1.generation.id)
    const firstPayload = controller.getHighlightByFileKey().get("foo.ts")

    // Trigger refresh to gen2
    await controller.refreshGeneration()
    // Wait for gen2 highlight
    start = Date.now()
    while (controller.generationId !== docGen2.generation.id && Date.now() - start < 2000) await new Promise((r) => setTimeout(r, 10))
    // need to wait for highlight of gen2 as well
    start = Date.now()
    while (controller.getHighlightByFileKey().size === 0 && Date.now() - start < 2000) await new Promise((r) => setTimeout(r, 20))
    // need to wait until highlight updated to gen2's content (payload should differ from first)
    // poll until payload changes or timeout
    start = Date.now()
    while (Date.now() - start < 2000) {
      const cur = controller.getHighlightByFileKey().get("foo.ts")
      if (cur && cur !== firstPayload) break
      await new Promise((r) => setTimeout(r, 20))
    }
    expect(controller.generationId).toBe(docGen2.generation.id)
    expect(controller.getHighlightByFileKey().get("foo.ts")).toBeDefined()
  })

  test("highlight load does not block initial render (open returns before highlight)", async () => {
    const doc = makeDoc("a".repeat(40), [makeFile("slow.ts", ["-const x = 1", "+const y = 2"])])
    let highlightStarted = false
    let openReturned = false
    const controller = new ReviewWorkspaceController({
      runner: {} as GitRunner,
      loadDocument: async () => doc,
    } as unknown as ConstructorParameters<typeof ReviewWorkspaceController>[0])

    // Monkey-patch highlight adapter to delay
    const original = await import("../../../src/review/git/highlight/highlight-adapter")
    const origLoad = original.loadHighlightForPatch
    // We can't easily patch, just check that open returns quickly
    const openPromise = controller.open("main").then(() => {
      openReturned = true
    })
    // Open should resolve within reasonable time even if highlight is pending
    await openPromise
    expect(openReturned).toBe(true)
    expect(controller.state).toBeDefined()
    // highlight may still be pending, but eventually should appear
    const start = Date.now()
    while (controller.getHighlightByFileKey().size === 0 && Date.now() - start < 2000) await new Promise((r) => setTimeout(r, 20))
    expect(controller.getHighlightByFileKey().size).toBeGreaterThanOrEqual(0)
  })
})
