import type { ReviewWorkspaceController } from "./controller"
import type { ReviewState } from "../../review/core/state"
import { validateFinishReview, renderReviewArtifactMarkdown } from "../../review/core/artifact"
import type { ReviewDecision } from "../../review/core/artifact"
import type { ClipboardPort, CopyResult } from "../clipboard"
import { ClipboardService } from "../clipboard"
import type { ReviewStateStore } from "../../review/storage/review-state-store"
import type { ReviewArtifactStore } from "../../review/storage/review-artifact-store"
import { parseReviewArtifactV1 } from "../../review/storage/schemas"

export type FinishDecision = ReviewDecision

const REASON_MESSAGES: Record<string, string> = {
  "draft-open": "Finish blocked: composer is open — save or cancel the draft first",
  "commit-projection-invalid": "Finish blocked: commit projection cannot be submitted — switching to Aggregate",
  "feedback-needs-reanchor": "Finish blocked: some feedback is stale or orphaned — re-anchor or delete it",
  "approve-has-blocking-feedback": "Finish blocked: Approve cannot have blocking feedback",
  "request-changes-requires-blocking": "Finish blocked: Request Changes requires at least one blocking item",
  "comment-has-blocking-feedback": "Finish blocked: Comment cannot have blocking feedback",
  "comment-requires-summary-or-feedback": "Finish blocked: Comment requires a summary or at least one comment",
  "summary-required": "Finish blocked: summary cannot be empty for this decision",
}

function messageForReason(reason: string): string {
  return REASON_MESSAGES[reason] ?? `Finish blocked: ${reason}`
}

export class FinishDialog {
  private readonly controller: ReviewWorkspaceController
  private readonly clipboard: ClipboardPort
  private readonly stateStore: ReviewStateStore | undefined
  private readonly artifactStore: ReviewArtifactStore | undefined
  private _open = false
  private decision: FinishDecision = "comment"
  private summary = ""
  private lastError: string | undefined
  private lastMarkdown: string | undefined
  private lastCopyResult: CopyResult | undefined
  private lastArtifactId: string | undefined

  constructor(options: {
    controller: ReviewWorkspaceController
    clipboard: ClipboardPort
    stateStore?: ReviewStateStore
    artifactStore?: ReviewArtifactStore
  }) {
    this.controller = options.controller
    this.clipboard = options.clipboard
    this.stateStore = options.stateStore ?? (options.controller as unknown as { stateStore?: ReviewStateStore }).stateStore
    this.artifactStore = options.artifactStore ?? (options.controller as unknown as { artifactStore?: ReviewArtifactStore }).artifactStore
  }

  isOpen(): boolean {
    return this._open
  }

  open(): void {
    this._open = true
    this.lastError = undefined
  }

  close(): void {
    this._open = false
  }

  setDecision(decision: FinishDecision): void {
    this.decision = decision
  }

  getDecision(): FinishDecision {
    return this.decision
  }

  setSummary(summary: string): void {
    this.summary = summary
  }

  getSummary(): string {
    return this.summary
  }

  getState(): ReviewState | undefined {
    return this.controller.state
  }

  getCoverage(): { viewed: number; total: number; pending: number; changed: number } {
    const state = this.controller.state
    if (!state) return { viewed: 0, total: 0, pending: 0, changed: 0 }
    const total = state.document.files.length
    // Compute viewed via viewed records that match current contentId/path (active viewed)
    let viewed = 0
    let changed = 0
    for (const file of state.document.files) {
      const rec = state.viewed[file.key]
      if (!rec) continue
      if (rec.path === file.path && rec.contentId === file.contentId) viewed++
      else changed++
    }
    const pending = state.feedback.length
    return { viewed, total, pending, changed }
  }

  getValidation(): { ok: boolean; reason?: string; message?: string } {
    const state = this.controller.state
    if (!state) return { ok: false, reason: "no-state", message: "No review state" }
    const result = validateFinishReview(state, { decision: this.decision, summary: this.summary })
    if (result.ok) return { ok: true }
    return { ok: false, reason: result.reason, message: messageForReason(result.reason) }
  }

  getValidationMessage(): string {
    const v = this.getValidation()
    if (v.ok) return "Ready to finish"
    return v.message ?? `Finish blocked: ${v.reason}`
  }

  /** If in commit projection, automatically return to Aggregate or Since Last Review and ask to confirm */
  handleProjectionIfNeeded(): { switched: boolean; from?: string; to?: string; message?: string } {
    const state = this.controller.state
    if (!state) return { switched: false }
    if (state.projection.kind !== "commit") return { switched: false }
    // Switch to Aggregate or Since Last Review
    // Prefer Since Last Review if lastSubmission exists and its head is ancestor? But we don't have ancestor check here; just pick Aggregate for determinism
    // If lastSubmission exists, we can try since-last-review projection
    let target: { kind: "aggregate" } | { kind: "since-last-review"; fromHeadOid: string }
    if (state.lastSubmission) {
      target = { kind: "since-last-review", fromHeadOid: state.lastSubmission.headOid }
    } else {
      target = { kind: "aggregate" }
    }
    try {
      this.controller.dispatch({ type: "projection/set", projection: target as unknown as ReviewState["projection"] })
      return {
        switched: true,
        from: "commit",
        to: target.kind,
        message: `Switched from commit projection to ${target.kind} — confirm submission projection`,
      }
    } catch {
      return { switched: false }
    }
  }

  /** Derive deterministic markdown from persisted artifact */
  async getPersistedMarkdown(artifactId: string): Promise<string | undefined> {
    const state = this.controller.state
    if (!state || !this.artifactStore) return undefined
    const reviewId = state.document.identity.id
    try {
      const artifact = await this.artifactStore.load(reviewId, artifactId)
      if (!artifact) return undefined
      return renderReviewArtifactMarkdown(artifact)
    } catch {
      return undefined
    }
  }

  getLastMarkdown(): string | undefined {
    return this.lastMarkdown
  }

  getLastCopyResult(): CopyResult | undefined {
    return this.lastCopyResult
  }

  getLastArtifactId(): string | undefined {
    return this.lastArtifactId
  }

  getLastError(): string | undefined {
    return this.lastError
  }

  /**
   * Submit finish review.
   * - Shows coverage/pending counts via getCoverage()
   * - Validates via validateFinishReview, returns exact reason on failure
   * - Handles commit projection auto-switch
   * - On success calls finishReviewTransaction, then derives Markdown from persisted artifact and offers clipboard copy
   * - Never renders remote-submission success message
   * - Transaction failure preserves pending state; retry reuses artifact id
   */
  async submit(): Promise<{
    ok: boolean
    reason?: string
    message?: string
    markdown?: string
    copyResult?: CopyResult
    artifactId?: string
    switchedProjection?: boolean
  }> {
    const state = this.controller.state
    if (!state) return { ok: false, reason: "no-state", message: "No review state" }

    const projCheck = this.handleProjectionIfNeeded()
    if (projCheck.switched) {
      const msg = projCheck.message ?? "Switched from commit projection — confirm submission projection"
      return {
        ok: false,
        reason: "projection-switched",
        message: msg,
        switchedProjection: true,
      }
    }

    const validation = validateFinishReview(state, { decision: this.decision, summary: this.summary })
    if (!validation.ok) {
      this.lastError = messageForReason(validation.reason)
      return { ok: false, reason: validation.reason, message: this.lastError }
    }

    try {
      const nextState = await this.controller.finishReview({ decision: this.decision, summary: this.summary })
      const artifactId = nextState.lastSubmission?.artifactId ?? this.controller.state?.lastSubmission?.artifactId
      if (!artifactId) {
        this.lastArtifactId = undefined
        this.lastMarkdown = undefined
        this.lastCopyResult = undefined
        this._open = false
        return { ok: true }
      }
      this.lastArtifactId = artifactId
      let markdown: string | undefined
      if (this.artifactStore) {
        const reviewId = nextState.document.identity.id
        try {
          const artifact = await this.artifactStore.load(reviewId, artifactId)
          if (artifact) {
            markdown = renderReviewArtifactMarkdown(artifact)
          }
        } catch {}
        if (markdown === undefined) {
          try {
            const raw = await this.artifactStore.readRaw(reviewId, artifactId)
            if (raw) {
              const parsed = JSON.parse(raw)
              const res = parseReviewArtifactV1(parsed)
              if (res.ok) markdown = renderReviewArtifactMarkdown(res.value)
            }
          } catch {}
        }
      }

      if (markdown !== undefined) {
        this.lastMarkdown = markdown
        try {
          const svc = new ClipboardService(this.clipboard)
          const result = svc.copy(markdown)
          this.lastCopyResult = result
        } catch {
          this.lastCopyResult = { status: "blocked", bytes: Buffer.byteLength(markdown, "utf8") }
        }
      } else {
        this.lastMarkdown = undefined
        this.lastCopyResult = undefined
      }

      this.lastError = undefined
      this._open = false
      const out: { ok: boolean; reason?: string; message?: string; markdown?: string; copyResult?: CopyResult; artifactId?: string; switchedProjection?: boolean } = {
        ok: true,
        message: `Review finished — ${this.decision}`,
      }
      if (this.lastMarkdown !== undefined) out.markdown = this.lastMarkdown
      if (this.lastCopyResult !== undefined) out.copyResult = this.lastCopyResult
      if (this.lastArtifactId !== undefined) out.artifactId = this.lastArtifactId
      return out
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      this.lastError = msg
      return { ok: false, reason: "transaction-failed", message: msg }
    }
  }

  // For tests: simulate clipboard copy of markdown
  copyMarkdown(): CopyResult | undefined {
    if (!this.lastMarkdown) return undefined
    const svc = new ClipboardService(this.clipboard)
    return svc.copy(this.lastMarkdown)
  }

  // For UI: never show remote message
  getSuccessMessage(): string | undefined {
    if (!this.lastArtifactId) return undefined
    return `Review finished: ${this.lastArtifactId} — markdown copied via OSC52`
  }
}
