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
import { buildReviewArtifact } from "../../review/core/artifact"
import type { ReviewArtifactV1 } from "../../review/core/artifact"
import { isAncestor } from "../../review/git/load-review-projection"
import {
  type ReviewWorkspaceError,
  classifyLoadError,
  createCorruptStateError,
  createStorageError,
  createHistoryRewrittenError,
} from "./error-state"
import { HighlightCache } from "../../review/git/highlight/highlight-cache"
import type { HighlightPayload } from "../../review/git/highlight/highlight-payload"
import { loadHighlightForPatch } from "../../review/git/highlight/highlight-adapter"
import { highlightInWorker, isWorkerAvailable } from "../../review/git/highlight/highlight-worker-client"
import { getEffectiveHighlightAppearance } from "./syntax-theme"

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
  private highlightCache = new HighlightCache(50)
  private highlightByFileKey = new Map<string, HighlightPayload>()
  private highlightRequestId = 0
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

  getHighlightByFileKey(): ReadonlyMap<string, HighlightPayload> {
    return this.highlightByFileKey
  }

  private fileToPatch(file: ReviewFile): string | null {
    if (file.hunks.length === 0) return null
    if (file.source === "binary" || file.kind === "binary" || file.source === "too-large") return null
    const header = `diff --git a/${file.path} b/${file.path}\n--- a/${file.path}\n+++ b/${file.path}\n`
    const hunks = file.hunks.map((h) => `@@ -${h.oldStart},${h.oldCount} +${h.newStart},${h.newCount} @@\n${h.lines.join("\n")}`).join("\n")
    return header + hunks + "\n"
  }

  private isCodeFile(path: string): boolean {
    const lower = path.toLowerCase()
    // Only highlight code-like extensions; skip docs, images, etc. to avoid CPU and wrong highlight
    return /\.(ts|js|tsx|jsx|mjs|cjs|mts|cts|py|go|rs|java|kt|swift|c|h|cpp|hpp|cs|php|rb|sh|yaml|yml|toml|sql|html|css|scss|less|json|zig|dart|lua|exs|ex)$/.test(lower)
  }

  private isLargeFile(file: ReviewFile): boolean {
    const total = file.hunks.reduce((sum, h) => sum + h.lines.length, 0)
    return total > 40
  }

  private triggerHighlightLoad(generationId: string): void {
    const requestToken = ++this.highlightRequestId
    const capturedGeneration = generationId
    const capturedRequestId = this.requestId
    void (async () => {
      const state = this._state
      if (!state || this.destroyed) return
      if (capturedGeneration !== this.activeGenerationId) return
      // Batch highlights: collect payloads and publish once, yield between files to keep UI responsive
      const appearance = getEffectiveHighlightAppearance()
      const pendingUpdates = new Map<string, import("../../review/git/highlight/highlight-payload").HighlightPayload>()
      let processed = 0
      // Prioritize visible/selected files first to keep initial highlight fast and avoid hang on large branch (161 files)
      const files = [...state.document.files]
      const selectedKey = state.selection.fileKey
      const selectedIdx = selectedKey ? files.findIndex((f) => f.key === selectedKey) : -1
      // Build priority order: selected file, neighbors, then first 10, then rest; filter to code files and limit initial to small files
      const prioritized: typeof files = []
      const seen = new Set<string>()
      const addIfCode = (f: typeof files[number], allowLarge = false) => {
        if (!this.isCodeFile(f.path)) return
        if (seen.has(f.key)) return
        const totalLines = f.hunks.reduce((s, h) => s + h.lines.length, 0)
        if (!allowLarge && totalLines > 500) return
        seen.add(f.key)
        prioritized.push(f)
      }
      if (selectedIdx >= 0) {
        addIfCode(files[selectedIdx]!, true)
        if (selectedIdx - 1 >= 0) addIfCode(files[selectedIdx - 1]!, true)
        if (selectedIdx + 1 < files.length) addIfCode(files[selectedIdx + 1]!, true)
      }
      for (const f of files) {
        if (prioritized.length >= 10) break
        addIfCode(f)
      }
      // Only highlight first 20 code files initially to avoid hang on 23k line branch; rest will be lazy on viewport
      // (was: for (const f of files) addIfCode(f) and deferred large)
      // Large files deferred to lazy highlight on visibility
      
      // Process in batches of 4 concurrent highlights (worker can handle queue, main thread limited)
      const BATCH_SIZE = 4
      for (let batchStart = 0; batchStart < prioritized.length; batchStart += BATCH_SIZE) {
        if (this.destroyed) return
        if (requestToken !== this.highlightRequestId) return
        if (capturedGeneration !== this.activeGenerationId) return
        if (capturedRequestId !== this.requestId) return
        const batch = prioritized.slice(batchStart, batchStart + BATCH_SIZE)
        const results = await Promise.all(
          batch.map(async (file) => {
            const cacheKey = this.highlightCache.cacheKey(file.key, file.contentId, capturedGeneration, appearance)
            const cached = this.highlightCache.get(cacheKey)
            if (cached) return { file, payload: cached, cached: true }
            const patch = this.fileToPatch(file)
            if (!patch) return { file, payload: null, cached: false }
            try {
              let payload: import("../../review/git/highlight/highlight-payload").HighlightPayload | null
              if (this.isLargeFile(file) && isWorkerAvailable()) {
                try {
                  payload = await highlightInWorker(patch, file.key, appearance)
                } catch {
                  payload = await loadHighlightForPatch(patch, file.key, appearance)
                }
              } else {
                payload = await loadHighlightForPatch(patch, file.key, appearance)
              }
              return { file, payload, cached: false }
            } catch {
              return { file, payload: null, cached: false }
            }
          }),
        )
        for (const { file, payload, cached } of results) {
          if (!payload) continue
          const hasFg = payload.additionLines.some((l) => l && l.some((t) => t.fg)) || payload.deletionLines.some((l) => l && l.some((t) => t.fg))
          if (!hasFg) continue
          if (!cached) {
            const cacheKey = this.highlightCache.cacheKey(file.key, file.contentId, capturedGeneration, appearance)
            this.highlightCache.set(cacheKey, payload)
          }
          pendingUpdates.set(file.key, payload)
        }
        processed += batch.length
        // Publish incrementally for first batch, then every 2 batches
        if (pendingUpdates.size > 0 && (batchStart === 0 || batchStart % (BATCH_SIZE * 2) === 0)) {
          for (const [k, v] of pendingUpdates) this.highlightByFileKey.set(k, v)
          pendingUpdates.clear()
          this.publish()
          await new Promise<void>((r) => setTimeout(r, 0))
        }
        // Yield to event loop between batches
        await new Promise<void>((r) => setTimeout(r, 0))
        // Early exit if cancelled
        if (requestToken !== this.highlightRequestId) return
        if (capturedGeneration !== this.activeGenerationId) return
        if (capturedRequestId !== this.requestId) return
      }
      if (pendingUpdates.size > 0) {
        for (const [k, v] of pendingUpdates) this.highlightByFileKey.set(k, v)
        this.publish()
      }
    })()
  }

  async ensureHighlightForFiles(fileKeys: readonly string[]): Promise<void> {
    const state = this._state
    if (!state || this.destroyed) return
    const generationId = this.activeGenerationId
    if (!generationId) return
    const appearance = getEffectiveHighlightAppearance()
    for (const key of fileKeys) {
      if (this.highlightByFileKey.has(key)) continue
      const file = state.document.files.find((f) => f.key === key)
      if (!file || !this.isCodeFile(file.path)) continue
      const cacheKey = this.highlightCache.cacheKey(key, file.contentId, generationId, appearance)
      const cached = this.highlightCache.get(cacheKey)
      if (cached) {
        this.highlightByFileKey.set(key, cached)
        this.publish()
        continue
      }
      const patch = this.fileToPatch(file)
      if (!patch) continue
      try {
        let payload: import("../../review/git/highlight/highlight-payload").HighlightPayload | null
        if (this.isLargeFile(file) && isWorkerAvailable()) {
          try {
            payload = await highlightInWorker(patch, key, appearance)
          } catch {
            payload = await loadHighlightForPatch(patch, key, appearance)
          }
        } else {
          payload = await loadHighlightForPatch(patch, key, appearance)
        }
        if (!payload) continue
        const hasFg = payload.additionLines.some((l) => l && l.some((t) => t.fg)) || payload.deletionLines.some((l) => l && l.some((t) => t.fg))
        if (!hasFg) continue
        this.highlightCache.set(cacheKey, payload)
        this.highlightByFileKey.set(key, payload)
        this.publish()
      } catch {
        // ignore
      }
      // Yield to keep UI responsive
      await new Promise<void>((r) => setTimeout(r, 0))
      if (this.destroyed) return
    }
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
        // Qualification: discard stale responses
        if (this.destroyed || token !== this.requestId) return
        if (qualified.reviewId !== undefined && doc.identity.id !== qualified.reviewId) return
        // If same generation, no work
        if (qualified.generationId !== undefined && doc.generation.id === qualified.generationId) return
        // Reconcile off-screen (atomic)
        let nextState: ReviewState
        if (this._state === undefined) {
          nextState = createInitialReviewState(doc)
        } else {
          // Preserve draft via reconciliation (reducer keeps draft); compute off-screen
          nextState = reconcileReviewState(this._state, doc)
        }
        // Check history rewritten for Since Last Review availability
        let historyError: ReviewWorkspaceError | undefined
        if (nextState.lastSubmission) {
          try {
            const ancestor = await isAncestor(this.runner, nextState.lastSubmission.headOid, doc.generation.headOid)
            if (!ancestor) {
              historyError = createHistoryRewrittenError(nextState.lastSubmission.headOid, doc.generation.headOid)
            }
          } catch {
            // If ancestor check fails, do not block publish
          }
        }
        // Atomic swap: publish once
        this._state = nextState
        this.activeReviewId = doc.identity.id
        this.activeGenerationId = doc.generation.id
        this._error = historyError
        this.publish()
        this.highlightByFileKey.clear()
        this.triggerHighlightLoad(doc.generation.id)
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
    this.highlightByFileKey.clear()
    this.triggerHighlightLoad(doc.generation.id)
    try {
      await this.persistState()
    } catch (err) {
      // persistState already sets storage error
      void err
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

  async loadProjection(projection: ReviewProjection): Promise<void> {
    const token = ++this.requestId
    const capturedReviewId = this.activeReviewId
    const capturedGeneration = this.activeGenerationId
    this.dispatch({ type: "projection/set", projection })
    await Promise.resolve()
    if (token !== this.requestId) return
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
    this.requestId++
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
