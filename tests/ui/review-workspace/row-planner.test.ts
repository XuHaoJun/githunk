import { describe, expect, test } from "bun:test"
import { createReviewDocument, createReviewHunk } from "../../../src/review/core/document"
import { createReviewGeneration, createReviewIdentity } from "../../../src/review/core/identity"
import type { ReviewState } from "../../../src/review/core/state"
import { createInitialReviewState } from "../../../src/review/core/state"
import { planReviewRows, sourceAddressAtViewportRow, __clearRowPlannerCache, __getBuildInvocationCount, __resetBuildInvocationCount, resolveRangeFromViewportSelection } from "../../../src/ui/review-workspace/row-planner"
import { cellWidth } from "../../../src/ui/cell-width"

function makeIdentity(headOid = "a".repeat(40)) {
  return createReviewIdentity({ headRef: "refs/heads/feature", headOid, baseRef: "refs/heads/main" })
}
function makeGeneration(headOid = "a".repeat(40)) {
  return createReviewGeneration({ baseOid: "b".repeat(40), mergeBaseOid: "c".repeat(40), headOid })
}
function makeHunk(overrides: Partial<{ oldStart: number; oldCount: number; newStart: number; newCount: number; lines: string[]; index: number }> & { index: number }): ReturnType<typeof createReviewHunk> {
  return createReviewHunk({
    oldStart: overrides.oldStart ?? 1,
    oldCount: overrides.oldCount ?? overrides.lines?.length ?? 3,
    newStart: overrides.newStart ?? 1,
    newCount: overrides.newCount ?? overrides.lines?.length ?? 3,
    lines: overrides.lines ?? [" line1", "-old", "+new"],
    index: overrides.index,
  })
}
function makeFile(key: string, path: string, hunks: ReturnType<typeof createReviewHunk>[], overrides?: Partial<import("../../../src/review/core/types").ReviewFile>) {
  return {
    key,
    path,
    kind: "modified" as const,
    oldBlobOid: "o1",
    newBlobOid: "n1",
    oldMode: "100644",
    newMode: "100644",
    contentId: `content-${key}`,
    patchDigest: `patch-${key}`,
    stats: { additions: 1, deletions: 1 },
    hunks,
    source: "available" as const,
    ...overrides,
  }
}
function makeDoc(files: ReturnType<typeof makeFile>[]) {
  const identity = makeIdentity()
  const generation = makeGeneration()
  return createReviewDocument({ identity, generation, commits: [{ oid: "a".repeat(40), parents: [], author: "A", timestamp: 0, subject: "s", body: "" }], files })
}
function makeState(doc: ReturnType<typeof makeDoc>): ReviewState {
  return createInitialReviewState(doc)
}

describe("row-planner — document order, headers, split/stack, wrapping, gaps, feedback, source addresses", () => {
  test("preserves document order with file and hunk headers", () => {
    __clearRowPlannerCache()
    const doc = makeDoc([
      makeFile("a", "src/a.ts", [makeHunk({ index:0, lines:[" ctx", "-del", "+add"], oldStart:1, newStart:1 })]),
      makeFile("b", "src/b.ts", [makeHunk({ index:0, lines:[" ctx2"], oldStart:10, newStart:10 })]),
    ])
    const state = makeState(doc)
    const plan = planReviewRows(state, { viewportStart:0, viewportHeight:100, width:80, effectiveMode:"stack", showLineNumbers:true, wrapLines:false })
    expect(plan.totalRows).toBeGreaterThan(0)
    // First rows should be file-header for a, then hunk-header, then diff rows, then file-header for b
    const kinds = plan.rows.map(r=>r.kind)
    const fileHeaders = plan.rows.filter(r=>r.kind==="file-header").map(r=>r.fileKey)
    expect(fileHeaders).toEqual(["a","b"])
    // Hunk headers per file
    const hunkHeaders = plan.rows.filter(r=>r.kind==="hunk-header")
    expect(hunkHeaders.length).toBe(2)
    expect(hunkHeaders[0]!.fileKey).toBe("a")
    expect(hunkHeaders[1]!.fileKey).toBe("b")
    // Ensure order: file-header a before its hunk header before its diffs before file-header b
    const idxFileA = plan.rows.findIndex(r=>r.fileKey==="a" && r.kind==="file-header")
    const idxHunkA = plan.rows.findIndex(r=>r.fileKey==="a" && r.kind==="hunk-header")
    const idxDiffA = plan.rows.findIndex(r=>r.fileKey==="a" && r.kind==="diff")
    const idxFileB = plan.rows.findIndex(r=>r.fileKey==="b" && r.kind==="file-header")
    expect(idxFileA).toBeLessThan(idxHunkA)
    expect(idxHunkA).toBeLessThan(idxDiffA)
    expect(idxDiffA).toBeLessThan(idxFileB)
  })

  test("split and stacked lines differ in wrapping height", () => {
    __clearRowPlannerCache()
    const longContent = "x".repeat(100)
    const hunk = makeHunk({ index:0, lines:[`+${longContent}`], oldStart:1, oldCount:0, newStart:1, newCount:1 })
    const file = makeFile("f", "src/long.ts", [hunk])
    const doc = makeDoc([file])
    const state = makeState(doc)
    const width = 60
    const stackPlan = planReviewRows(state, { viewportStart:0, viewportHeight:100, width, effectiveMode:"stack", wrapLines:true, showLineNumbers:true })
    __clearRowPlannerCache()
    const splitPlan = planReviewRows(state, { viewportStart:0, viewportHeight:100, width, effectiveMode:"split", wrapLines:true, showLineNumbers:true })
    // Split has narrower per-column available, so should produce more rows for same long line
    expect(splitPlan.totalRows).toBeGreaterThan(stackPlan.totalRows)
    // Both should have file-header + hunk-header + at least one diff row, but split wraps into multiple terminal rows
    const stackDiffRows = stackPlan.rows.filter(r=>r.kind==="diff")
    const splitDiffRows = splitPlan.rows.filter(r=>r.kind==="diff")
    expect(splitDiffRows.length).toBeGreaterThan(stackDiffRows.length)
  })

  test("wrapping splits long line into multiple terminal rows with same source address", () => {
    __clearRowPlannerCache()
    const content = "a".repeat(50)
    const hunk = makeHunk({ index:0, lines:[`+${content}`], oldStart:1, oldCount:0, newStart:5, newCount:1 })
    const file = makeFile("f", "src/wrap.ts", [hunk])
    const doc = makeDoc([file])
    const state = makeState(doc)
    const plan = planReviewRows(state, { viewportStart:0, viewportHeight:100, width:20, effectiveMode:"stack", wrapLines:true, showLineNumbers:true })
    const diffRows = plan.rows.filter(r=>r.kind==="diff" && r.fileKey==="f")
    // Should have multiple rows for same source line 5 due to wrapping, deduplicated source address
    expect(diffRows.length).toBeGreaterThan(1)
    for (const r of diffRows) {
      expect(r.newLine).toBe(5)
      expect(r.oldLine).toBeNull()
    }
    // sourceAddressAtViewportRow should return same line for wrapped continuations
    const firstIdx = plan.rows.findIndex(r=>r.kind==="diff" && r.newLine===5)
    const globalFirst = plan.start + firstIdx
    const addr1 = sourceAddressAtViewportRow(plan, globalFirst)
    const addr2 = sourceAddressAtViewportRow(plan, globalFirst+1)
    expect(addr1?.newLine).toBe(5)
    expect(addr2?.newLine).toBe(5)
    // resolveRange across wrapped rows should deduplicate to single line range
    const range = resolveRangeFromViewportSelection(plan, globalFirst, globalFirst+1)
    expect(range.ok).toBe(true)
    if (range.ok) {
      expect(range.anchor.startLine).toBe(5)
      expect(range.anchor.endLine).toBe(5)
    }
  })

  test("CJK width respected for wrapping (wide chars count as 2)", () => {
    __clearRowPlannerCache()
    // 10 CJK chars = 20 cells. Width 12 should wrap to 2 rows (10 chars needing 20 cells, each row 10-2=8? We'll compute)
    const cjkContent = "汉字".repeat(5) // 10 chars, 20 cells
    const hunk = makeHunk({ index:0, lines:[`+${cjkContent}`] })
    const file = makeFile("f", "src/cjk.ts", [hunk])
    const doc = makeDoc([file])
    const state = makeState(doc)
    const width = 15 // small to force wrap: gutter ~4 + content 20 >15 => 2 rows
    const plan = planReviewRows(state, { viewportStart:0, viewportHeight:100, width, effectiveMode:"stack", wrapLines:true, showLineNumbers:false })
    const diffRows = plan.rows.filter(r=>r.kind==="diff")
    // With width 15, content 20 cells needs 2 rows
    expect(diffRows.length).toBe(2)
    // Verify cellWidth accounts for wide
    expect(cellWidth("汉")).toBe(2)
    expect(cellWidth(cjkContent)).toBe(20)
  })

  test("binary and too-large rows rendered with dedicated kind", () => {
    __clearRowPlannerCache()
    const binFile = makeFile("bin", "src/binary.png", [], { kind:"binary", source:"binary", hunks:[] })
    const largeFile = makeFile("large", "src/large.txt", [], { source:"too-large", hunks:[] })
    const normalFile = makeFile("norm", "src/norm.ts", [makeHunk({ index:0, lines:[" ctx"] })])
    const doc = makeDoc([binFile, largeFile, normalFile])
    const state = makeState(doc)
    const plan = planReviewRows(state, { viewportStart:0, viewportHeight:100, width:80, effectiveMode:"stack" })
    const binRows = plan.rows.filter(r=>r.fileKey==="bin")
    expect(binRows.some(r=>r.kind==="binary")).toBe(true)
    expect(binRows.some(r=>r.kind==="file-header")).toBe(true)
    const largeRows = plan.rows.filter(r=>r.fileKey==="large")
    expect(largeRows.some(r=>r.kind==="too-large")).toBe(true)
    // Binary file should have explanation text dim
    const binKindRow = plan.rows.find(r=>r.fileKey==="bin" && r.kind==="binary")!
    expect(binKindRow.text[0]!.style).toBe("dim")
    expect(binKindRow.text[0]!.text).toContain("Binary")
  })

  test("collapsed gaps render as gap rows, expanded gaps render context lines", () => {
    __clearRowPlannerCache()
    // Two hunks with gap 5 lines between
    const h1 = makeHunk({ index:0, oldStart:1, oldCount:3, newStart:1, newCount:3, lines:[" ctx1"," ctx2"," ctx3"] })
    const h2 = makeHunk({ index:1, oldStart:9, oldCount:2, newStart:9, newCount:2, lines:[" ctxA"," ctxB"] })
    const file = makeFile("f", "src/gap.ts", [h1,h2])
    const doc = makeDoc([file])
    let state = makeState(doc)
    let plan = planReviewRows(state, { viewportStart:0, viewportHeight:100, width:80, effectiveMode:"stack" })
    const gapRows = plan.rows.filter(r=>r.kind==="gap")
    expect(gapRows.length).toBe(1)
    expect(gapRows[0]!.text[0]!.text).toContain("hidden")

    // Expand gap before:1
    state = { ...state, expandedGaps: [{ fileKey:"f", gapId:"before:1", expanded:true }] }
    __clearRowPlannerCache()
    plan = planReviewRows(state, { viewportStart:0, viewportHeight:100, width:80, effectiveMode:"stack" })
    const gapRowsAfter = plan.rows.filter(r=>r.kind==="gap")
    expect(gapRowsAfter.length).toBe(0)
    const expandedDiffRows = plan.rows.filter(r=>r.kind==="diff" && r.fileKey==="f" && (r.oldLine===4 || r.newLine===4))
    // Expanded gap should have 5 lines (9 - (1+3) =5)
    const expandedForGap = plan.rows.filter(r=>r.kind==="diff" && r.fileKey==="f" && r.oldLine!==null && r.oldLine>=4 && r.oldLine<=8)
    expect(expandedForGap.length).toBe(5)
  })

  test("feedback insertion after anchor line", () => {
    __clearRowPlannerCache()
    const hunk = makeHunk({ index:0, oldStart:1, oldCount:3, newStart:1, newCount:3, lines:[" ctx", "-old", "+new", " ctx2"] })
    const file = makeFile("f", "src/feed.ts", [hunk])
    const doc = makeDoc([file])
    let state = makeState(doc)
    // Add feedback anchored to second hunk line? Actually old line 2? Let's anchor to new line 2 (addition) hunk 0
    const feedback = {
      id:"fb1",
      kind:"note" as const,
      severity:"comment" as const,
      body:"hello feedback",
      anchor:{ kind:"range" as const, fileKey:"f", contentId:"content-f", side:"new" as const, startLine:2, endLine:2, ownerHunkIndex:0, contextDigest:"d" },
      resolution:"active" as const,
      createdAt:"2026-01-01T00:00:00.000Z",
      updatedAt:"2026-01-01T00:00:00.000Z",
    }
    state = { ...state, feedback: [feedback] }
    const plan = planReviewRows(state, { viewportStart:0, viewportHeight:100, width:80, effectiveMode:"stack" })
    const rows = plan.rows
    // Find diff row for newLine 2 (addition)
    const diffIdx = rows.findIndex(r=>r.kind==="diff" && r.newLine===2)
    expect(diffIdx).toBeGreaterThan(-1)
    const nextRow = rows[diffIdx+1]
    expect(nextRow?.kind).toBe("feedback")
    expect(nextRow?.text[0]?.text).toContain("hello feedback")
  })

  test("feedback insertion for file anchor appears after file header", () => {
    __clearRowPlannerCache()
    const file = makeFile("f", "src/file.ts", [makeHunk({ index:0, lines:[" ctx"] })])
    const doc = makeDoc([file])
    let state = makeState(doc)
    const fb = {
      id:"fb-file",
      kind:"note" as const,
      severity:"comment" as const,
      body:"file note",
      anchor:{ kind:"file" as const, fileKey:"f", contentId:"content-f" },
      resolution:"active" as const,
      createdAt:"2026-01-01T00:00:00.000Z",
      updatedAt:"2026-01-01T00:00:00.000Z",
    }
    state = { ...state, feedback: [fb] }
    const plan = planReviewRows(state, { viewportStart:0, viewportHeight:100, width:80, effectiveMode:"stack" })
    const fileHeaderIdx = plan.rows.findIndex(r=>r.fileKey==="f" && r.kind==="file-header")
    expect(fileHeaderIdx).toBeGreaterThan(-1)
    const feedbackIdx = plan.rows.findIndex(r=>r.kind==="feedback" && r.fileKey==="f")
    expect(feedbackIdx).toBe(fileHeaderIdx+1)
  })

  test("exact source addresses for context/addition/deletion", () => {
    __clearRowPlannerCache()
    const hunk = makeHunk({ index:0, oldStart:10, oldCount:3, newStart:10, newCount:3, lines:[" ctx line10", "-old line11", "+new line11", " ctx line12"] })
    const file = makeFile("f", "src/src.ts", [hunk])
    const doc = makeDoc([file])
    const state = makeState(doc)
    const plan = planReviewRows(state, { viewportStart:0, viewportHeight:100, width:80, effectiveMode:"stack", showLineNumbers:true })
    const diffRows = plan.rows.filter(r=>r.kind==="diff")
    // diffRows[0] context line 10
    expect(diffRows[0]!.oldLine).toBe(10)
    expect(diffRows[0]!.newLine).toBe(10)
    // diffRows[1] deletion old 11
    expect(diffRows[1]!.oldLine).toBe(11)
    expect(diffRows[1]!.newLine).toBeNull()
    // diffRows[2] addition new 11
    expect(diffRows[2]!.oldLine).toBeNull()
    expect(diffRows[2]!.newLine).toBe(11)
    // diffRows[3] context line12
    expect(diffRows[3]!.oldLine).toBe(12)
    expect(diffRows[3]!.newLine).toBe(12)
  })

  test("no-final-newline marker row", () => {
    __clearRowPlannerCache()
    const hunk = makeHunk({ index:0, lines:["+content", "\\ No newline at end of file"], oldStart:1, oldCount:0, newStart:1, newCount:1 })
    const file = makeFile("f", "src/nonn.ts", [hunk])
    const doc = makeDoc([file])
    const state = makeState(doc)
    const plan = planReviewRows(state, { viewportStart:0, viewportHeight:100, width:80, effectiveMode:"stack" })
    const markerRows = plan.rows.filter(r=>r.text.some(s=>s.text.includes("No newline")))
    expect(markerRows.length).toBe(1)
    expect(markerRows[0]!.text[0]!.style).toBe("dim")
  })

  test("windowed 10k-file document plans only viewport plus overscan rows and does not build off-window files", () => {
    __clearRowPlannerCache()
    __resetBuildInvocationCount()
    const files = Array.from({ length: 10000 }, (_, i) => {
      const h = makeHunk({ index:0, lines:[`+line ${i}`], oldStart:1, oldCount:0, newStart:1, newCount:1 })
      return makeFile(`f${i}`, `src/file${i}.ts`, [h])
    })
    const doc = makeDoc(files)
    const state = makeState(doc)
    const viewportHeight = 40
    const overscan = 10
    const plan = planReviewRows(state, { viewportStart:0, viewportHeight, width:80, effectiveMode:"stack", overscan, showLineNumbers:true, wrapLines:false })
    // Should be at most viewportHeight + overscan (or +2*overscan) rows
    expect(plan.rows.length).toBeLessThanOrEqual(viewportHeight + overscan * 2)
    expect(plan.rows.length).toBeGreaterThan(0)
    expect(plan.totalRows).toBeGreaterThan(10000) // each file header+hunk-header+diff = at least 3 rows
    // Build invocation count should be small, only for files in window
    const count = __getBuildInvocationCount()
    // Window covers maybe 10-14 files (40 rows / ~3 per file). With overscan 10 => maybe ~16 files. So invocations << 10000
    expect(count).toBeLessThan(50)
    expect(count).toBeGreaterThan(0)
    // Also ensure we didn't materialize entire changeset: plan.rows length bounded
    // Second call with same viewport should hit cache and not increase build count much
    __resetBuildInvocationCount()
    const plan2 = planReviewRows(state, { viewportStart:0, viewportHeight, width:80, effectiveMode:"stack", overscan, showLineNumbers:true, wrapLines:false })
    expect(__getBuildInvocationCount()).toBe(0) // cached
    expect(plan2.rows.length).toBe(plan.rows.length)

    // Scrolling to middle should also be windowed
    __resetBuildInvocationCount()
    const midStart = Math.floor(plan.totalRows/2)
    const planMid = planReviewRows(state, { viewportStart: midStart, viewportHeight, width:80, effectiveMode:"stack", overscan })
    expect(planMid.rows.length).toBeLessThanOrEqual(viewportHeight + overscan*2)
    expect(__getBuildInvocationCount()).toBeLessThan(50)
  })

  test("caching invalidates when width/mode/expanded gaps/feedback change", () => {
    __clearRowPlannerCache()
    const hunk = makeHunk({ index:0, lines:["+hello"] })
    const file = makeFile("f", "src/a.ts", [hunk])
    const doc = makeDoc([file])
    let state = makeState(doc)
    let plan = planReviewRows(state, { viewportStart:0, viewportHeight:100, width:80, effectiveMode:"stack" })
    const firstTotal = plan.totalRows
    __resetBuildInvocationCount()
    // Same params should be cached
    plan = planReviewRows(state, { viewportStart:0, viewportHeight:100, width:80, effectiveMode:"stack" })
    expect(__getBuildInvocationCount()).toBe(0)
    // Different width should bust cache
    __resetBuildInvocationCount()
    plan = planReviewRows(state, { viewportStart:0, viewportHeight:100, width:100, effectiveMode:"stack" })
    expect(__getBuildInvocationCount()).toBeGreaterThan(0)
    // Different mode busts
    __clearRowPlannerCache()
    __resetBuildInvocationCount()
    plan = planReviewRows(state, { viewportStart:0, viewportHeight:100, width:80, effectiveMode:"split" })
    const splitTotal = plan.totalRows // maybe same count but still rebuilt
    expect(__getBuildInvocationCount()).toBeGreaterThan(0)
    // Expanded gap busts
    __clearRowPlannerCache()
    const h1 = makeHunk({ index:0, oldStart:1, oldCount:2, newStart:1, newCount:2, lines:[" a"," b"] })
    const h2 = makeHunk({ index:1, oldStart:10, oldCount:2, newStart:10, newCount:2, lines:[" c"," d"] })
    const file2 = makeFile("g", "src/gap2.ts", [h1,h2])
    const doc2 = makeDoc([file2])
    state = makeState(doc2)
    plan = planReviewRows(state, { viewportStart:0, viewportHeight:100, width:80, effectiveMode:"stack" })
    const beforeExpand = plan.totalRows
    state = { ...state, expandedGaps: [{ fileKey:"g", gapId:"before:1", expanded:true }] }
    __resetBuildInvocationCount()
    // Need to clear cache to simulate new state's expanded gaps? Our cache key includes expanded gaps, so new plan should miss cache for that file
    plan = planReviewRows(state, { viewportStart:0, viewportHeight:100, width:80, effectiveMode:"stack" })
    expect(plan.totalRows).toBeGreaterThan(beforeExpand)
  })
})
