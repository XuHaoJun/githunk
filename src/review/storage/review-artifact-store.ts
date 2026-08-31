import { createHash } from "node:crypto"
import type { GitRunner } from "../../git/runner"
import { LocalStateFile } from "../../storage/local-state-file"
import { parseReviewArtifactV1, serializeReviewArtifactV1 } from "./schemas"
import type { PersistedReviewState } from "./schemas"
import type { ReviewArtifactV1 } from "../core/artifact"
import { validateFinishReview } from "../core/artifact"
import type { ReviewState } from "../core/state"
import { ReviewStateStore, persistedFromReviewState } from "./review-state-store"
function artifactRelativePath(reviewId: string, artifactId: string): string {
  return `githunk/reviews/${reviewId}/${artifactId}.json`
}

function artifactDigest(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex")
}

function artifactText(artifact: ReviewArtifactV1): string {
  return serializeReviewArtifactV1(artifact) + "\n"
}

export class ReviewArtifactStore {
  constructor(private readonly runner: GitRunner) {}

  private artifactFile(reviewId: string, artifactId: string): LocalStateFile {
    return new LocalStateFile({
      runner: this.runner,
      relativePath: artifactRelativePath(reviewId, artifactId),
      pathKind: "review-artifact",
    })
  }

  async resolvePath(reviewId: string, artifactId: string): Promise<string> {
    const file = this.artifactFile(reviewId, artifactId)
    return file.resolvePath()
  }

  async load(reviewId: string, artifactId: string): Promise<ReviewArtifactV1 | undefined> {
    const file = this.artifactFile(reviewId, artifactId)
    const text = await file.readText()
    if (text === undefined) return undefined
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      throw new Error(`artifact ${artifactId} is corrupt: invalid JSON`)
    }
    const result = parseReviewArtifactV1(parsed)
    if (!result.ok) throw result.error
    return result.value
  }

  async readRaw(reviewId: string, artifactId: string): Promise<string | undefined> {
    const file = this.artifactFile(reviewId, artifactId)
    return file.readText()
  }

  async createExclusive(artifact: ReviewArtifactV1): Promise<{ ok: true } | { ok: false; reason: "already-exists" }> {
    const text = artifactText(artifact)
    const file = this.artifactFile(artifact.review.id, artifact.id)
    return file.createTextExclusive(text)
  }

  async verifyDigest(reviewId: string, artifactId: string, expectedDigest: string): Promise<boolean> {
    const raw = await this.readRaw(reviewId, artifactId)
    if (raw === undefined) return false
    const actual = artifactDigest(raw)
    return actual === expectedDigest
  }
}
export async function finishReviewTransaction(input: {
  stateStore: ReviewStateStore
  artifactStore: ReviewArtifactStore
  reviewState: ReviewState
  artifact: ReviewArtifactV1
  readonly isCurrent?: () => boolean
}): Promise<ReviewState> {
  const { stateStore, artifactStore, reviewState, artifact, isCurrent } = input
  const reviewId = reviewState.document.identity.id
  if (reviewId !== artifact.review.id) {
    throw new Error(`review id mismatch: state ${reviewId} vs artifact ${artifact.review.id}`)
  }

  // The caller normally builds the artifact (and therefore validates) before
  // entering this function.  Validate here as well so this transaction can
  // never write a marker for an invalid submission when called directly.
  const validation = validateFinishReview(reviewState, {
    decision: artifact.decision,
    summary: artifact.summary,
  })
  if (!validation.ok) throw new Error(`cannot finish review: ${validation.reason}`)

  const text = artifactText(artifact)
  const digest = artifactDigest(text)

  // The artifact is immutable and is the transaction's durable source of
  // truth.  It must exist (or match exactly) before state can advertise a
  // pending submission.
  try {
    const created = await artifactStore.createExclusive(artifact)
    if (!created.ok && !(await artifactStore.verifyDigest(reviewId, artifact.id, digest))) {
      throw new Error(`artifact digest mismatch for ${artifact.id}`)
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`unable to persist immutable review artifact: ${detail}`)
  }
  if (isCurrent && !isCurrent()) {
    throw new Error("review changed while finishing")
  }

  // Record the current semantic state, not a stale snapshot from an earlier
  // attempt.  Feedback and draft remain pending until finalization succeeds.
  try {
    await stateStore.saveSemanticChange((db) => {
      if (isCurrent && !isCurrent()) throw new Error("review changed while finishing")
      const persisted = persistedFromReviewState(reviewState)
      const existing = db.reviews[reviewId]
      const pending: PersistedReviewState = {
        ...(existing ?? persisted),
        ...persisted,
        submissionInProgress: { artifactId: artifact.id, digest },
      }
      return { ...db, reviews: { ...db.reviews, [reviewId]: pending } }
    })
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`unable to persist submission marker: ${detail}`)
  }
  if (isCurrent && !isCurrent()) {
    throw new Error("review changed while finishing")
  }

  // Only after the marker write is durable may pending feedback/draft be
  // cleared.  A failed final write leaves the marker and all pending work
  // available for an idempotent retry.
  try {
    await stateStore.saveSemanticChange((db) => {
      if (isCurrent && !isCurrent()) throw new Error("review changed while finishing")
      const existing = db.reviews[reviewId]
      if (!existing) throw new Error(`review ${reviewId} not found for finalization`)
      const marker = existing.submissionInProgress
      if (!marker || marker.artifactId !== artifact.id || marker.digest !== digest) {
        const last = existing.lastSubmission
        if (last?.artifactId === artifact.id) return db
        throw new Error(`submission marker missing or mismatched for ${artifact.id}`)
      }
      const finalized: PersistedReviewState = {
        ...existing,
        lastSubmission: {
          artifactId: artifact.id,
          generationId: artifact.generation.id,
          headOid: artifact.generation.headOid,
          submittedAt: artifact.submittedAt,
        },
        submissionInProgress: null,
        feedback: [],
        draft: null,
      }
      return { ...db, reviews: { ...db.reviews, [reviewId]: finalized } }
    })
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`unable to finalize review submission: ${detail}`)
  }

  return {
    ...reviewState,
    feedback: [],
    draft: null,
    lastSubmission: {
      artifactId: artifact.id,
      generationId: artifact.generation.id,
      headOid: artifact.generation.headOid,
      submittedAt: artifact.submittedAt,
    },
    revision: reviewState.revision + 1,
  }
}

export async function recoverSubmission(input: {
  stateStore: ReviewStateStore
  artifactStore: ReviewArtifactStore
}): Promise<void> {
  const { stateStore, artifactStore } = input
  const db = await stateStore.load()
  const pendingReviews = Object.entries(db.reviews).filter(([, r]) => r.submissionInProgress !== null && r.submissionInProgress !== undefined)
  for (const [reviewId, persisted] of pendingReviews) {
    const marker = persisted.submissionInProgress!
    const raw = await artifactStore.readRaw(reviewId, marker.artifactId)
    if (raw === undefined) {
      // Artifact not yet created – cannot recover without payload; leave marker for later retry
      continue
    }
    const actualDigest = artifactDigest(raw)
    if (actualDigest !== marker.digest) {
      // Digest mismatch – quarantine? For now throw to surface error
      throw new Error(`recover: artifact digest mismatch for ${marker.artifactId}`)
    }
    let artifact: ReviewArtifactV1
    try {
      const parsed: unknown = JSON.parse(raw)
      const result = parseReviewArtifactV1(parsed)
      if (!result.ok) throw result.error
      artifact = result.value
    } catch {
      throw new Error(`recover: artifact ${marker.artifactId} corrupt`)
    }
    await stateStore.saveSemanticChange((current) => {
      const existing = current.reviews[reviewId]
      if (!existing || !existing.submissionInProgress) return current
      if (existing.submissionInProgress.artifactId !== marker.artifactId) return current
      const finalized: PersistedReviewState = {
        ...existing,
        lastSubmission: {
          artifactId: artifact.id,
          generationId: artifact.generation.id,
          headOid: artifact.generation.headOid,
          submittedAt: artifact.submittedAt,
        },
        submissionInProgress: null,
        feedback: [],
        draft: null,
      }
      return {
        ...current,
        reviews: { ...current.reviews, [reviewId]: finalized },
      }
    })
  }
}
