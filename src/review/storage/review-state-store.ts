import { createHash } from "node:crypto"
import type { GitRunner } from "../../git/runner"
import { LocalStateFile } from "../../storage/local-state-file"
import {
  emptyReviewDatabaseV2,
  parseReviewDatabaseV2,
  serializeReviewArtifactV1,
  serializeReviewDatabaseV2,
  type PersistedReviewState,
  type ReviewDatabaseV2,
} from "./schemas"
import type { ReviewFeedbackDraft } from "../core/types"
import type { ReviewArtifactV1 } from "../core/artifact"
import type { ReviewState } from "../core/state"

const RELATIVE_PATH = "githunk/review-state-v2.json"

export type { ReviewDatabaseV2, PersistedReviewState }
export { emptyReviewDatabaseV2 }

export class ReviewStateStore {
  private readonly file: LocalStateFile
  private warning: string | undefined
  private queue: Promise<void> = Promise.resolve()
  private draftPending = new Map<string, ReviewFeedbackDraft | null>()
  private draftTimers = new Map<string, NodeJS.Timeout>()

  constructor(runner: GitRunner) {
    this.file = new LocalStateFile({ runner, relativePath: RELATIVE_PATH, pathKind: "review-state" })
  }

  get quarantineWarning(): string | undefined {
    return this.warning
  }

  get path(): string {
    return this.file.path
  }

  async resolvePath(): Promise<string> {
    return this.file.resolvePath()
  }

  private async readDatabase(): Promise<ReviewDatabaseV2> {
    this.warning = undefined
    let text: string | undefined
    try {
      text = await this.file.readText()
    } catch (error) {
      throw error
    }
    if (text === undefined) return emptyReviewDatabaseV2()
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      const corruptPath = await this.file.quarantine()
      this.warning = `Review state was corrupt; moved to ${corruptPath}`
      return emptyReviewDatabaseV2()
    }
    const result = parseReviewDatabaseV2(parsed)
    if (!result.ok) {
      const corruptPath = await this.file.quarantine()
      this.warning = `Review state was corrupt; moved to ${corruptPath}`
      return emptyReviewDatabaseV2()
    }
    return result.value
  }

  async load(): Promise<ReviewDatabaseV2> {
    return this.readDatabase()
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation)
    this.queue = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  async saveSemanticChange(updater: (db: ReviewDatabaseV2) => ReviewDatabaseV2): Promise<void> {
    return this.enqueue(async () => {
      const current = await this.readDatabase()
      const next = updater(current)
      const text = serializeReviewDatabaseV2(next) + "\n"
      await this.file.writeText(text)
    })
  }

  saveDraftDebounced(reviewId: string, draft: ReviewFeedbackDraft | null): void {
    this.draftPending.set(reviewId, draft)
    const existing = this.draftTimers.get(reviewId)
    clearTimeout(existing)
    const timer = setTimeout(() => {
      this.draftTimers.delete(reviewId)
      const pending = this.draftPending.get(reviewId)
      const hasPending = this.draftPending.has(reviewId)
      if (!hasPending) return
      this.enqueue(async () => {
        const current = await this.readDatabase()
        const existingReview = current.reviews[reviewId]
        let nextReviews: Record<string, PersistedReviewState>
        if (!existingReview) {
          const emptyPersisted: PersistedReviewState = {
            selection: { fileKey: null, hunkIndex: 0 },
            filter: { query: "", scope: "all" },
            projection: { kind: "aggregate" },
            viewed: {},
            feedback: [],
            draft: pending ?? null,
            expandedGaps: [],
            lastSubmission: null,
            submissionInProgress: null,
          }
          nextReviews = { ...current.reviews, [reviewId]: emptyPersisted }
        } else {
          nextReviews = { ...current.reviews, [reviewId]: { ...existingReview, draft: pending ?? null } }
        }
        const nextDb: ReviewDatabaseV2 = { ...current, reviews: nextReviews }
        const text = serializeReviewDatabaseV2(nextDb) + "\n"
        await this.file.writeText(text)
        if (this.draftPending.get(reviewId) === pending) {
          this.draftPending.delete(reviewId)
        }
      }).catch(() => {
        // Retain pending for flush retry
      })
    }, 500)
    this.draftTimers.set(reviewId, timer)
  }

  async flush(): Promise<void> {
    const pendingEntries = Array.from(this.draftPending.entries())
    for (const [, timer] of this.draftTimers) {
      clearTimeout(timer)
    }
    this.draftTimers.clear()

    const promises: Promise<void>[] = []
    for (const [reviewId, draft] of pendingEntries) {
      const p = this.enqueue(async () => {
        const current = await this.readDatabase()
        const existingReview = current.reviews[reviewId]
        let nextReviews: Record<string, PersistedReviewState>
        if (!existingReview) {
          const emptyPersisted: PersistedReviewState = {
            selection: { fileKey: null, hunkIndex: 0 },
            filter: { query: "", scope: "all" },
            projection: { kind: "aggregate" },
            viewed: {},
            feedback: [],
            draft: draft ?? null,
            expandedGaps: [],
            lastSubmission: null,
            submissionInProgress: null,
          }
          nextReviews = { ...current.reviews, [reviewId]: emptyPersisted }
        } else {
          nextReviews = { ...current.reviews, [reviewId]: { ...existingReview, draft: draft ?? null } }
        }
        const nextDb: ReviewDatabaseV2 = { ...current, reviews: nextReviews }
        const text = serializeReviewDatabaseV2(nextDb) + "\n"
        await this.file.writeText(text)
        if (this.draftPending.get(reviewId) === draft) {
          this.draftPending.delete(reviewId)
        }
      })
      promises.push(p)
    }
    await Promise.all(promises)
    await this.queue
  }
}

export function persistedFromReviewState(state: ReviewState): PersistedReviewState {
  return {
    selection: state.selection,
    filter: state.filter,
    projection: state.projection,
    viewed: state.viewed,
    feedback: [...state.feedback],
    draft: state.draft,
    expandedGaps: [...state.expandedGaps],
    lastSubmission: state.lastSubmission,
    submissionInProgress: null,
  }
}

export function artifactDigestForText(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex")
}

export function artifactTextForDigest(artifact: ReviewArtifactV1): string {
  return serializeReviewArtifactV1(artifact) + "\n"
}
