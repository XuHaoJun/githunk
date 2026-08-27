import { describe, expect, test } from "bun:test"
import { createReviewDocument, createReviewHunk } from "../../../src/review/core/document"
import { createReviewGeneration, createReviewIdentity } from "../../../src/review/core/identity"
import { createInitialReviewState } from "../../../src/review/core/state"
import { ReviewWorkspaceController } from "../../../src/ui/review-workspace/controller"
import { ReviewStreamPane } from "../../../src/ui/review-workspace/stream-pane"
import { planReviewRows } from "../../../src/ui/review-workspace/row-planner"
import { computeReviewLayout } from "../../../src/ui/review-workspace/layout"
import { createTestRenderer } from "@opentui/core/testing"
import { ReviewWorkspace } from "../../../src/ui/review-workspace/review-workspace"
import type { CliRenderer } from "@opentui/core"
import type { GitRunner } from "../../../src/git/runner"

function fakeRunner(): GitRunner { return { run: async () => ({ stdout:"", stderr:"", exitCode:0 }) } as unknown as GitRunner }

function makeDoc() {
  const identity = createReviewIdentity({ headRef:"refs/heads/feature", headOid:"a".repeat(40), baseRef:"refs/heads/main" })
  const generation = createReviewGeneration({ baseOid:"b".repeat(40), mergeBaseOid:"c".repeat(40), headOid:"a".repeat(40) })
  const h1 = createReviewHunk({ index:0, oldStart:1, oldCount:3, newStart:1, newCount:3, lines:[" ctx1", "-old2", "+new2", " ctx3"] })
  const h2 = createReviewHunk({ index:1, oldStart:10, oldCount:2, newStart:10, newCount:2, lines:[" ctx10", " ctx11"] })
  const files = [
    { key:"src/a.ts", path:"src/a.ts", kind:"modified" as const, oldBlobOid:"o1", newBlobOid:"n1", oldMode:"100644", newMode:"100644", contentId:"content-a", patchDigest:"patch-a", stats:{ additions:1, deletions:1 }, hunks:[h1,h2], source:"available" as const },
    { key:"src/b.ts", path:"src/b.ts", kind:"modified" as const, oldBlobOid:"o2", newBlobOid:"n2", oldMode:"100644", newMode:"100644", contentId:"content-b", patchDigest:"patch-b", stats:{ additions:1, deletions:1 }, hunks:[createReviewHunk({ index:0, oldStart:1, oldCount:2, newStart:1, newCount:2, lines:[" bctx1", " bctx2"] })], source:"available" as const },
  ]
  return createReviewDocument({ identity, generation, commits:[{ oid:"a".repeat(40), parents:[], author:"A", timestamp:0, subject:"s", body:"" }], files })
}

function makeLongLineDoc() {
  const identity = createReviewIdentity({ headRef:"refs/heads/feature", headOid:"b".repeat(40), baseRef:"refs/heads/main" })
  const generation = createReviewGeneration({ baseOid:"b".repeat(40), mergeBaseOid:"c".repeat(40), headOid:"b".repeat(40) })
  const long = "x".repeat(80)
  const h = createReviewHunk({ index:0, oldStart:1, oldCount:1, newStart:1, newCount:1, lines:[`+${long}`] })
  const files = [
    { key:"src/long.ts", path:"src/long.ts", kind:"modified" as const, oldBlobOid:"o1", newBlobOid:"n1", oldMode:"100644", newMode:"100644", contentId:"content-long", patchDigest:"patch-long", stats:{ additions:1, deletions:1 }, hunks:[h], source:"available" as const },
  ]
  return createReviewDocument({ identity, generation, commits:[{ oid:"b".repeat(40), parents:[], author:"A", timestamp:0, subject:"s", body:"" }], files })
}

describe("stream-pane integration — scrolling, selection, mouse, resize, mode", () => {
  test("scrolling updates passive semantic selection without bumping fileTopToken", async () => {
    const controller = new ReviewWorkspaceController({ runner: fakeRunner(), loadDocument: async () => makeDoc() })
    await controller.open("refs/heads/main")
    const initial = controller.state!
    const initialToken = initial.reveal.fileTopToken
    const pane = new ReviewStreamPane({
      controller,
      getLayout: () => computeReviewLayout(80, 24, "auto", true),
      getState: () => controller.state,
      viewportHeight: 10,
      width: 50,
      effectiveMode: "stack",
    })
    // Scroll by 3 rows
    pane.scrollBy(3)
    const after = controller.state!
    // Passive viewport-anchor should have updated selection but not bumped fileTopToken
    expect(after.reveal.fileTopToken).toBe(initialToken)
    // But selection may have changed to next visible file/hunk
    expect(after.selection).toBeDefined()
    // Validate pane viewport moved
    expect(pane.getViewportStart()).toBe(3)
  })

  test("sidebar reveal uses explicit token (fileTopToken increments)", async () => {
    const controller = new ReviewWorkspaceController({ runner: fakeRunner(), loadDocument: async () => makeDoc() })
    await controller.open("refs/heads/main")
    const before = controller.state!.reveal.fileTopToken
    const setup = await createTestRenderer({ width:80, height:24 })
    const ws = new ReviewWorkspace(setup.renderer as unknown as CliRenderer, controller, { onClose:()=>{} })
    const ok = ws.handleSidebarClick("src/b.ts")
    expect(ok).toBe(true)
    const after = controller.state!
    expect(after.reveal.fileTopToken).toBe(before + 1)
    expect(after.selection.fileKey).toBe("src/b.ts")
    ws.destroy()
    setup.renderer.destroy()
  })

  test("v selects inclusive source lines across wrapped terminal rows (deduplicated)", async () => {
    const controller = new ReviewWorkspaceController({ runner: fakeRunner(), loadDocument: async () => makeLongLineDoc() })
    await controller.open("refs/heads/main")
    const state = controller.state!
    const layout = computeReviewLayout(80,24,"auto", true)
    // Use narrow width to force wrapping into multiple rows for same source line
    const pane = new ReviewStreamPane({
      controller,
      getLayout: () => layout,
      getState: () => controller.state,
      viewportHeight: 10,
      width: 20,
      effectiveMode: "stack",
      wrapLines: true,
      showLineNumbers: false,
    })
    const plan = planReviewRows(state, { viewportStart:0, viewportHeight:10, width:20, effectiveMode:"stack", wrapLines:true, showLineNumbers:false })
    pane.setLastPlanForTest(plan)
    // Find diff rows for wrapped line (should be at least 2)
    const diffIndices = plan.rows.map((r,i)=> r.kind==="diff" ? i:null).filter(v=>v!==null) as number[]
    expect(diffIndices.length).toBeGreaterThan(1)
    const first = plan.start + diffIndices[0]!
    const second = plan.start + diffIndices[1]!
    // They should have same source line
    const addr1 = plan.rows[diffIndices[0]!]!
    const addr2 = plan.rows[diffIndices[1]!]!
    expect(addr1.newLine).toBe(addr2.newLine)
    // Begin range at first, end at second, should deduplicate to single line range
    pane.beginRangeAtViewportRow(first)
    pane.updateRangeEnd(second)
    const result = pane.endRangeSelection()
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.anchor.startLine).toBe(result.anchor.endLine)
      expect(result.anchor.fileKey).toBe("src/long.ts")
    }
  })

  test("mouse drag never enters headers/sidebar — gap/header rejected with visible explanation", async () => {
    const controller = new ReviewWorkspaceController({ runner: fakeRunner(), loadDocument: async () => makeDoc() })
    await controller.open("refs/heads/main")
    const state = controller.state!
    const pane = new ReviewStreamPane({
      controller,
      getLayout: () => computeReviewLayout(80,24,"auto", true),
      getState: () => controller.state,
      viewportHeight: 20,
      width: 50,
      effectiveMode:"stack",
    })
    const plan = planReviewRows(state, { viewportStart:0, viewportHeight:20, width:50, effectiveMode:"stack" })
    pane.setLastPlanForTest(plan)
    const gapIdx = plan.rows.findIndex(r=>r.kind==="gap")
    expect(gapIdx).toBeGreaterThan(-1)
    const gapGlobal = plan.start + gapIdx
    const diffIdx = plan.rows.findIndex(r=>r.kind==="diff")
    const diffGlobal = plan.start + diffIdx
    // Drag starting at gap should be rejected
    const res1 = pane.handleMouseDrag(gapGlobal, diffGlobal)
    expect(res1.ok).toBe(false)
    if (!res1.ok) expect(res1.reason).toMatch(/header|gap|feedback|only diff/)
    expect(pane.getLastMouseError()).toBeTruthy()
    // Drag between two diff rows within same file same side should succeed
    const diffIndices = plan.rows.map((r,i)=> r.kind==="diff" && r.fileKey==="src/a.ts" && r.newLine!==null ? i:null).filter(v=>v!==null) as number[]
    if (diffIndices.length>=2) {
      const a = plan.start + diffIndices[0]!
      const b = plan.start + diffIndices[1]!
      const res2 = pane.handleMouseDrag(a,b)
      expect(res2.ok).toBe(true)
    }
  })

  test("cross-file and cross-side drags are rejected with visible explanation", async () => {
    const controller = new ReviewWorkspaceController({ runner: fakeRunner(), loadDocument: async () => makeDoc() })
    await controller.open("refs/heads/main")
    const state = controller.state!
    const pane = new ReviewStreamPane({
      controller,
      getLayout: ()=>computeReviewLayout(80,24,"auto", true),
      getState: ()=>controller.state,
      viewportHeight:30,
      width:60,
      effectiveMode:"stack",
    })
    const plan = planReviewRows(state, { viewportStart:0, viewportHeight:30, width:60, effectiveMode:"stack" })
    pane.setLastPlanForTest(plan)
    // Find diff rows from different files
    const idxA = plan.rows.findIndex(r=>r.fileKey==="src/a.ts" && r.kind==="diff")
    const idxB = plan.rows.findIndex(r=>r.fileKey==="src/b.ts" && r.kind==="diff")
    expect(idxA).toBeGreaterThan(-1)
    expect(idxB).toBeGreaterThan(-1)
    const resCrossFile = pane.handleMouseDrag(plan.start+idxA, plan.start+idxB)
    expect(resCrossFile.ok).toBe(false)
    const reasonFile = !resCrossFile.ok ? resCrossFile.reason : pane.getLastMouseError()
    expect(reasonFile ?? "").toMatch(/cross-file/)
    // In src/a.ts hunk0: deletion (old) and addition (new) are different sides
    const delIdx = plan.rows.findIndex(r=>r.fileKey==="src/a.ts" && r.kind==="diff" && r.oldLine!==null && r.newLine===null)
    const addIdx = plan.rows.findIndex(r=>r.fileKey==="src/a.ts" && r.kind==="diff" && r.newLine!==null && r.oldLine===null)
    if (delIdx!==-1 && addIdx!==-1) {
      const resCrossSide = pane.handleMouseDrag(plan.start+delIdx, plan.start+addIdx)
      expect(resCrossSide.ok).toBe(false)
      const reasonSide = !resCrossSide.ok ? resCrossSide.reason : ""
      expect(reasonSide ?? "").toMatch(/cross-side/)
    }
  })

  test("resize preserves semantic anchor (top file remains visible)", async () => {
    const controller = new ReviewWorkspaceController({ runner: fakeRunner(), loadDocument: async () => makeDoc() })
    await controller.open("refs/heads/main")
    const setup = await createTestRenderer({ width:80, height:24 })
    const ws = new ReviewWorkspace(setup.renderer as unknown as CliRenderer, controller, { onClose:()=>{} })
    const beforeLayout = computeReviewLayout(80,24,"auto", true)
    // Scroll to second file top
    const state = controller.state!
    const planBefore = planReviewRows(state, { viewportStart:0, viewportHeight:beforeLayout.stream.height, width:beforeLayout.stream.width, effectiveMode:beforeLayout.effectiveMode })
    const bIdx = planBefore.rows.findIndex(r=>r.fileKey==="src/b.ts" && r.kind==="file-header")
    expect(bIdx).toBeGreaterThan(-1)
    const pane = ws.getStreamPane()
    pane.scrollTo(planBefore.start + bIdx)
    const beforeFile = controller.state?.selection.fileKey
    // Now resize
    ws.handleResize(100, 30)
    const afterFile = controller.state?.selection.fileKey
    // Selection should be preserved (semantic anchor)
    expect(afterFile).toBe(beforeFile)
    // Alternatively pane viewport should still contain src/b.ts at top
    const afterPlan = pane.getLastPlan()
    expect(afterPlan?.rows.some(r=>r.fileKey==="src/b.ts")).toBe(true)
    ws.destroy()
    setup.renderer.destroy()
  })

  test("split/stack changes preserve selection", async () => {
    const controller = new ReviewWorkspaceController({ runner: fakeRunner(), loadDocument: async () => makeDoc() })
    await controller.open("refs/heads/main")
    const setup = await createTestRenderer({ width:100, height:24 })
    const ws = new ReviewWorkspace(setup.renderer as unknown as CliRenderer, controller, { onClose:()=>{} })
    // Select file b
    ws.handleSidebarClick("src/b.ts")
    const before = controller.state!.selection.fileKey
    expect(before).toBe("src/b.ts")
    // Change layout to stack
    ws.handleKeyPress("2")
    expect(controller.state!.selection.fileKey).toBe("src/b.ts")
    // Change to split
    ws.handleKeyPress("1")
    expect(controller.state!.selection.fileKey).toBe("src/b.ts")
    ws.destroy()
    setup.renderer.destroy()
  })
})
