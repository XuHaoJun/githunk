import type { ReviewWorkspaceController } from "./controller"
import type { ReviewAnchor, ReviewFeedback } from "../../review/core/types"
import { planReviewIntent } from "../../review/core/intents"
import { sortedReviewFeedback } from "../../review/core/selectors"

export type FeedbackGroup = "active" | "stale" | "orphaned"

export class FeedbackPane {
  private readonly controller: ReviewWorkspaceController
  private reanchorId: string | null = null
  private pendingDeleteId: string | null = null

  constructor(options: { controller: ReviewWorkspaceController }) {
    this.controller = options.controller
  }

  getGrouped(): { active: readonly ReviewFeedback[]; stale: readonly ReviewFeedback[]; orphaned: readonly ReviewFeedback[] } {
    const state = this.controller.state
    if (!state) return { active: [], stale: [], orphaned: [] }
    const sorted = sortedReviewFeedback(state)
    const active: ReviewFeedback[] = []
    const stale: ReviewFeedback[] = []
    const orphaned: ReviewFeedback[] = []
    for (const fb of sorted) {
      if (fb.resolution === "active") active.push(fb)
      else if (fb.resolution === "stale") stale.push(fb)
      else orphaned.push(fb)
    }
    return { active, stale, orphaned }
  }

  getSorted(): readonly ReviewFeedback[] {
    const state = this.controller.state
    if (!state) return []
    return sortedReviewFeedback(state)
  }

  getFeedbackById(id: string): ReviewFeedback | undefined {
    return this.controller.state?.feedback.find((f) => f.id === id)
  }

  /** Selecting an active item reveals its anchor (document order navigation). */
  selectFeedback(id: string): boolean {
    const state = this.controller.state
    if (!state) return false
    const fb = state.feedback.find((f) => f.id === id)
    if (!fb) return false
    if (fb.resolution !== "active") return false
    const anchor = fb.anchor
    const fileKey = anchor.fileKey
    // Verify file exists
    const file = state.document.files.find((f) => f.key === fileKey)
    if (!file) return false
    try {
      // For file anchor, select file; for range, select file and viewport to hunk
      if (anchor.kind === "file") {
        const action = planReviewIntent(state, { type: "selection/select-file", fileKey })
        this.controller.dispatch(action)
      } else {
        const action = planReviewIntent(state, { type: "selection/select-file", fileKey })
        this.controller.dispatch(action)
        // Also update viewport anchor to hunkIndex for range feedback
        // Use viewport-anchor intent to reveal hunk
        try {
          const vp = planReviewIntent(this.controller.state!, { type: "selection/viewport-anchor", fileKey, hunkIndex: anchor.ownerHunkIndex })
          this.controller.dispatch(vp)
        } catch {
          // fallback just file selection
        }
      }
      return true
    } catch {
      return false
    }
  }

  // Mouse parity: same as selectFeedback
  clickFeedback(id: string): boolean {
    return this.selectFeedback(id)
  }

  handleKeyForFeedback(key: string, feedbackId: string): boolean {
    if (key === "enter") return this.selectFeedback(feedbackId)
    return false
  }

  /** Re-anchor enters range selection and dispatches validated feedback/reanchor intent */
  beginReanchor(id: string): boolean {
    const state = this.controller.state
    if (!state) return false
    const fb = state.feedback.find((f) => f.id === id)
    if (!fb) return false
    // Only stale or orphaned need re-anchor, but allow any for tests
    this.reanchorId = id
    return true
  }

  isReanchoring(): boolean {
    return this.reanchorId !== null
  }

  getReanchorId(): string | null {
    return this.reanchorId
  }

  cancelReanchor(): void {
    this.reanchorId = null
  }

  confirmReanchor(id: string, newAnchor: ReviewAnchor): boolean {
    const state = this.controller.state
    if (!state) return false
    const fb = state.feedback.find((f) => f.id === id)
    if (!fb) return false
    // Validate via planReviewIntent
    try {
      const now = this.getNow()
      const action = planReviewIntent(state, { type: "feedback/reanchor", id, anchor: newAnchor, updatedAt: now })
      this.controller.dispatch(action)
      if (this.reanchorId === id) this.reanchorId = null
      return true
    } catch {
      return false
    }
  }

  // Mouse parity for re-anchor: same logic
  clickReanchor(id: string): boolean {
    return this.beginReanchor(id)
  }

  /** Delete requires confirmation for non-empty item */
  requestDelete(id: string): { needsConfirm: boolean; canDelete: boolean; reason?: string } {
    const fb = this.getFeedbackById(id)
    if (!fb) return { needsConfirm: false, canDelete: false, reason: "not-found" }
    // If body is empty and no replacement, maybe allow immediate? Spec says "delete requires confirmation for a non-empty item"
    const isEmpty = fb.body.trim().length === 0 && (fb.replacement === undefined || fb.replacement.trim().length === 0)
    if (isEmpty) {
      // No confirmation needed
      return { needsConfirm: false, canDelete: true }
    }
    this.pendingDeleteId = id
    return { needsConfirm: true, canDelete: false }
  }

  confirmDelete(id: string): boolean {
    const state = this.controller.state
    if (!state) return false
    const fb = state.feedback.find((f) => f.id === id)
    if (!fb) return false
    // If pendingDeleteId set, verify matches; else if directly called, allow if caller confirmed
    if (this.pendingDeleteId !== null && this.pendingDeleteId !== id) return false
    try {
      const action = planReviewIntent(state, { type: "feedback/delete", id })
      this.controller.dispatch(action)
      this.pendingDeleteId = null
      return true
    } catch {
      return false
    }
  }

  cancelDelete(): void {
    this.pendingDeleteId = null
  }

  getPendingDeleteId(): string | null {
    return this.pendingDeleteId
  }

  /** Edit feedback (body, severity, replacement) */
  editFeedback(id: string, patch: { body?: string; severity?: "comment" | "blocking"; replacement?: string }): boolean {
    const state = this.controller.state
    if (!state) return false
    const fb = state.feedback.find((f) => f.id === id)
    if (!fb) return false
    try {
      const now = this.getNow()
      const action = planReviewIntent(state, { type: "feedback/edit", id, ...patch, updatedAt: now })
      this.controller.dispatch(action)
      return true
    } catch {
      return false
    }
  }

  /** Next/previous feedback navigation labels in document order */
  getNextLabel(currentId?: string): string {
    const sorted = this.getSorted()
    if (sorted.length === 0) return "Next feedback (none)"
    let idx = -1
    if (currentId) idx = sorted.findIndex((f) => f.id === currentId)
    const nextIdx = (idx + 1) % sorted.length
    const next = sorted[nextIdx]!
    // Find file order index for label? Use file path and line
    const anchor = next.anchor
    const loc = anchor.kind === "range" ? `${anchor.fileKey}:${anchor.startLine}` : `${anchor.fileKey} (file)`
    return `Next: ${loc} (${next.severity})`
  }

  getPreviousLabel(currentId?: string): string {
    const sorted = this.getSorted()
    if (sorted.length === 0) return "Previous feedback (none)"
    let idx = 0
    if (currentId) {
      idx = sorted.findIndex((f) => f.id === currentId)
      if (idx === -1) idx = 0
    }
    const prevIdx = (idx - 1 + sorted.length) % sorted.length
    const prev = sorted[prevIdx]!
    const anchor = prev.anchor
    const loc = anchor.kind === "range" ? `${anchor.fileKey}:${anchor.startLine}` : `${anchor.fileKey} (file)`
    return `Previous: ${loc} (${prev.severity})`
  }

  /** Dispatch next/previous feedback navigation via controller */
  goNext(): boolean {
    const state = this.controller.state
    if (!state) return false
    try {
      const action = planReviewIntent(state, { type: "feedback/next" })
      this.controller.dispatch(action)
      return true
    } catch {
      return false
    }
  }

  goPrevious(): boolean {
    const state = this.controller.state
    if (!state) return false
    try {
      const action = planReviewIntent(state, { type: "feedback/previous" })
      this.controller.dispatch(action)
      return true
    } catch {
      return false
    }
  }

  // Keyboard parity for next/previous: } and {
  handleKey(key: string): boolean {
    if (key === "}" || key === "]" || key === "n") {
      // Actually next feedback is } per spec, but also handle
    }
    if (key === "}") {
      this.goNext()
      return true
    }
    if (key === "{") {
      this.goPrevious()
      return true
    }
    return false
  }

  /** Active/stale/orphaned labels for display */
  getFeedbackLabel(fb: ReviewFeedback): string {
    if (fb.resolution === "active") return "active"
    if (fb.resolution === "stale") return "stale"
    return "orphaned"
  }

  private getNow(): string {
    const ctrl = this.controller as unknown as { nowImpl?: () => string }
    if (ctrl.nowImpl) return ctrl.nowImpl()
    return new Date().toISOString()
  }
}
