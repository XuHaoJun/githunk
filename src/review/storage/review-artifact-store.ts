import { createHash } from "node:crypto"
import type { GitRunner } from "../../git/runner"
import { LocalStateFile } from "../../storage/local-state-file"
import { parseReviewArtifactV1, serializeReviewArtifactV1 } from "./schemas"
import type { PersistedReviewState } from "./schemas"
import type { ReviewArtifactV1 } from "../core/artifact"
import type { ReviewState } from "../core/state"
import { ReviewStateStore } from "./review-state-store"
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
}): Promise<ReviewState> {
  const { stateStore, artifactStore, reviewState, artifact } = input
  const reviewId = reviewState.document.identity.id
  if (reviewId !== artifact.review.id) {
    throw new Error(`review id mismatch: state ${reviewId} vs artifact ${artifact.review.id}`)
  }
  const text = artifactText(artifact)
  const digest = artifactDigest(text)
  // Step 2: persist submissionInProgress, keep pending feedback intact
  await stateStore.saveSemanticChange((db) => {
    const existing = db.reviews[reviewId]
    const persistedReview = existing ?? {
      selection: reviewState.selection,
      filter: reviewState.filter,
      projection: reviewState.projection,
      viewed: reviewState.viewed,
      feedback: [...reviewState.feedback],
      draft: reviewState.draft,
      expandedGaps: [...reviewState.expandedGaps],
      lastSubmission: reviewState.lastSubmission,
      submissionInProgress: null,
    }
    // Ensure viewed etc reflect current state (in case existing stale)
    const merged = {
      ...persistedReview,
      // keep current viewed/feedback from reviewState? For marker, we keep feedback intact as per spec
      viewed: reviewState.viewed,
      feedback: [...reviewState.feedback],
      draft: reviewState.draft,
      expandedGaps: [...reviewState.expandedGaps],
      selection: reviewState.selection,
      filter: reviewState.filter,
      projection: reviewState.projection,
      lastSubmission: reviewState.lastSubmission,
      submissionInProgress: { artifactId: artifact.id, digest },
    }
    return {
      ...db,
      reviews: { ...db.reviews, [reviewId]: merged },
    }
  })

  // Step 3: exclusive-create or digest-verify
  let artifactCreated = false
  try {
    const result = await artifactStore.createExclusive(artifact)
    if (result.ok) {
      artifactCreated = true
    } else {
      const raw = await artifactStore.readRaw(reviewId, artifact.id)
      if (raw === undefined) {
        throw new Error(`artifact ${artifact.id} reported already-exists but file missing`)
      }
      const existingDigest = artifactDigest(raw)
      if (existingDigest !== digest) {
        throw new Error(`artifact digest mismatch for ${artifact.id}: expected ${digest} got ${existingDigest}`)
      }
      artifactCreated = true
    }
  } catch (error) {
    throw error
  }

  if (!artifactCreated) {
    throw new Error(`artifact creation failed for ${artifact.id}`)
  }

  // Step 4: finalize – set lastSubmission, clear marker and submitted pending feedback, retain coverage
  await stateStore.saveSemanticChange((db) => {
    const existing = db.reviews[reviewId]
    if (!existing) throw new Error(`review ${reviewId} not found for finalization`)
    const pendingMarker = existing.submissionInProgress
    if (!pendingMarker || pendingMarker.artifactId !== artifact.id || pendingMarker.digest !== digest) {
      // If retry after step4 succeeded previously, marker may already be cleared; check lastSubmission matches
      const last = existing.lastSubmission
      if (last && last.artifactId === artifact.id) {
        return db
      }
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
    return {
      ...db,
      reviews: { ...db.reviews, [reviewId]: finalized },
    }
  })

  const newState: ReviewState = {
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
  return newState
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
      // If already finalized (marker cleared but lastSubmission matches), skip
      if (existing.submissionInProgress === null) return current
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
