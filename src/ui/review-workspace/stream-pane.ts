import type { ReviewState } from "../../review/core/state"
import type { ReviewWorkspaceController } from "./controller"
import type { ReviewLayout, ReviewLayoutMode } from "./layout"
import { type ReviewRowPlan, planReviewRows, resolveRangeFromViewportSelection, sourceAddressAtViewportRow } from "./row-planner"
import type { ReviewRow } from "./row-planner"

export type StreamPaneOptions = Readonly<{
  controller: ReviewWorkspaceController
  getLayout: () => ReviewLayout
  getState: () => ReviewState | undefined
  viewportHeight?: number
  width?: number
  effectiveMode?: "split" | "stack"
  showLineNumbers?: boolean
  wrapLines?: boolean
}>

export type SelectionRangeAnchor = Readonly<{
  fileKey: string
  side: "old" | "new"
  startLine: number
  endLine: number
  ownerHunkIndex: number
}>

export class ReviewStreamPane {
  private viewportStart = 0
  private layoutMode: "split" | "stack"
  private width: number
  private viewportHeight: number
  private showLineNumbers: boolean
  private wrapLines: boolean
  private lastPlan: ReviewRowPlan | null = null
  private rangeAnchorStart: number | null = null
  private rangeAnchorEnd: number | null = null
  private lastMouseError: string | null = null
  private expandedSourceByGap = new Map<string, readonly string[]>()
  private semanticAnchor: { fileKey: string | null; hunkIndex: number } | null = null

  constructor(private readonly options: StreamPaneOptions) {
    const layout = options.getLayout()
    this.width = options.width ?? layout.stream.width
    this.viewportHeight = options.viewportHeight ?? layout.stream.height
    this.layoutMode = options.effectiveMode ?? layout.effectiveMode
    this.showLineNumbers = options.showLineNumbers ?? true
    this.wrapLines = options.wrapLines ?? false
  }

  getViewportStart(): number { return this.viewportStart }

  getLastPlan(): ReviewRowPlan | null { return this.lastPlan }

  getLastMouseError(): string | null { return this.lastMouseError }

  syncLayout(width: number, viewportHeight: number, mode: "split" | "stack"): void {
    this.width = width
    this.viewportHeight = viewportHeight
    this.layoutMode = mode
  }

  setLastPlanForTest(plan: ReviewRowPlan): void {
    this.lastPlan = plan
  }

  setViewportStart(start: number): void {
    const plan = this.ensurePlan()
    if (!plan) {
      this.viewportStart = Math.max(0, start)
      return
    }
    const maxStart = Math.max(0, plan.totalRows - this.viewportHeight)
    this.viewportStart = Math.max(0, Math.min(start, maxStart))
  }
  scrollBy(delta: number): void {
    this.setViewportStart(this.viewportStart + delta)
    this.updatePassiveSelection()
  }

  scrollTo(row: number): void {
    this.setViewportStart(row)
    this.updatePassiveSelection()
  }

  handleResize(newWidth: number, newHeight: number): void {
    // Preserve semantic anchor: remember current top visible file/hunk before resize
    const anchor = this.semanticAnchor ?? this.resolveTopSemanticAddress()
    this.width = newWidth
    this.viewportHeight = newHeight
    // After resize, recompute plan and restore viewport to keep same anchor visible at top
    const plan = this.ensurePlan(true)
    if (anchor && anchor.fileKey && plan) {
      const targetRow = this.findRowForAnchor(plan, anchor.fileKey, anchor.hunkIndex)
      if (targetRow !== null) {
        this.viewportStart = targetRow
      }
    }
    // No selection mutation beyond passive anchor preservation
  }

  handleModeChange(newMode: "split" | "stack"): void {
    const anchor = this.resolveTopSemanticAddress() ?? this.semanticAnchor
    this.layoutMode = newMode
    const plan = this.ensurePlan(true)
    if (anchor && anchor.fileKey && plan) {
      const targetRow = this.findRowForAnchor(plan, anchor.fileKey, anchor.hunkIndex)
      if (targetRow !== null) this.viewportStart = targetRow
    }
    // Preserve selection fileKey unchanged — controller selection remains, we don't mutate it
  }

  setWrapLines(wrap: boolean): void {
    const anchor = this.resolveTopSemanticAddress()
    this.wrapLines = wrap
    const plan = this.ensurePlan(true)
    if (anchor && anchor.fileKey && plan) {
      const targetRow = this.findRowForAnchor(plan, anchor.fileKey, anchor.hunkIndex)
      if (targetRow !== null) this.viewportStart = targetRow
    }
  }

  // Passive semantic selection: scrolling updates selection without reveal token bump
  private updatePassiveSelection(): void {
    const state = this.options.getState()
    const plan = this.ensurePlan()
    if (!state || !plan) return
    // Find top visible diff row's address
    for (let offset = 0; offset < plan.rows.length; offset++) {
      const globalRow = plan.start + offset
      if (globalRow < this.viewportStart) continue
      if (globalRow >= this.viewportStart + this.viewportHeight) break
      const row = plan.rows[offset]!
      if (row.kind !== "diff") continue
      if (row.oldLine===null && row.newLine===null) continue
      // Dispatch viewport-anchor intent without bumping reveal token
      const fileKey = row.fileKey
      const hunkIndex = row.hunkIndex ?? 0
      try {
        this.options.controller.dispatch({ type: "selection/viewport-anchor", fileKey, hunkIndex })
      } catch {}
      // Remember semantic anchor for resize preservation
      this.semanticAnchor = { fileKey, hunkIndex }
      break
    }
  }

  private resolveTopSemanticAddress(): { fileKey: string; hunkIndex: number } | null {
    const plan = this.lastPlan
    if (!plan) return null
    for (let offset = 0; offset < plan.rows.length; offset++) {
      const globalRow = plan.start + offset
      if (globalRow < this.viewportStart) continue
      const row = plan.rows[offset]!
      if (row.kind === "diff" || row.kind === "file-header" || row.kind === "hunk-header") {
        return { fileKey: row.fileKey, hunkIndex: row.hunkIndex ?? 0 }
      }
    }
    return null
  }

  private findRowForAnchor(plan: ReviewRowPlan, fileKey: string, hunkIndex: number): number | null {
    // Find earliest row index matching fileKey and hunkIndex (or file header if hunk 0)
    for (let i = 0; i < plan.rows.length; i++) {
      const r = plan.rows[i]!
      if (r.fileKey === fileKey) {
        // Prefer hunk header or first diff of that hunk
        if (r.hunkIndex === hunkIndex) return plan.start + i
        if (hunkIndex===0 && r.kind==="file-header") return plan.start + i
      }
    }
    // Fallback: search globally via plan is windowed, may not contain anchor if far outside window.
    // For preservation, we need totalRows-level search: we can approximate by scanning all files' offsets?
    // Instead, compute global row via plan's totalRows? For simplicity, if not in window, keep current viewportStart
    return null
  }

  // Sidebar reveal uses explicit token — handled by controller via selection/select-file (already bumps token)
  // This pane does not handle sidebar directly; exposed for tests to verify reveal token behavior

  // Range selection via `v`
  beginRangeAtViewportRow(viewportRow: number): { ok: boolean; reason?: string } {
    const plan = this.ensurePlan()
    if (!plan) return { ok:false, reason:"no plan" }
    const row = plan.rows[viewportRow - plan.start]
    if (!row) return { ok:false, reason:"row outside window" }
    if (row.kind !== "diff" || (row.oldLine===null && row.newLine===null)) {
      return { ok:false, reason:"range can only start on diff lines with source line" }
    }
    this.rangeAnchorStart = viewportRow
    this.rangeAnchorEnd = viewportRow
    return { ok:true }
  }

  updateRangeEnd(viewportRow: number): { ok: boolean; reason?: string } {
    if (this.rangeAnchorStart===null) return { ok:false, reason:"no active range" }
    this.rangeAnchorEnd = viewportRow
    return { ok:true }
  }

  endRangeSelection(): { ok: true; anchor: SelectionRangeAnchor } | { ok:false; reason: string } {
    if (this.rangeAnchorStart===null || this.rangeAnchorEnd===null) return { ok:false, reason:"no active range" }
    const plan = this.ensurePlan()
    if (!plan) return { ok:false, reason:"no plan" }
    const result = resolveRangeFromViewportSelection(plan, this.rangeAnchorStart, this.rangeAnchorEnd)
    this.rangeAnchorStart=null
    this.rangeAnchorEnd=null
    if (!result.ok) return { ok:false, reason: result.reason }
    return { ok:true, anchor: result.anchor }
  }

  isRangeActive(): boolean { return this.rangeAnchorStart!==null }

  // Mouse drag — never enters headers/sidebar, only diff rows, rejects cross-file/side
  handleMouseDrag(startViewportRow: number, endViewportRow: number): { ok:true; anchor: SelectionRangeAnchor } | { ok:false; reason: string } {
    this.lastMouseError = null
    const plan = this.ensurePlan()
    if (!plan) {
      const err="no plan"
      this.lastMouseError=err
      return { ok:false, reason: err }
    }
    // Check header/sidebar intrusion: if either row is header/gap/feedback/binary → reject with visible explanation
    const startRow = plan.rows[startViewportRow - plan.start]
    const endRow = plan.rows[endViewportRow - plan.start]
    if (!startRow || !endRow) {
      const err="drag outside visible window — headers and sidebar are not selectable"
      this.lastMouseError=err
      return { ok:false, reason: err }
    }
    if (startRow.kind!=="diff" || endRow.kind!=="diff") {
      const err="mouse selection cannot include headers, gaps, or feedback rows — only diff lines are selectable"
      this.lastMouseError=err
      return { ok:false, reason: err }
    }
    if ((startRow.oldLine===null && startRow.newLine===null) || (endRow.oldLine===null && endRow.newLine===null)) {
      const err="diff rows without source line cannot be selected"
      this.lastMouseError=err
      return { ok:false, reason: err }
    }
    const result = resolveRangeFromViewportSelection(plan, startViewportRow, endViewportRow)
    if (!result.ok) {
      this.lastMouseError=result.reason
      return { ok:false, reason: result.reason }
    }
    return { ok:true, anchor: result.anchor }
  }

  // Gap expansion
  async expandGapAtViewportRow(viewportRow: number): Promise<{ ok: boolean; reason?: string }> {
    const plan = this.ensurePlan()
    if (!plan) return { ok:false, reason:"no plan" }
    const row = plan.rows[viewportRow - plan.start]
    if (!row) return { ok:false, reason:"row outside window" }
    if (row.kind!=="gap") return { ok:false, reason:"not a gap row" }
    const gapId = `before:${row.hunkIndex}`
    // Dispatch through controller
    try {
      await this.options.controller.expandGap(row.fileKey, gapId)
      return { ok:true }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return { ok:false, reason: msg }
    }
  }

  async handleGapClick(fileKey: string, gapId: string): Promise<void> {
    await this.options.controller.expandGap(fileKey, gapId)
  }

  // Explicit generation-qualified helper for tests
  getPlanForState(state: ReviewState): ReviewRowPlan {
    this.ensurePlan(true)
    return this.ensurePlan()!
  }

  private ensurePlan(force=false): ReviewRowPlan | null {
    const state = this.options.getState()
    if (!state) return null
    if (this.lastPlan && !force) {
      // Check if state revision or layout changed; for simplicity re-use lastPlan if viewport same?
      // We'll always recompute for correctness unless width/height unchanged and state revision unchanged
      // For now recompute if not forced but caching inside planReviewRows handles perf
    }
    const plan = planReviewRows(state, {
      viewportStart: this.viewportStart,
      viewportHeight: this.viewportHeight,
      width: this.width,
      effectiveMode: this.layoutMode,
      showLineNumbers: this.showLineNumbers,
      wrapLines: this.wrapLines,
      expandedSourceByGap: this.expandedSourceByGap,
    })
    this.lastPlan = plan
    return plan
  }

  // For gap expansion caching injection
  setExpandedSource(fileKey: string, gapId: string, lines: readonly string[]): void {
    this.expandedSourceByGap.set(`${fileKey}:${gapId}`, lines)
  }

  clearExpandedSource(): void {
    this.expandedSourceByGap.clear()
  }

  // Expose plan helper for range tests
  getCurrentRows(): readonly ReviewRow[] {
    return this.lastPlan?.rows ?? []
  }
}
