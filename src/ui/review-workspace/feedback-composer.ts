import type { ReviewWorkspaceController } from "./controller"
import type { ReviewAnchor, ReviewFeedbackDraft } from "../../review/core/types"
import { planReviewIntent } from "../../review/core/intents"

export type ComposerKind = "note" | "suggestion"
export type ComposerSeverity = "comment" | "blocking"
export type ComposerFocusTarget = "kind" | "severity" | "body" | "replacement" | "save" | "cancel"

const COMPOSER_CONTROLS: ComposerFocusTarget[] = ["kind", "severity", "body", "replacement", "save", "cancel"]

function getControllerNow(c: ReviewWorkspaceController): string {
  const holder = c as unknown as { nowImpl?: () => string }
  if (holder.nowImpl) return holder.nowImpl()
  return new Date().toISOString()
}

function getControllerRandomId(c: ReviewWorkspaceController): string {
  const holder = c as unknown as { randomIdImpl?: () => string }
  if (holder.randomIdImpl) return holder.randomIdImpl()
  return Math.random().toString(36).slice(2)
}

export class FeedbackComposer {
  private readonly controller: ReviewWorkspaceController
  private focusIndex = 0
  private controls: ComposerFocusTarget[] = [...COMPOSER_CONTROLS]
  private editingId: string | null = null

  constructor(options: { controller: ReviewWorkspaceController }) {
    this.controller = options.controller
  }

  isOpen(): boolean {
    const state = this.controller.state
    return state?.draft !== null && state?.draft !== undefined
  }

  getDraft(): ReviewFeedbackDraft | null {
    return this.controller.state?.draft ?? null
  }

  getFocus(): ComposerFocusTarget {
    const relevant = this.getRelevantControls()
    return relevant[this.focusIndex % relevant.length] ?? "body"
  }

  getRelevantControls(): ComposerFocusTarget[] {
    const draft = this.getDraft()
    if (!draft) return ["kind", "severity", "body", "save", "cancel"]
    const canShow = draft.kind === "suggestion" && draft.anchor.kind === "range" && draft.anchor.side === "new"
    if (canShow) return [...COMPOSER_CONTROLS]
    return COMPOSER_CONTROLS.filter((c) => c !== "replacement")
  }

  canShowReplacement(): boolean {
    const draft = this.getDraft()
    if (!draft) return false
    if (draft.kind !== "suggestion") return false
    if (draft.anchor.kind !== "range") return false
    if (draft.anchor.side !== "new") return false
    const state = this.controller.state
    if (!state) return false
    const file = state.document.files.find((f) => f.key === draft.anchor.fileKey)
    if (file && (file.source === "binary" || file.source === "too-large")) return false
    return true
  }

  open(anchor: ReviewAnchor, kind: ComposerKind = "note", severity: ComposerSeverity = "comment", body = "", replacement?: string): boolean {
    const state = this.controller.state
    if (!state) return false
    const file = state.document.files.find((f) => f.key === anchor.fileKey)
    if (!file) return false
    if (file.source === "binary" || file.source === "too-large") {
      if (anchor.kind === "range") return false
      if (kind === "suggestion") return false
      if (replacement !== undefined) return false
    }
    if (kind === "suggestion") {
      if (anchor.kind !== "range" || anchor.side !== "new") return false
    }
    try {
      const action = planReviewIntent(state, {
        type: "feedback/start-draft",
        anchor,
        kind,
        severity,
        body,
        ...(replacement !== undefined ? { replacement } : {}),
      })
      this.controller.dispatch(action)
      this.focusIndex = 0
      this.editingId = null
      this.controls = this.getRelevantControls()
      return true
    } catch {
      return false
    }
  }

  openForCurrentSelection(opts?: { rangeAnchor?: ReviewAnchor; kind?: ComposerKind; severity?: ComposerSeverity }): boolean {
    const state = this.controller.state
    if (!state) return false
    const fileKey = state.selection.fileKey
    if (!fileKey) return false
    const file = state.document.files.find((f) => f.key === fileKey)
    if (!file) return false
    if (opts?.rangeAnchor) {
      const ra = opts.rangeAnchor
      if (ra.fileKey === fileKey && ra.contentId === file.contentId) {
        if (file.source === "binary" || file.source === "too-large") {
          // fall through to file anchor
        } else {
          const kind = opts.kind ?? "note"
          const severity = opts.severity ?? "comment"
          return this.open(ra, kind, severity, "", kind === "suggestion" ? "" : undefined)
        }
      }
    }
    const fileAnchor: ReviewAnchor = { kind: "file", fileKey, contentId: file.contentId }
    const kind = opts?.kind ?? "note"
    const severity = opts?.severity ?? "comment"
    return this.open(fileAnchor, kind, severity)
  }

  startEdit(feedbackId: string): boolean {
    const state = this.controller.state
    if (!state) return false
    const fb = state.feedback.find((f) => f.id === feedbackId)
    if (!fb) return false
    try {
      const anchor = fb.anchor
      const action = planReviewIntent(state, {
        type: "feedback/start-draft",
        anchor,
        kind: fb.kind,
        severity: fb.severity,
        body: fb.body,
        ...(fb.replacement !== undefined ? { replacement: fb.replacement } : {}),
      })
      this.controller.dispatch(action)
      this.editingId = feedbackId
      this.focusIndex = 0
      return true
    } catch {
      return false
    }
  }

  isEditing(): boolean {
    return this.editingId !== null
  }

  getEditingId(): string | null {
    return this.editingId
  }

  setKind(kind: ComposerKind): boolean {
    const state = this.controller.state
    if (!state?.draft) return false
    const draftAnchor = state.draft.anchor
    const file = state.document.files.find((f) => f.key === draftAnchor.fileKey)
    if (file && (file.source === "binary" || file.source === "too-large") && kind === "suggestion") return false
    if (kind === "suggestion") {
      const anchor = state.draft.anchor
      if (anchor.kind !== "range" || anchor.side !== "new") return false
    }
    try {
      const extra = kind === "suggestion" && state.draft.replacement === undefined ? { replacement: "placeholder" } : {}
      const action = planReviewIntent(state, { type: "feedback/update-draft", kind, ...extra })
      this.controller.dispatch(action)
      this.controls = this.getRelevantControls()
      return true
    } catch {
      return false
    }
  }

  setSeverity(severity: ComposerSeverity): boolean {
    const state = this.controller.state
    if (!state?.draft) return false
    try {
      const action = planReviewIntent(state, { type: "feedback/update-draft", severity })
      this.controller.dispatch(action)
      return true
    } catch {
      return false
    }
  }

  setBody(body: string): boolean {
    const state = this.controller.state
    if (!state?.draft) return false
    try {
      const action = planReviewIntent(state, { type: "feedback/update-draft", body })
      this.controller.dispatch(action)
      return true
    } catch {
      return false
    }
  }

  setReplacement(replacement: string): boolean {
    const state = this.controller.state
    if (!state?.draft) return false
    if (!this.canShowReplacement()) return false
    try {
      this.controller.dispatch({ type: "feedback/update-draft", patch: { replacement } })
      return true
    } catch {
      return false
    }
  }

  handleTab(): boolean {
    if (!this.isOpen()) return false
    const relevant = this.getRelevantControls()
    this.focusIndex = (this.focusIndex + 1) % relevant.length
    return true
  }

  handleShiftTab(): boolean {
    if (!this.isOpen()) return false
    const relevant = this.getRelevantControls()
    this.focusIndex = (this.focusIndex - 1 + relevant.length) % relevant.length
    return true
  }

  handleKey(key: string): boolean {
    const normalized = key === "return" ? "enter" : key.toLowerCase()
    if (!this.isOpen()) return false
    if (normalized === "tab") {
      this.handleTab()
      return true
    }
    if (normalized === "shift+tab" || normalized === "s-tab") {
      this.handleShiftTab()
      return true
    }
    if (normalized === "escape") {
      this.cancel()
      return true
    }
    if (normalized === "ctrl+s" || normalized === "ctrl-s") {
      this.save()
      return true
    }
    if (normalized.includes("ctrl") && normalized.includes("s")) {
      this.save()
      return true
    }
    return false
  }

  handleKeyWithModifiers(key: string, modifiers?: { ctrl?: boolean }): boolean {
    if (modifiers?.ctrl && key.toLowerCase() === "s") {
      this.save()
      return true
    }
    return this.handleKey(key)
  }

  save(): boolean {
    const state = this.controller.state
    if (!state?.draft) return false
    const draft = state.draft
    if (this.editingId) {
      const fb = state.feedback.find((f) => f.id === this.editingId)
      if (!fb) {
        this.editingId = null
        return false
      }
      try {
        const patch: { body?: string; severity?: ComposerSeverity; replacement?: string } = {}
        if (draft.body !== fb.body) patch.body = draft.body
        if (draft.severity !== fb.severity) patch.severity = draft.severity
        const draftRep = draft.replacement
        const fbRep = fb.replacement
        if (draftRep !== fbRep) {
          if (draftRep !== undefined) patch.replacement = draftRep
        }
        if (Object.keys(patch).length === 0) {
          const cancelAction = planReviewIntent(state, { type: "feedback/cancel-draft" })
          this.controller.dispatch(cancelAction)
          this.editingId = null
          this.flush().catch(() => {})
          return true
        }
        const now = getControllerNow(this.controller)
        const action = planReviewIntent(state, { type: "feedback/edit", id: this.editingId, ...patch, updatedAt: now })
        this.controller.dispatch(action)
        try {
          const cancel = planReviewIntent(this.controller.state!, { type: "feedback/cancel-draft" })
          this.controller.dispatch(cancel)
        } catch {}
        this.editingId = null
        void this.flush()
        return true
      } catch {
        return false
      }
    }
    try {
      const now = getControllerNow(this.controller)
      const randomId = getControllerRandomId(this.controller)
      const action = planReviewIntent(state, { type: "feedback/create", id: randomId, createdAt: now })
      this.controller.dispatch(action)
      void this.flush()
      return true
    } catch {
      return false
    }
  }

  cancel(): boolean {
    const state = this.controller.state
    if (!state?.draft) return false
    try {
      const action = planReviewIntent(state, { type: "feedback/cancel-draft" })
      this.controller.dispatch(action)
      this.editingId = null
      this.focusIndex = 0
      void this.flush()
      return true
    } catch {
      return false
    }
  }

  async flush(): Promise<void> {
    const holder = this.controller as unknown as { flushDrafts?: () => Promise<void>; stateStore?: { flush: () => Promise<void> } }
    if (holder.flushDrafts) {
      await holder.flushDrafts()
    } else if (holder.stateStore) {
      await holder.stateStore.flush()
    }
  }

  clickSave(): boolean {
    return this.save()
  }

  clickCancel(): boolean {
    return this.cancel()
  }

  clickKind(kind: ComposerKind): boolean {
    return this.setKind(kind)
  }

  clickSeverity(severity: ComposerSeverity): boolean {
    return this.setSeverity(severity)
  }
}
