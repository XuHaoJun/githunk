import { afterEach, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { stat } from "node:fs/promises"
import { createTempRepository, type TempRepository } from "../../helpers/temp-repository"
import { GitRunner } from "../../../src/git/runner"
import { ReviewStateStore } from "../../../src/review/storage/review-state-store"
import { ReviewArtifactStore, finishReviewTransaction, recoverSubmission } from "../../../src/review/storage/review-artifact-store"
import type { ReviewArtifactV1 } from "../../../src/review/core/artifact"
import type { ReviewState } from "../../../src/review/core/state"
import { createReviewDocument } from "../../../src/review/core/document"
import { createReviewIdentity, createReviewGeneration } from "../../../src/review/core/identity"
import { serializeReviewArtifactV1 } from "../../../src/review/storage/schemas"

function makeDocument() {
  const identity = createReviewIdentity({ headRef: "refs/heads/feature", headOid: "c".repeat(40), baseRef: "refs/heads/main" })
  const generation = createReviewGeneration({ baseOid: "a".repeat(40), mergeBaseOid: "b".repeat(40), headOid: "c".repeat(40) })
  return createReviewDocument({ identity, generation, commits: [], files: [] })
}

function makeReviewState(): ReviewState {
  const doc = makeDocument()
  return {
    document: doc,
    revision: 0,
    projection: { kind: "aggregate" },
    selection: { fileKey: null, hunkIndex: 0 },
    lineSelection: null,
    reveal: { fileTopToken: 0, fileTopRequestToken: 0, hunkToken: 0, scrollToFeedback: false },
    filter: { query: "", scope: "all" },
    viewed: {
      k1: { fileKey: "k1", path: "a.ts", contentId: "cid1", generationId: doc.generation.id, viewedAt: new Date().toISOString() },
    },
    feedback: [
      {
        id: "fb1",
        kind: "note",
        severity: "comment",
        body: "please fix",
        anchor: { kind: "file", fileKey: "k1", contentId: "cid1" },
        resolution: "active",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ],
    draft: null,
    expandedGaps: [],
    lastSubmission: null,
  }
}

function makeArtifact(state: ReviewState, overrides?: Partial<ReviewArtifactV1>): ReviewArtifactV1 {
  return {
    version: 1,
    id: "artifact-" + Math.random().toString(36).slice(2, 8),
    review: state.document.identity,
    generation: state.document.generation,
    submittedAt: new Date().toISOString(),
    decision: "comment",
    summary: "test summary",
    projection: { kind: "aggregate" },
    coverage: {
      viewed: Object.values(state.viewed).map((v) => ({ fileKey: v.fileKey, path: v.path, contentId: v.contentId })),
      notViewed: [],
    },
    feedback: state.feedback.map((f) => ({
      id: f.id,
      kind: f.kind,
      severity: f.severity,
      body: f.body,
      ...(f.replacement !== undefined ? { replacement: f.replacement } : {}),
      anchor: f.anchor,
      createdAt: f.createdAt,
      updatedAt: f.updatedAt,
    })),
    ...overrides,
  }
}

function artifactDigest(artifact: ReviewArtifactV1): string {
  const serialized = serializeReviewArtifactV1(artifact) + "\n"
  return createHash("sha256").update(serialized, "utf8").digest("hex")
}

describe("ReviewArtifactStore integration", () => {
  let repository: TempRepository | undefined
  afterEach(async () => {
    await repository?.cleanup()
  })

  test("exclusive-create creates artifact and verifies load", async () => {
    repository = await createTempRepository()
    const runner = new GitRunner(repository.path)
    const store = new ReviewArtifactStore(runner)
    const state = makeReviewState()
    const artifact = makeArtifact(state, { id: "art-001" })
    const result = await store.createExclusive(artifact)
    expect(result.ok).toBe(true)
    const loaded = await store.load(artifact.review.id, artifact.id)
    expect(loaded?.id).toBe(artifact.id)
    const path = await store.resolvePath(artifact.review.id, artifact.id)
    const mode = (await stat(path)).mode & 0o777
    expect(mode).toBe(0o600)
  })

  test("duplicate exclusive-create returns already-exists and does not overwrite", async () => {
    repository = await createTempRepository()
    const runner = new GitRunner(repository.path)
    const store = new ReviewArtifactStore(runner)
    const state = makeReviewState()
    const artifact = makeArtifact(state, { id: "art-dup" })
    await store.createExclusive(artifact)
    const second = await store.createExclusive({ ...artifact, summary: "different" })
    expect(second.ok).toBe(false)
    if (!second.ok) expect(second.reason).toBe("already-exists")
    const loaded = await store.load(artifact.review.id, artifact.id)
    expect(loaded?.summary).toBe(artifact.summary)
  })

  test("digest verification – mismatch detected", async () => {
    repository = await createTempRepository()
    const runner = new GitRunner(repository.path)
    const artifactStore = new ReviewArtifactStore(runner)
    const state = makeReviewState()
    const artifact = makeArtifact(state, { id: "art-digest" })
    await artifactStore.createExclusive(artifact)
    const digest = artifactDigest(artifact)
    expect(await artifactStore.verifyDigest(artifact.review.id, artifact.id, digest)).toBe(true)
    expect(await artifactStore.verifyDigest(artifact.review.id, artifact.id, "bad-digest")).toBe(false)
  })
})

describe("finishReviewTransaction – recoverable two-file transaction", () => {
  let repository: TempRepository | undefined
  afterEach(async () => {
    await repository?.cleanup()
  })

  test("happy path persists marker, artifact, and finalizes state", async () => {
    repository = await createTempRepository()
    const runner = new GitRunner(repository.path)
    const stateStore = new ReviewStateStore(runner)
    const artifactStore = new ReviewArtifactStore(runner)
    const state = makeReviewState()
    const artifact = makeArtifact(state, { id: "art-happy" })
    await stateStore.saveSemanticChange((db) => ({
      ...db,
      reviews: {
        ...db.reviews,
        [state.document.identity.id]: {
          selection: state.selection,
          lineSelection: null,
          filter: state.filter,
          projection: state.projection,
          viewed: state.viewed,
          feedback: [...state.feedback],
          draft: state.draft,
          expandedGaps: [...state.expandedGaps],
          lastSubmission: state.lastSubmission,
          submissionInProgress: null,
        },
      },
    }))
    const result = await finishReviewTransaction({ stateStore, artifactStore, reviewState: state, artifact })
    expect(result.feedback).toHaveLength(0)
    expect(result.lastSubmission?.artifactId).toBe(artifact.id)
    const db = await stateStore.load()
    const persisted = db.reviews[state.document.identity.id]
    expect(persisted?.submissionInProgress).toBeNull()
    expect(persisted?.lastSubmission?.artifactId).toBe(artifact.id)
    expect(persisted?.feedback).toHaveLength(0)
    const loaded = await artifactStore.load(artifact.review.id, artifact.id)
    expect(loaded?.id).toBe(artifact.id)
  })

  test("failure after marker write – retry reuses same id and digest, never duplicate", async () => {
    repository = await createTempRepository()
    const runner = new GitRunner(repository.path)
    const stateStore = new ReviewStateStore(runner)
    const artifactStore = new ReviewArtifactStore(runner)
    const state = makeReviewState()
    const artifact = makeArtifact(state, { id: "art-retry-marker" })
    await stateStore.saveSemanticChange((db) => ({
      ...db,
      reviews: {
        ...db.reviews,
        [state.document.identity.id]: {
          selection: state.selection,
          lineSelection: null,
          filter: state.filter,
          projection: state.projection,
          viewed: state.viewed,
          feedback: [...state.feedback],
          draft: state.draft,
          expandedGaps: [],
          lastSubmission: null,
          submissionInProgress: null,
        },
      },
    }))
    const originalCreate = artifactStore.createExclusive.bind(artifactStore)
    let callCount = 0
    artifactStore.createExclusive = async (a) => {
      callCount++
      if (callCount === 1) throw new Error("injected failure after marker")
      return originalCreate(a)
    }
    await expect(finishReviewTransaction({ stateStore, artifactStore, reviewState: state, artifact })).rejects.toThrow("injected failure after marker")
    const dbAfterFail = await stateStore.load()
    expect(dbAfterFail.reviews[state.document.identity.id]?.submissionInProgress?.artifactId).toBe(artifact.id)
    expect(dbAfterFail.reviews[state.document.identity.id]?.feedback).toHaveLength(1)
    artifactStore.createExclusive = originalCreate
    const result = await finishReviewTransaction({ stateStore, artifactStore, reviewState: state, artifact })
    expect(result.lastSubmission?.artifactId).toBe(artifact.id)
    const dbAfterRetry = await stateStore.load()
    expect(dbAfterRetry.reviews[state.document.identity.id]?.feedback).toHaveLength(0)
    expect(dbAfterRetry.reviews[state.document.identity.id]?.submissionInProgress).toBeNull()
    const loaded = await artifactStore.load(artifact.review.id, artifact.id)
    expect(loaded?.id).toBe(artifact.id)
  })

  test("failure after artifact exclusive-create – retry verifies digest and finalizes", async () => {
    repository = await createTempRepository()
    const runner = new GitRunner(repository.path)
    const stateStore = new ReviewStateStore(runner)
    const artifactStore = new ReviewArtifactStore(runner)
    const state = makeReviewState()
    const artifact = makeArtifact(state, { id: "art-retry-artifact" })
    await stateStore.saveSemanticChange((db) => ({
      ...db,
      reviews: {
        ...db.reviews,
        [state.document.identity.id]: {
          selection: state.selection,
          lineSelection: null,
          filter: state.filter,
          projection: state.projection,
          viewed: state.viewed,
          feedback: [...state.feedback],
          draft: null,
          expandedGaps: [],
          lastSubmission: null,
          submissionInProgress: null,
        },
      },
    }))
    const originalFinalize = stateStore.saveSemanticChange.bind(stateStore)
    let callCount = 0
    stateStore.saveSemanticChange = async (updater) => {
      callCount++
      if (callCount === 2) throw new Error("injected failure before finalized state")
      return originalFinalize(updater)
    }
    await expect(finishReviewTransaction({ stateStore, artifactStore, reviewState: state, artifact })).rejects.toThrow("injected failure before finalized state")
    const dbMid = await stateStore.load()
    expect(dbMid.reviews[state.document.identity.id]?.submissionInProgress?.artifactId).toBe(artifact.id)
    expect(dbMid.reviews[state.document.identity.id]?.feedback).toHaveLength(1)
    const midArtifact = await artifactStore.load(artifact.review.id, artifact.id)
    expect(midArtifact?.id).toBe(artifact.id)
    stateStore.saveSemanticChange = originalFinalize
    const result = await finishReviewTransaction({ stateStore, artifactStore, reviewState: state, artifact })
    expect(result.lastSubmission?.artifactId).toBe(artifact.id)
    const dbAfter = await stateStore.load()
    expect(dbAfter.reviews[state.document.identity.id]?.feedback).toHaveLength(0)
    expect(dbAfter.reviews[state.document.identity.id]?.submissionInProgress).toBeNull()
  })

  test("failure before finalized-state write – never clears pending feedback early, success only after final durability", async () => {
    repository = await createTempRepository()
    const runner = new GitRunner(repository.path)
    const stateStore = new ReviewStateStore(runner)
    const artifactStore = new ReviewArtifactStore(runner)
    const state = makeReviewState()
    const artifact = makeArtifact(state, { id: "art-retry-final" })
    await stateStore.saveSemanticChange((db) => ({
      ...db,
      reviews: {
        ...db.reviews,
        [state.document.identity.id]: {
          selection: state.selection,
          lineSelection: null,
          filter: state.filter,
          projection: state.projection,
          viewed: state.viewed,
          feedback: [...state.feedback],
          draft: null,
          expandedGaps: [],
          lastSubmission: null,
          submissionInProgress: null,
        },
      },
    }))
    const original = stateStore.saveSemanticChange.bind(stateStore)
    let shouldFail = true
    stateStore.saveSemanticChange = async (updater) => {
      const beforeDb = await stateStore.load()
      const hasMarker = beforeDb.reviews[state.document.identity.id]?.submissionInProgress !== null
      if (hasMarker && shouldFail) {
        shouldFail = false
        throw new Error("final write fails")
      }
      return original(updater)
    }
    await expect(finishReviewTransaction({ stateStore, artifactStore, reviewState: state, artifact })).rejects.toThrow("final write fails")
    const dbFail = await stateStore.load()
    expect(dbFail.reviews[state.document.identity.id]?.feedback).toHaveLength(1)
    expect(dbFail.reviews[state.document.identity.id]?.submissionInProgress).not.toBeNull()
    stateStore.saveSemanticChange = original
    await finishReviewTransaction({ stateStore, artifactStore, reviewState: state, artifact })
    const dbSuccess = await stateStore.load()
    expect(dbSuccess.reviews[state.document.identity.id]?.feedback).toHaveLength(0)
    expect(dbSuccess.reviews[state.document.identity.id]?.lastSubmission?.artifactId).toBe(artifact.id)
  })

  test("restart recovery via recoverSubmission completes pending transaction", async () => {
    repository = await createTempRepository()
    const runner = new GitRunner(repository.path)
    const stateStore = new ReviewStateStore(runner)
    const artifactStore = new ReviewArtifactStore(runner)
    const state = makeReviewState()
    const artifact = makeArtifact(state, { id: "art-recover" })
    await stateStore.saveSemanticChange((db) => ({
      ...db,
      reviews: {
        ...db.reviews,
        [state.document.identity.id]: {
          selection: state.selection,
          lineSelection: null,
          filter: state.filter,
          projection: state.projection,
          viewed: state.viewed,
          feedback: [...state.feedback],
          draft: null,
          expandedGaps: [],
          lastSubmission: null,
          submissionInProgress: null,
        },
      },
    }))
    const digest = artifactDigest(artifact)
    await stateStore.saveSemanticChange((db) => ({
      ...db,
      reviews: {
        ...db.reviews,
        [state.document.identity.id]: {
          ...db.reviews[state.document.identity.id]!,
          submissionInProgress: { artifactId: artifact.id, digest },
        },
      },
    }))
    await artifactStore.createExclusive(artifact)
    const newRunner = new GitRunner(repository.path)
    const newStateStore = new ReviewStateStore(newRunner)
    const newArtifactStore = new ReviewArtifactStore(newRunner)
    const before = await newStateStore.load()
    expect(before.reviews[state.document.identity.id]?.submissionInProgress?.artifactId).toBe(artifact.id)
    expect(before.reviews[state.document.identity.id]?.feedback).toHaveLength(1)
    await recoverSubmission({ stateStore: newStateStore, artifactStore: newArtifactStore })
    const after = await newStateStore.load()
    expect(after.reviews[state.document.identity.id]?.submissionInProgress).toBeNull()
    expect(after.reviews[state.document.identity.id]?.feedback).toHaveLength(0)
    expect(after.reviews[state.document.identity.id]?.lastSubmission?.artifactId).toBe(artifact.id)
  })

  test("never creates duplicate artifact on retry with same digest", async () => {
    repository = await createTempRepository()
    const runner = new GitRunner(repository.path)
    const stateStore = new ReviewStateStore(runner)
    const artifactStore = new ReviewArtifactStore(runner)
    const state = makeReviewState()
    const artifact = makeArtifact(state, { id: "art-no-dup" })
    await stateStore.saveSemanticChange((db) => ({
      ...db,
      reviews: {
        ...db.reviews,
        [state.document.identity.id]: {
          selection: state.selection,
          lineSelection: null,
          filter: state.filter,
          projection: state.projection,
          viewed: state.viewed,
          feedback: [...state.feedback],
          draft: null,
          expandedGaps: [],
          lastSubmission: null,
          submissionInProgress: null,
        },
      },
    }))
    await finishReviewTransaction({ stateStore, artifactStore, reviewState: state, artifact })
    const secondResult = await finishReviewTransaction({ stateStore, artifactStore, reviewState: state, artifact })
    expect(secondResult.lastSubmission?.artifactId).toBe(artifact.id)
    const loaded = await artifactStore.load(artifact.review.id, artifact.id)
    expect(loaded?.id).toBe(artifact.id)
  })
})
