import { createHash } from "node:crypto"
import { parseReviewArtifactV1 } from "../../review/storage/schemas"
import type { GitRunner } from "../../git/runner"
import type { ReviewDocument, ReviewProjection, SourceContextRequest, ReviewFile } from "../../review/core/types"
import type { ReviewState, ViewedRecord, ExpandedGap, ReviewSelection } from "../../review/core/state"
import { createInitialReviewState } from "../../review/core/state"
import { reconcileReviewState } from "../../review/core/reconcile"
import { reduceReviewState } from "../../review/core/reducer"
import type { ReviewAction } from "../../review/core/actions"
import type { ReviewIntent } from "../../review/core/intents"
import { planReviewIntent } from "../../review/core/intents"
import { loadReviewDocument } from "../../review/git/load-review-document"
import { loadSourceContext, type SourceContextOutcome } from "../../review/git/load-source-context"
import { ReviewStateStore, persistedFromReviewState } from "../../review/storage/review-state-store"
import { ReviewArtifactStore, finishReviewTransaction } from "../../review/storage/review-artifact-store"
import { currentBranchRef, inferReviewBase, resolveRefOid, reviewBaseCandidates } from "../../git/base-inference"
import { emptyReviewDatabaseV2 } from "../../review/storage/schemas"
import type { ReviewDecision } from "../../review/core/artifact"
import { buildReviewArtifact, validateFinishReview } from "../../review/core/artifact"
import type { ReviewArtifactV1 } from "../../review/core/artifact"
import {
  type ReviewWorkspaceError,
  classifyLoadError,
  createCorruptStateError,
  createStorageError,
} from "./error-state"
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`
  }
  return JSON.stringify(value)
}

function normalizeActiveProjection(
  projection: ReviewProjection,
): Extract<ReviewProjection, { kind: "aggregate" }> {
  return { kind: "aggregate" }
}

export type ReviewWorkspaceControllerOptions = {
  readonly runner: GitRunner
  readonly stateStore?: ReviewStateStore
  readonly artifactStore?: ReviewArtifactStore
  readonly loadDocument?: (baseRef: string) => Promise<ReviewDocument>
  readonly loadSourceContextImpl?: (request: SourceContextRequest) => Promise<SourceContextOutcome>
  readonly now?: () => string
  readonly randomId?: () => string
}

type Listener = (state: ReviewState | undefined) => void

export class ReviewWorkspaceController {
  private readonly runner: GitRunner
  private readonly stateStore: ReviewStateStore | undefined
  private readonly artifactStore: ReviewArtifactStore | undefined
  private readonly loadDocumentImpl: (baseRef: string) => Promise<ReviewDocument>
  private readonly loadSourceContextImpl: ((request: SourceContextRequest) => Promise<SourceContextOutcome>) | undefined
  private readonly nowImpl: () => string
  private readonly randomIdImpl: () => string
  private _state: ReviewState | undefined
  private _error: ReviewWorkspaceError | undefined
  private listeners = new Set<Listener>()
  private requestId = 0
  private destroyed = false
  private activeReviewId: string | undefined
  private activeGenerationId: string | undefined
  private baseRef: string | undefined
  private sourceContextCache = new Map<string, readonly string[]>()
  private pendingGapRequests = new Map<string, number>()
  private gapRequestCounter = 0
  constructor(options: ReviewWorkspaceControllerOptions) {
    this.runner = options.runner
    this.stateStore = options.stateStore
    this.artifactStore = options.artifactStore
    this.loadDocumentImpl = options.loadDocument ?? ((baseRef: string) => loadReviewDocument(options.runner, baseRef))
    this.loadSourceContextImpl = options.loadSourceContextImpl
    this.nowImpl = options.now ?? (() => new Date().toISOString())
    this.randomIdImpl = options.randomId ?? (() => {
      try {
        return crypto.randomUUID()
      } catch {
        return Math.random().toString(36).slice(2)
      }
    })
  }

  get state(): ReviewState | undefined {
    return this._state
  }

  get error(): ReviewWorkspaceError | undefined {
    return this._error
  }

  get reviewId(): string | undefined {
    return this.activeReviewId
  }

  get generationId(): string | undefined {
    return this.activeGenerationId
  }
  get base(): string | undefined {
    return this.baseRef
  }


  clearError(): void {
    if (this._error === undefined) return
    this._error = undefined
    this.publish()
  }

  get refreshGeneration(): () => Promise<void> {
    return async () => {
      if (this.baseRef === undefined || this.destroyed) return
      const token = ++this.requestId
      const capturedGeneration = this.activeGenerationId
      const capturedReviewId = this.activeReviewId
      const capturedBase = this.baseRef
      // Capture for qualified validation
      const qualified = { requestId: token, reviewId: capturedReviewId, generationId: capturedGeneration }
      try {
        // Build new document off-screen (no publish yet)
        const doc = await this.loadDocumentImpl(capturedBase)
        if (qualified.reviewId !== undefined && doc.identity.id !== qualified.reviewId) return
        // A same-generation response is still useful after a failed load.
        // Storage errors require retrying the pending semantic write before
        // they may be cleared; load errors only need a successful response.
        if (qualified.generationId !== undefined && doc.generation.id === qualified.generationId) {
          if (this._error?.kind === "storage") {
            try {
              await this.persistState()
            } catch {
              return
            }
          }
          if (this._error !== undefined) {
            this._error = undefined
            this.publish()
          }
          return
        }
        this.sourceContextCache.clear()
        this.pendingGapRequests.clear()
        // Reconcile off-screen exactly once, then atomically publish the
        // complete aggregate state for this generation.
        const currentState = this._state
        const nextState = currentState === undefined
          ? createInitialReviewState(doc)
          : reconcileReviewState(currentState, doc)
        if (this.destroyed || token !== this.requestId) return
        // Atomic swap: publish once
        this._state = nextState
        this.activeReviewId = doc.identity.id
        this.activeGenerationId = doc.generation.id
        this._error = undefined
        this.publish()
        await this.persistState()
        // If persist failed, error will be set inside persistState
      } catch (err) {
        if (token !== this.requestId) return
        // Failure retains last complete document, updates error only
        const typed = classifyLoadError(err)
        this._error = typed
        this.publish()
      }
    }
  }

  async open(baseRef?: string): Promise<ReviewState> {
    if (this.destroyed) throw new Error("controller destroyed")
    const token = ++this.requestId
    let resolvedBase = baseRef
    if (resolvedBase === undefined) {
      try {
        resolvedBase = await this.resolveBase()
      } catch (err) {
        const typed = classifyLoadError(err)
        this._error = typed
        this.publish()
        throw err
      }
    }
    if (this.destroyed || token !== this.requestId) throw new Error("open cancelled")

    let doc: ReviewDocument
    try {
      doc = await this.loadDocumentImpl(resolvedBase)
    } catch (err) {
      if (token !== this.requestId) throw new Error("open cancelled")
      const typed = classifyLoadError(err)
      this._error = typed
      this.publish()
      throw err
    }
    if (this.destroyed || token !== this.requestId) throw new Error("open cancelled")
    this.sourceContextCache.clear()
    this.pendingGapRequests.clear()

    // Load persisted state and detect corrupt quarantine
    let persistedState: ReviewState | undefined
    let corruptError: ReviewWorkspaceError | undefined
    try {
      const db = this.stateStore ? await this.stateStore.load() : emptyReviewDatabaseV2()
      // Detect quarantine warning even when db is empty
      const warning = this.stateStore?.quarantineWarning
      if (warning) {
        // Extract quarantine path from warning string
        const pathMatch = warning.match(/moved to (\S+)/)
        const qPath = pathMatch?.[1] ?? warning
        corruptError = createCorruptStateError(qPath, warning)
      }
      const persisted = db.reviews[doc.identity.id]
      if (persisted !== undefined) {
        const initial = createInitialReviewState(doc)
        const reconstructed: ReviewState = {
          ...initial,
          selection: persisted.selection as ReviewSelection,
          lineSelection: persisted.lineSelection,
          filter: persisted.filter,
          viewed: persisted.viewed as Record<string, ViewedRecord>,
          feedback: persisted.feedback,
          draft: persisted.draft,
          expandedGaps: persisted.expandedGaps as readonly ExpandedGap[],
          lastSubmission: persisted.lastSubmission,
          projection: normalizeActiveProjection(persisted.projection as ReviewProjection),
          revision: 0,
        }
        persistedState = reconcileReviewState(reconstructed, doc)
      }
    } catch (err) {
      // Persisted load failure -> storage error but still allow open with fresh state
      const typed = createStorageError(err instanceof Error ? err.message : String(err))
      corruptError = typed
      persistedState = undefined
    }

    const nextState = persistedState ?? createInitialReviewState(doc)
    const finalState = persistedState ? persistedState : nextState

    if (token !== this.requestId) throw new Error("open cancelled")

    this._state = finalState
    this.baseRef = resolvedBase
    this.activeReviewId = doc.identity.id
    this.activeGenerationId = doc.generation.id
    // Preserve corrupt/storage warning as error while still publishing document
    // Empty review and detached snapshot are status, not errors -> do not override corrupt error
    this._error = corruptError
    this.publish()
    try {
      await this.persistState()
    } catch (err) {
      // Keep a quarantine warning visible even if replacing the malformed
      // file itself also fails.
      void err
      if (corruptError) {
        this._error = corruptError
        this.publish()
      }
    }
    // If corruptError exists, it remains; otherwise success clears error
    return finalState
  }

  dispatch(action: ReviewAction): void {
    const current = this._state
    if (current === undefined) return
    const next = reduceReviewState(current, action)
    if (next === current) return
    this._state = next
    this.publish()
    void this.persistState().catch(() => undefined)
    if (action.type === "feedback/update-draft" || action.type === "feedback/start-draft") {
      if (this.activeReviewId && this.stateStore) {
        const draft = this._state.draft
        this.stateStore.saveDraftDebounced(this.activeReviewId, draft)
      }
    }
  }

  dispatchIntent(intent: ReviewIntent): boolean {
    const current = this._state
    if (current === undefined) return false
    try {
      const action = planReviewIntent(current, intent)
      this.dispatch(action)
      return true
    } catch {
      return false
    }
  }

  async flushDrafts(): Promise<void> {
    if (!this.stateStore) return
    await this.stateStore.flush()
  }
  async finishReview(input: { decision: ReviewDecision; summary: string }): Promise<ReviewState> {
    if (this._state === undefined) throw new Error("no review state")
    if (!this.stateStore || !this.artifactStore) throw new Error("stores required for finish")
    // Validate before any transaction work.  In particular, invalid drafts or
    // projections must not create an artifact or marker.
    const validation = validateFinishReview(this._state, input)
    if (!validation.ok) throw new Error(`cannot finish review: ${validation.reason}`)
    const reviewId = this._state.document.identity.id
    const generationId = this._state.document.generation.id
    let reuseArtifact: ReviewArtifactV1 | undefined
    let artifactIdFromMarker: string | undefined
    try {
      const db = await this.stateStore.load()
      const marker = db.reviews[reviewId]?.submissionInProgress
      if (marker) {
        artifactIdFromMarker = marker.artifactId
        const raw = await this.artifactStore.readRaw(reviewId, marker.artifactId)
        if (raw !== undefined) {
          const digest = createHash("sha256").update(raw, "utf8").digest("hex")
          if (digest === marker.digest) {
            const parsed: unknown = JSON.parse(raw)
            const res = parseReviewArtifactV1(parsed)
            if (res.ok) {
              const artifact = res.value
              const expected = buildReviewArtifact(this._state!, {
                id: artifact.id,
                submittedAt: artifact.submittedAt,
                decision: input.decision,
                summary: input.summary,
              })
              // Reuse only when the marker's immutable artifact represents
              // the complete current semantic state, not merely the same IDs.
              if (stableJson(expected) === stableJson(artifact)) {
                reuseArtifact = artifact
              } else {
                artifactIdFromMarker = undefined
              }
          }
        }
      }
      }
    } catch {}
    if (!this._state || this._state.document.identity.id !== reviewId || this._state.document.generation.id !== generationId) {
      throw new Error("review changed while finishing")
    }
    if (reuseArtifact) {
      const next = await finishReviewTransaction({
        stateStore: this.stateStore,
        artifactStore: this.artifactStore,
        reviewState: this._state,
        artifact: reuseArtifact,
      })
      this._state = next
      this.publish()
      return next
    }
    const artifactId = artifactIdFromMarker ?? this.randomIdImpl()
    const submittedAt = this.nowImpl()
    const artifact = buildReviewArtifact(this._state, { id: artifactId, submittedAt, decision: input.decision, summary: input.summary })
    const next = await finishReviewTransaction({
      stateStore: this.stateStore,
      artifactStore: this.artifactStore,
      reviewState: this._state,
      artifact,
    })
    this._state = next
    this.publish()
    return next
  }

  async expandGap(fileKey: string, gapId: string): Promise<void> {
    const current = this._state
    if (!current) throw new Error("no review state")
    const file = current.document.files.find((candidate) => candidate.key === fileKey)
    if (!file) throw new Error(`file not found: ${fileKey}`)
    const beforeExpanded = current.expandedGaps.some((gap) => gap.fileKey === fileKey && gap.gapId === gapId && gap.expanded)
    this.dispatch({ type: "gap/toggle", fileKey, gapId })
    const after = this._state
    const nowExpanded = after?.expandedGaps.some((gap) => gap.fileKey === fileKey && gap.gapId === gapId && gap.expanded) ?? false
    if (!nowExpanded || beforeExpanded) return
    await this.loadExpandedGapSource(fileKey, gapId, after!.document.identity.id, after!.document.generation.id)
  }

  async ensureExpandedGapSource(fileKey: string, gapId: string): Promise<void> {
    const current = this._state
    if (!current) return
    if (!current.expandedGaps.some((gap) => gap.fileKey === fileKey && gap.gapId === gapId && gap.expanded)) return
    const file = current.document.files.find((candidate) => candidate.key === fileKey)
    if (!file) return
    await this.loadExpandedGapSource(fileKey, gapId, current.document.identity.id, current.document.generation.id)
  }

  private async loadExpandedGapSource(fileKey: string, gapId: string, reviewId: string, generationId: string): Promise<void> {
    if (this.destroyed) return
    const current = this._state
    if (!current) return
    const file = current.document.files.find((candidate) => candidate.key === fileKey)
    if (!file) return
    const parsed = gapId.match(/^(before|trailing):(\d+)$/)
    if (!parsed) throw new Error(`invalid gapId: ${gapId}`)
    const position = parsed[1] as "before" | "trailing"
    const hunkIndex = Number(parsed[2])
    const gapAddress = this.resolveGapAddress(file, position, hunkIndex)
    if (!gapAddress) return
    const side: "old" | "new" = file.kind === "deleted" ? "old" : "new"
    const range = side === "old" ? gapAddress.oldRange : gapAddress.newRange
    const cacheKey = `${file.contentId}:${side}:${range[0]}:${range[1]}`
    if (this.sourceContextCache.has(cacheKey) || this.pendingGapRequests.has(cacheKey)) return
    const request: SourceContextRequest = {
      reviewId,
      generationId,
      fileKey,
      side,
      startLine: range[0],
      endLine: range[1],
    }
    const requestToken = ++this.gapRequestCounter
    this.pendingGapRequests.set(cacheKey, requestToken)
    const collapseIfCurrent = (): void => {
      const latest = this._state
      if (!latest || this.destroyed || latest.document.identity.id !== reviewId || latest.document.generation.id !== generationId) return
      if (latest.expandedGaps.some((gap) => gap.fileKey === fileKey && gap.gapId === gapId && gap.expanded)) {
        this.dispatch({ type: "gap/toggle", fileKey, gapId })
      }
    }
    let outcome: SourceContextOutcome
    try {
      outcome = this.loadSourceContextImpl
        ? await this.loadSourceContextImpl(request)
        : await loadSourceContext(this.runner, current.document, request)
    } catch {
      if (this.pendingGapRequests.get(cacheKey) === requestToken) {
        this.pendingGapRequests.delete(cacheKey)
        collapseIfCurrent()
      }
      return
    }

    const latest = this._state
    const ownsRequest = this.pendingGapRequests.get(cacheKey) === requestToken
    if (this.destroyed || !latest || latest.document.identity.id !== reviewId || latest.document.generation.id !== generationId || !latest.document.files.some((candidate) => candidate.key === fileKey) || !ownsRequest) {
      if (ownsRequest) this.pendingGapRequests.delete(cacheKey)
      return
    }
    this.pendingGapRequests.delete(cacheKey)
    if (!outcome.ok) {
      collapseIfCurrent()
      return
    }
    const expectedLineCount = request.endLine - request.startLine + 1
    if (outcome.result.reviewId !== reviewId || outcome.result.generationId !== generationId || outcome.result.fileKey !== fileKey || outcome.result.side !== side || outcome.result.startLine !== request.startLine || outcome.result.lines.length === 0 || outcome.result.lines.length > expectedLineCount) {
      collapseIfCurrent()
      return
    }
    this.sourceContextCache.set(cacheKey, outcome.result.lines)
    this.publish()
  }
  getExpandedGapLines(fileKey: string, gapId: string): readonly string[] | undefined {
    const current = this._state
    if (!current) return undefined
    const file = current.document.files.find(f => f.key === fileKey)
    if (!file) return undefined
    const parsed = gapId.match(/^(before|trailing):(\d+)$/)
    if (!parsed) return undefined
    const position = parsed[1] as "before" | "trailing"
    const hunkIndex = Number(parsed[2])
    const gapAddress = this.resolveGapAddress(file, position, hunkIndex)
    if (!gapAddress) return undefined
    const side: "old" | "new" = file.kind === "deleted" ? "old" : "new"
    const range = side === "old" ? gapAddress.oldRange : gapAddress.newRange
    const cacheKey = `${file.contentId}:${side}:${range[0]}:${range[1]}`
    return this.sourceContextCache.get(cacheKey)
  }

  getExpandedSourceByGap(): ReadonlyMap<string, readonly string[]> {
    // Renderer-neutral source map keyed by `${fileKey}:${gapId}`.
    const map = new Map<string, readonly string[]>()
    const current = this._state
    if (!current) return map
    for (const gap of current.expandedGaps) {
      if (!gap.expanded) continue
      const lines = this.getExpandedGapLines(gap.fileKey, gap.gapId)
      if (lines) map.set(`${gap.fileKey}:${gap.gapId}`, lines)
    }
    return map
  }

  clearSourceContextCache(): void {
    this.sourceContextCache.clear()
  }

  private resolveGapAddress(file: ReviewFile, position: "before" | "trailing", hunkIndex: number): { oldRange: [number, number]; newRange: [number, number]; lineCount: number } | null {
    if (position === "before") {
      if (hunkIndex <=0 || hunkIndex >= file.hunks.length) return null
      const prev = file.hunks[hunkIndex-1]!
      const cur = file.hunks[hunkIndex]!
      const gapOld = cur.oldStart - (prev.oldStart + prev.oldCount)
      const gapNew = cur.newStart - (prev.newStart + prev.newCount)
      let lineCount = gapOld
      if (gapOld !== gapNew && gapOld>0 && gapNew>0) lineCount = Math.min(gapOld,gapNew)
      else if (gapOld<=0 && gapNew>0) lineCount = gapNew
      if (lineCount<=0) return null
      const oldStart = prev.oldStart + prev.oldCount
      const oldEnd = cur.oldStart -1
      const newStart = prev.newStart + prev.newCount
      const newEnd = cur.newStart -1
      return { oldRange: [oldStart, oldEnd] as [number,number], newRange: [newStart,newEnd] as [number,number], lineCount }
    } else {
      // trailing not computable without source totals; return null to indicate unavailable
      return null
    }
  }
  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  loadSourceContext(): Promise<unknown> {
    return Promise.resolve(undefined)
  }

  async destroy(): Promise<void> {
    if (this.destroyed) return
    this.destroyed = true
    this.listeners.clear()
    this.requestId++
    this.pendingGapRequests.clear()
    this.sourceContextCache.clear()
    if (this.activeReviewId && this.stateStore) {
      await this.stateStore.flush().catch(() => undefined)
    }
  }

  private publish(): void {
    for (const l of this.listeners) {
      try { l(this._state) } catch {}
    }
  }

  private async persistState(): Promise<void> {
    if (!this.stateStore || !this._state) return
    const persisted = persistedFromReviewState({
      ...this._state,
      projection: normalizeActiveProjection(this._state.projection),
    })
    const reviewId = this._state.document.identity.id
    const headKey = this._state.document.identity.headRef ?? `detached:${this._state.document.identity.detachedHeadOid ?? this._state.document.generation.headOid}`
    try {
      await this.stateStore.saveSemanticChange((db) => {
        // Submission markers are transaction metadata, not part of the
        // in-memory aggregate, and must survive open/restart until recovery
        // or an explicit retry completes them.
        const submissionInProgress = db.reviews[reviewId]?.submissionInProgress ?? null
        return {
          ...db,
          baseByHead: { ...db.baseByHead, [headKey]: { baseRef: this._state!.document.identity.baseRef } },
          reviews: { ...db.reviews, [reviewId]: { ...persisted, submissionInProgress } },
        }
      })
    } catch (err) {
      const typed = createStorageError(err instanceof Error ? err.message : String(err))
      this._error = typed
      this.publish()
      throw err
    }
  }

  private async resolveBase(): Promise<string> {
    const headRef = await currentBranchRef(this.runner)
    const detachedOid = headRef === undefined ? await resolveRefOid(this.runner, "HEAD") : undefined
    const headKey = headRef ?? (detachedOid ? `detached:${detachedOid}` : undefined)
    if (headKey !== undefined && this.stateStore) {
      try {
        const db = await this.stateStore.load()
        // Surface corrupt-state warning if present during base resolution as well
        const warning = this.stateStore.quarantineWarning
        if (warning) {
          const pathMatch = warning.match(/moved to (\S+)/)
          const qPath = pathMatch?.[1] ?? warning
          this._error = createCorruptStateError(qPath, warning)
          this.publish()
        }
        const remembered = db.baseByHead[headKey]?.baseRef
        if (remembered && (await resolveRefOid(this.runner, remembered)) !== undefined) {
          return remembered
        }
      } catch {}
    }
    try {
      const inferred = await inferReviewBase(this.runner)
      if (inferred.kind === "confident") return inferred.ref
      const candidates = inferred.kind === "choose" ? inferred.candidates : await reviewBaseCandidates(this.runner)
      if (candidates.length > 0) return candidates[0] as string
    } catch (err) {
      // Classify as git or invalid-base
      throw classifyLoadError(err)
    }
    // Fallback for test seam where git repo is fake and loader is injected
    // Do not throw here; let the injected loader decide. Return a default that will be passed to loadDocument
    return "refs/heads/main"
  }
}
