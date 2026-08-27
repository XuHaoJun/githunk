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
  private _error: string | undefined
  private listeners = new Set<Listener>()
  private generationToken = 0
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

  get error(): string | undefined {
    return this._error
  }

  get reviewId(): string | undefined {
    return this.activeReviewId
  }

  get refreshGeneration(): () => Promise<void> {
    return async () => {
      if (this.baseRef === undefined || this.destroyed) return
      const token = ++this.generationToken
      const capturedGeneration = this.activeGenerationId
      const capturedReviewId = this.activeReviewId
      try {
        const doc = await this.loadDocumentImpl(this.baseRef)
        if (this.destroyed || token !== this.generationToken) return
        if (capturedReviewId !== undefined && doc.identity.id !== capturedReviewId) return
        if (capturedGeneration !== undefined && doc.generation.id === capturedGeneration) return
        if (this._state === undefined) {
          this._state = createInitialReviewState(doc)
        } else {
          this._state = reconcileReviewState(this._state, doc)
        }
        this.activeReviewId = doc.identity.id
        this.activeGenerationId = doc.generation.id
        this._error = undefined
        this.publish()
        await this.persistState()
      } catch (err) {
        if (token !== this.generationToken) return
        const msg = err instanceof Error ? err.message : String(err)
        this._error = msg
        this.publish()
      }
    }
  }

  async open(baseRef?: string): Promise<ReviewState> {
    if (this.destroyed) throw new Error("controller destroyed")
    const token = ++this.generationToken
    let resolvedBase = baseRef
    if (resolvedBase === undefined) {
      resolvedBase = await this.resolveBase()
    }
    if (this.destroyed || token !== this.generationToken) throw new Error("open cancelled")

    const doc = await this.loadDocumentImpl(resolvedBase)
    if (this.destroyed || token !== this.generationToken) throw new Error("open cancelled")

    let persistedState: ReviewState | undefined
    try {
      const db = this.stateStore ? await this.stateStore.load() : emptyReviewDatabaseV2()
      const persisted = db.reviews[doc.identity.id]
      if (persisted !== undefined) {
        const initial = createInitialReviewState(doc)
        const reconstructed: ReviewState = {
          ...initial,
          selection: persisted.selection as ReviewSelection,
          filter: persisted.filter,
          viewed: persisted.viewed as Record<string, ViewedRecord>,
          feedback: persisted.feedback,
          draft: persisted.draft,
          expandedGaps: persisted.expandedGaps as readonly ExpandedGap[],
          lastSubmission: persisted.lastSubmission,
          projection: persisted.projection as ReviewProjection,
          revision: 0,
        }
        persistedState = reconcileReviewState(reconstructed, doc)
      }
    } catch {
      persistedState = undefined
    }

    const nextState = persistedState ?? createInitialReviewState(doc)
    const finalState = persistedState ? persistedState : nextState

    if (token !== this.generationToken) throw new Error("open cancelled")

    this._state = finalState
    this.baseRef = resolvedBase
    this.activeReviewId = doc.identity.id
    this.activeGenerationId = doc.generation.id
    this._error = undefined
    this.publish()
    await this.persistState()
    return finalState
  }

  dispatch(action: ReviewAction): void {
    const current = this._state
    if (current === undefined) return
    const next = reduceReviewState(current, action)
    if (next === current) return
    this._state = next
    this.publish()
    void this.persistState()
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

  async loadProjection(projection: ReviewProjection): Promise<void> {
    const token = ++this.generationToken
    const capturedReviewId = this.activeReviewId
    const capturedGeneration = this.activeGenerationId
    this.dispatch({ type: "projection/set", projection })
    await Promise.resolve()
    if (token !== this.generationToken) return
    if (capturedReviewId !== this.activeReviewId) return
    if (capturedGeneration !== this.activeGenerationId) return
  }

  async flushDrafts(): Promise<void> {
    if (!this.stateStore) return
    await this.stateStore.flush()
  }

  async finishReview(input: { decision: ReviewDecision; summary: string }): Promise<ReviewState> {
    if (this._state === undefined) throw new Error("no review state")
    if (!this.stateStore || !this.artifactStore) throw new Error("stores required for finish")
    const reviewId = this._state.document.identity.id
    let reuseArtifact: import("../../review/core/artifact").ReviewArtifactV1 | undefined
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
              const matchesInput = artifact.decision === input.decision && artifact.summary === input.summary
              if (matchesInput) {
                reuseArtifact = artifact
              }
            }
          }
        }
      }
    } catch {}
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
    const { buildReviewArtifact } = await import("../../review/core/artifact")
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
    const file = current.document.files.find(f => f.key === fileKey)
    if (!file) throw new Error(`file not found: ${fileKey}`)
    // Toggle gap expanded state via reducer
    const beforeExpanded = current.expandedGaps.some(g => g.fileKey === fileKey && g.gapId === gapId && g.expanded)
    this.dispatch({ type: "gap/toggle", fileKey, gapId })
    const after = this._state!
    const nowExpanded = after.expandedGaps.some(g => g.fileKey === fileKey && g.gapId === gapId && g.expanded)
    // If we just collapsed, nothing to load
    if (!nowExpanded) return
    if (beforeExpanded) return
    // Compute source context request for this gap
    const parsed = gapId.match(/^(before|trailing):(\d+)$/)
    if (!parsed) throw new Error(`invalid gapId: ${gapId}`)
    const position = parsed[1] as "before" | "trailing"
    const hunkIndex = Number(parsed[2])
    const gapAddress = this.resolveGapAddress(file, position, hunkIndex)
    if (!gapAddress) return
    const side: "old" | "new" = file.kind === "deleted" ? "old" : "new"
    const range = side === "old" ? gapAddress.oldRange : gapAddress.newRange
    const startLine = range[0]
    const endLine = range[1]
    const cacheKey = `${file.contentId}:${side}:${startLine}:${endLine}`
    if (this.sourceContextCache.has(cacheKey)) return
    const request: SourceContextRequest = {
      reviewId: current.document.identity.id,
      generationId: current.document.generation.id,
      fileKey,
      side,
      startLine,
      endLine,
    }
    const capturedReviewId = request.reviewId
    const capturedGenerationId = request.generationId
    const requestToken = ++this.gapRequestCounter
    this.pendingGapRequests.set(cacheKey, requestToken)
    let outcome: SourceContextOutcome
    try {
      if (this.loadSourceContextImpl) {
        outcome = await this.loadSourceContextImpl(request)
      } else {
        outcome = await loadSourceContext(this.runner, current.document, request)
      }
    } catch {
      this.pendingGapRequests.delete(cacheKey)
      return
    }
    // Generation-qualified check: discard if review/generation/file/side no longer matches
    const latest = this._state
    if (!latest) { this.pendingGapRequests.delete(cacheKey); return }
    if (latest.document.identity.id !== capturedReviewId) { this.pendingGapRequests.delete(cacheKey); return }
    if (latest.document.generation.id !== capturedGenerationId) { this.pendingGapRequests.delete(cacheKey); return }
    const latestFile = latest.document.files.find(f => f.key === fileKey)
    if (!latestFile) { this.pendingGapRequests.delete(cacheKey); return }
    if (this.pendingGapRequests.get(cacheKey) !== requestToken) { this.pendingGapRequests.delete(cacheKey); return }
    this.pendingGapRequests.delete(cacheKey)
    if (!outcome.ok) return
    // Cache by content id and source range
    this.sourceContextCache.set(cacheKey, outcome.result.lines)
    // Notify listeners to re-render (publish without state mutation, but we bump revision via no-op? Just publish)
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
    // Return map keyed by `${fileKey}:${gapId}` -> lines for row-planner consumption
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

  loadSourceContext(): Promise<unknown> {
    return Promise.resolve(undefined)
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    this.listeners.clear()
    this.generationToken++
    if (this.activeReviewId && this.stateStore) {
      void this.stateStore.flush().catch(() => undefined)
    }
  }

  private publish(): void {
    for (const l of this.listeners) {
      try { l(this._state) } catch {}
    }
  }

  private async persistState(): Promise<void> {
    if (!this.stateStore || !this._state) return
    const persisted = persistedFromReviewState(this._state)
    const reviewId = this._state.document.identity.id
    const headKey = this._state.document.identity.headRef ?? `detached:${this._state.document.identity.detachedHeadOid ?? this._state.document.generation.headOid}`
    try {
      await this.stateStore.saveSemanticChange((db) => ({
        ...db,
        baseByHead: { ...db.baseByHead, [headKey]: { baseRef: this._state!.document.identity.baseRef } },
        reviews: { ...db.reviews, [reviewId]: persisted },
      }))
    } catch {}
  }

  private async resolveBase(): Promise<string> {
    const headRef = await currentBranchRef(this.runner)
    const detachedOid = headRef === undefined ? await resolveRefOid(this.runner, "HEAD") : undefined
    const headKey = headRef ?? (detachedOid ? `detached:${detachedOid}` : undefined)
    if (headKey !== undefined && this.stateStore) {
      try {
        const db = await this.stateStore.load()
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
    } catch {}
    // Fallback for test seam where git repo is fake and loader is injected
    // Do not throw here; let the injected loader decide. Return a default that will be passed to loadDocument
    return "refs/heads/main"
  }
}
