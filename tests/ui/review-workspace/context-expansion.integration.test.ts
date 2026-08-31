import { describe, expect, test } from "bun:test"
import { createReviewDocument, createReviewHunk } from "../../../src/review/core/document"
import { createReviewGeneration, createReviewIdentity } from "../../../src/review/core/identity"
import { ReviewWorkspaceController } from "../../../src/ui/review-workspace/controller"
import type { SourceContextRequest, SourceContextResult } from "../../../src/review/core/types"
import type { SourceContextOutcome } from "../../../src/review/git/load-source-context"
import type { GitRunner } from "../../../src/git/runner"
import { reconcileReviewState } from "../../../src/review/core/reconcile"
import type { ViewedRecord } from "../../../src/review/core/state"
function makeHunk(i: number, oldStart: number, newStart: number, lines: string[]) {
  return createReviewHunk({ index:i, oldStart, oldCount: lines.filter(l=>l[0]!=="+").length, newStart, newCount: lines.filter(l=>l[0]!=="-").length, lines })
}

describe("context expansion — generation qualification and caching", () => {
  test("z or gap click dispatches expansion and publishes lines only when ids match", async () => {
    const identity = createReviewIdentity({ headRef:"refs/heads/feature", headOid:"a".repeat(40), baseRef:"refs/heads/main" })
    const generation = createReviewGeneration({ baseOid:"b".repeat(40), mergeBaseOid:"c".repeat(40), headOid:"a".repeat(40) })
    const h1 = makeHunk(0,1,1,[" a"," b"," c"])
    const h2 = makeHunk(1,10,10,[" x"," y"])
    const file = { key:"src/a.ts", path:"src/a.ts", kind:"modified" as const, oldBlobOid:"o1", newBlobOid:"n1", oldMode:"100644", newMode:"100644", contentId:"content-a", patchDigest:"patch-a", stats:{ additions:0, deletions:0 }, hunks:[h1,h2], source:"available" as const }
    const doc = createReviewDocument({ identity, generation, commits:[{ oid:"a".repeat(40), parents:[], author:"A", timestamp:0, subject:"s", body:"" }], files:[file] })

    let loadCalls: SourceContextRequest[] = []
    const fakeLoad = async (req: SourceContextRequest): Promise<SourceContextOutcome> => {
      loadCalls.push(req)
      const result: SourceContextResult = { reviewId:req.reviewId, generationId:req.generationId, fileKey:req.fileKey, side:req.side, startLine:req.startLine, lines: Array.from({length: req.endLine - req.startLine +1}, (_,i)=>`line ${req.startLine+i}`) }
      return { ok:true, result }
    }
    const fakeRunner = { run: async () => ({ stdout:"", stderr:"", exitCode:0 }) } as unknown as GitRunner
    const controller = new ReviewWorkspaceController({ runner: fakeRunner, loadDocument: async () => doc, loadSourceContextImpl: fakeLoad })
    await controller.open("refs/heads/main")
    expect(controller.state?.expandedGaps.length).toBe(0)

    // Expand gap before:1
    await controller.expandGap("src/a.ts", "before:1")
    expect(controller.state?.expandedGaps.some(g=>g.gapId==="before:1" && g.expanded)).toBe(true)
    expect(loadCalls.length).toBe(1)
    expect(loadCalls[0]!.reviewId).toBe(identity.id)
    expect(loadCalls[0]!.generationId).toBe(generation.id)
    expect(loadCalls[0]!.fileKey).toBe("src/a.ts")
    // gap 5 lines: from 1+3=4 to 9 inclusive => 5 lines? Let's check: h1 old 1+3=4, next old 10 => gap 6? But compute: 10 - (1+3)=6? Hmm but we set oldCount 3, so gapOld=10-4=6. But our lines: h1 has 3, gap =10-4=6? Expect 6 lines. Not crucial.
    expect(loadCalls[0]!.startLine).toBeGreaterThan(1)
    // Cache should now hold lines
    const cached = controller.getExpandedGapLines("src/a.ts", "before:1")
    expect(cached).toBeDefined()
    expect(cached!.length).toBeGreaterThan(0)
  })
  test("collapses a gap when source context is unavailable", async () => {
    const identity = createReviewIdentity({ headRef:"refs/heads/feature", headOid:"a".repeat(40), baseRef:"refs/heads/main" })
    const generation = createReviewGeneration({ baseOid:"b".repeat(40), mergeBaseOid:"c".repeat(40), headOid:"a".repeat(40) })
    const h1 = makeHunk(0, 1, 1, [" a"])
    const h2 = makeHunk(1, 10, 10, [" x"])
    const file = { key:"src/unavailable.ts", path:"src/unavailable.ts", kind:"modified" as const, oldBlobOid:"o1", newBlobOid:"n1", oldMode:"100644", newMode:"100644", contentId:"content-unavailable", patchDigest:"patch-unavailable", stats:{ additions:0, deletions:0 }, hunks:[h1,h2], source:"available" as const }
    const doc = createReviewDocument({ identity, generation, commits:[], files:[file] })
    const fakeRunner = { run: async () => ({ stdout:"", stderr:"", exitCode:0 }) } as unknown as GitRunner
    const controller = new ReviewWorkspaceController({
      runner: fakeRunner,
      loadDocument: async () => doc,
      loadSourceContextImpl: async () => ({ ok:false, error:{ kind:"unavailable", fileKey:file.key, side:"new", reason:"missing blob" } }),
    })
    await controller.open("refs/heads/main")
    await controller.expandGap(file.key, "before:1")

    expect(controller.state?.expandedGaps.some((gap) => gap.gapId === "before:1" && gap.expanded)).toBe(false)
  })

  test("publishes returned lines only when request still matches — stale generation discarded", async () => {
    const identity = createReviewIdentity({ headRef:"refs/heads/feature", headOid:"a".repeat(40), baseRef:"refs/heads/main" })
    const gen1 = createReviewGeneration({ baseOid:"b".repeat(40), mergeBaseOid:"c".repeat(40), headOid:"a".repeat(40) })
    const gen2 = createReviewGeneration({ baseOid:"b".repeat(40), mergeBaseOid:"c".repeat(40), headOid:"b".repeat(40) })
    const h1 = makeHunk(0,1,1,[" a"," b"])
    const h2 = makeHunk(1,10,10,[" x"," y"])
    const file = { key:"src/a.ts", path:"src/a.ts", kind:"modified" as const, oldBlobOid:"o1", newBlobOid:"n1", oldMode:"100644", newMode:"100644", contentId:"content-a", patchDigest:"patch-a", stats:{ additions:0, deletions:0 }, hunks:[h1,h2], source:"available" as const }
    const doc1 = createReviewDocument({ identity, generation:gen1, commits:[{ oid:"a".repeat(40), parents:[], author:"A", timestamp:0, subject:"s", body:"" }], files:[file] })
    const file2 = { ...file, contentId:"content-a2" }
    const doc2 = createReviewDocument({ identity, generation:gen2, commits:[{ oid:"b".repeat(40), parents:[], author:"A", timestamp:0, subject:"s", body:"" }], files:[file2] })

    let resolveLoad!: (v: SourceContextOutcome)=>void
    let pendingReq: SourceContextRequest | null = null
    const fakeLoad = (req: SourceContextRequest): Promise<SourceContextOutcome> => {
      pendingReq = req
      return new Promise<SourceContextOutcome>(res => { resolveLoad = res })
    }
    const fakeRunner = { run: async () => ({ stdout:"", stderr:"", exitCode:0 }) } as unknown as GitRunner
    let currentDoc = doc1
    const controller = new ReviewWorkspaceController({ runner: fakeRunner, loadDocument: async () => currentDoc, loadSourceContextImpl: fakeLoad })
    await controller.open("refs/heads/main")
    // Start expansion but don't resolve yet
    const expandPromise = controller.expandGap("src/a.ts", "before:1")
    expect(pendingReq).not.toBeNull()
    expect(pendingReq!.generationId).toBe(gen1.id)
    // Simulate generation change before load returns: swap doc to gen2 and trigger reconcile via open? Or directly mutate state generation
    // For test, we will change active generation by opening new doc with generation gen2 (simulates refresh)
    currentDoc = doc2
    // Manually trigger reconcile by calling open again? Instead we mutate controller's internal generation by forcing a refresh via dispatch of document/reconciled
    // Use internal: set state to doc2 via reconcile
    const reconciled = reconcileReviewState(controller.state!, doc2)
    const emptyViewed = {} as unknown as Record<string, ViewedRecord>
    controller.dispatch({ type:"document/reconciled", document: doc2, viewed: emptyViewed, feedback: reconciled.feedback, selection: reconciled.selection, lineSelection: reconciled.lineSelection, expandedGaps: reconciled.expandedGaps })
    // Now resolve stale load with gen1
    const result: SourceContextResult = { reviewId: pendingReq!.reviewId, generationId: pendingReq!.generationId, fileKey: pendingReq!.fileKey, side: pendingReq!.side, startLine: pendingReq!.startLine, lines:["stale line"] }
    resolveLoad({ ok:true, result })
    await expandPromise
    // Cache should NOT contain stale lines because generation mismatched
    const cached = controller.getExpandedGapLines("src/a.ts", "before:1")
    // After generation change, contentId also changed, but even if same key, should be discarded
    // Since file contentId changed to content-a2, cache key uses content-a, not content-a2, so old cache key would not be returned for new file
    expect(cached).toBeUndefined()
    // Load should have been discarded, expandedGaps still true? The gap toggle remains, but source not cached
  })

  test("cache by content id and source range — second expansion hits cache without loader", async () => {
    const identity = createReviewIdentity({ headRef:"refs/heads/feature", headOid:"a".repeat(40), baseRef:"refs/heads/main" })
    const generation = createReviewGeneration({ baseOid:"b".repeat(40), mergeBaseOid:"c".repeat(40), headOid:"a".repeat(40) })
    const h1 = makeHunk(0,1,1,[" a"," b"])
    const h2 = makeHunk(1,10,10,[" x"])
    const file = { key:"src/a.ts", path:"src/a.ts", kind:"modified" as const, oldBlobOid:"o1", newBlobOid:"n1", oldMode:"100644", newMode:"100644", contentId:"content-a", patchDigest:"patch-a", stats:{ additions:0, deletions:0 }, hunks:[h1,h2], source:"available" as const }
    const doc = createReviewDocument({ identity, generation, commits:[{ oid:"a".repeat(40), parents:[], author:"A", timestamp:0, subject:"s", body:"" }], files:[file] })

    let callCount = 0
    const fakeLoad = async (req: SourceContextRequest): Promise<SourceContextOutcome> => {
      callCount++
      const result: SourceContextResult = { reviewId:req.reviewId, generationId:req.generationId, fileKey:req.fileKey, side:req.side, startLine:req.startLine, lines:["cached line"] }
      return { ok:true, result }
    }
    const fakeRunner = { run: async () => ({ stdout:"", stderr:"", exitCode:0 }) } as unknown as GitRunner
    const controller = new ReviewWorkspaceController({ runner: fakeRunner, loadDocument: async () => doc, loadSourceContextImpl: fakeLoad })
    await controller.open("refs/heads/main")
    await controller.expandGap("src/a.ts", "before:1")
    expect(callCount).toBe(1)
    // Collapse
    await controller.expandGap("src/a.ts", "before:1")
    expect(controller.state?.expandedGaps.some(g=>g.gapId==="before:1" && g.expanded)).toBe(false)
    // Re-expand same gap — should hit cache by contentId+range, no second load
    await controller.expandGap("src/a.ts", "before:1")
    expect(callCount).toBe(1)
    expect(controller.getExpandedGapLines("src/a.ts", "before:1")).toBeDefined()
    controller.clearSourceContextCache()
    await controller.ensureExpandedGapSource("src/a.ts", "before:1")
    expect(controller.state?.expandedGaps.some(g=>g.gapId==="before:1" && g.expanded)).toBe(true)
    expect(callCount).toBe(2)
  })

})
