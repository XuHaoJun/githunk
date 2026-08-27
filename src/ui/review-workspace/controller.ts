import type { GitRunner } from "../../git/runner"
import type { ReviewDocument, ReviewProjection } from "../../review/core/types"
import type { ReviewState, ViewedRecord, ExpandedGap, ReviewSelection } from "../../review/core/state"
import { createInitialReviewState } from "../../review/core/state"
import { reconcileReviewState } from "../../review/core/reconcile"
import { reduceReviewState } from "../../review/core/reducer"
import type { ReviewAction } from "../../review/core/actions"
import { loadReviewDocument } from "../../review/git/load-review-document"
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
  readonly now?: () => string
  readonly randomId?: () => string
}

type Listener = (state: ReviewState | undefined) => void

export class ReviewWorkspaceController {
  private readonly runner: GitRunner
  private readonly stateStore: ReviewStateStore | undefined
  private readonly artifactStore: ReviewArtifactStore | undefined
  private readonly loadDocumentImpl: (baseRef: string) => Promise<ReviewDocument>
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

  constructor(options: ReviewWorkspaceControllerOptions) {
    this.runner = options.runner
    this.stateStore = options.stateStore
    this.artifactStore = options.artifactStore
    this.loadDocumentImpl = options.loadDocument ?? ((baseRef: string) => loadReviewDocument(options.runner, baseRef))
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
    if (this._state === undefined) return
    const next = reduceReviewState(this._state, action)
    if (next === this._state) return
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

  async loadProjection(projection: ReviewProjection): Promise<void> {
    if (this._state === undefined) return
    const token = ++this.generationToken
    const capturedReviewId = this.activeReviewId
    const capturedGeneration = this.activeGenerationId
    this.dispatch({ type: "projection/set", projection })
    await Promise.resolve()
    if (token !== this.generationToken) return
    if (capturedReviewId !== this.activeReviewId) return
    if (capturedGeneration !== this.activeGenerationId) return
  }

  async finishReview(input: { decision: ReviewDecision; summary: string }): Promise<ReviewState> {
    if (this._state === undefined) throw new Error("no review state")
    if (!this.stateStore || !this.artifactStore) throw new Error("stores required for finish")
    const artifactId = this.randomIdImpl()
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
