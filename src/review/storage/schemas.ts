import { z } from "zod"
import type { ReviewArtifactV1, SubmittedFeedback } from "../core/artifact"
import type { ReviewIdentity, ReviewGeneration, ReviewAnchor, ReviewFeedback, ReviewFeedbackDraft } from "../core/types"
import type { ViewedRecord, ExpandedGap, SubmittedReviewRef, ReviewSelection } from "../core/state"

// ---------------------------------------------------------------------------
// Domain types (readonly) – not zod inferred
// ---------------------------------------------------------------------------

export type PersistedReviewState = Readonly<{
  selection: ReviewSelection
  filter: Readonly<{ query: string; scope: "all" | "unreviewed" | "changed" | "feedback" }>
  projection: Readonly<{ kind: "aggregate" } | { kind: "since-last-review"; fromHeadOid: string } | { kind: "commit"; oid: string }>
  viewed: Readonly<Record<string, ViewedRecord>>
  feedback: readonly ReviewFeedback[]
  draft: ReviewFeedbackDraft | null
  expandedGaps: readonly ExpandedGap[]
  lastSubmission: SubmittedReviewRef | null
  submissionInProgress: Readonly<{ artifactId: string; digest: string }> | null
}>

export type ReviewDatabaseV2 = Readonly<{
  version: 2
  baseByHead: Readonly<Record<string, Readonly<{ baseRef: string }>>>
  reviews: Readonly<Record<string, PersistedReviewState>>
}>

export function emptyReviewDatabaseV2(): ReviewDatabaseV2 {
  return { version: 2, baseByHead: {}, reviews: {} }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isValidTimestamp(value: string): boolean {
  if (value.trim().length === 0) return false
  const parsed = Date.parse(value)
  return !Number.isNaN(parsed)
}

function isValidBaseByHeadKey(key: string): boolean {
  if (key.startsWith("detached:")) {
    const oid = key.slice("detached:".length)
    return /^[0-9a-f]{40}$/i.test(oid)
  }
  if (key.length === 0) return false
  if (key.includes(":")) return false
  return true
}

// ---------------------------------------------------------------------------
// Zod schemas (internal) – strict, no extra keys
// ---------------------------------------------------------------------------

const timestampSchema = z.string().refine(isValidTimestamp, { message: "invalid timestamp" })

const fileAnchorSchema = z
  .object({
    kind: z.literal("file"),
    fileKey: z.string().min(1),
    contentId: z.string().min(1),
  })
  .strict()

const rangeAnchorSchema = z
  .object({
    kind: z.literal("range"),
    fileKey: z.string().min(1),
    contentId: z.string().min(1),
    side: z.enum(["old", "new"]),
    startLine: z.number().int().min(1),
    endLine: z.number().int().min(1),
    ownerHunkIndex: z.number().int().min(0),
    contextDigest: z.string().min(1),
  })
  .strict()
  .superRefine((val, ctx) => {
    if (val.endLine < val.startLine) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "endLine must be >= startLine", path: ["endLine"] })
    }
  })

const anchorSchema = z.discriminatedUnion("kind", [fileAnchorSchema, rangeAnchorSchema])

const feedbackSchema = z
  .object({
    id: z.string().min(1),
    kind: z.enum(["note", "suggestion"]),
    severity: z.enum(["comment", "blocking"]),
    body: z.string(),
    replacement: z.string().optional(),
    anchor: anchorSchema,
    resolution: z.enum(["active", "stale", "orphaned"]),
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
  })
  .strict()
  .superRefine((val, ctx) => {
    if (val.kind === "suggestion") {
      if (val.anchor.kind !== "range" || val.anchor.side !== "new") {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "suggestion requires new-side range anchor", path: ["anchor"] })
      }
      if (!val.replacement || val.replacement.trim().length === 0) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "suggestion requires non-empty replacement", path: ["replacement"] })
      }
    }
  })

const draftSchema = z
  .object({
    anchor: anchorSchema,
    kind: z.enum(["note", "suggestion"]),
    severity: z.enum(["comment", "blocking"]),
    body: z.string(),
    replacement: z.string().optional(),
  })
  .strict()
  .superRefine((val, ctx) => {
    if (val.kind === "suggestion") {
      if (val.anchor.kind !== "range" || val.anchor.side !== "new") {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "suggestion requires new-side range anchor", path: ["anchor"] })
      }
      if (!val.replacement || val.replacement.trim().length === 0) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "suggestion requires non-empty replacement", path: ["replacement"] })
      }
    }
  })

const viewedRecordSchema = z
  .object({
    fileKey: z.string().min(1),
    path: z.string().min(1),
    contentId: z.string().min(1),
    generationId: z.string().min(1),
    viewedAt: timestampSchema,
  })
  .strict()

const expandedGapSchema = z
  .object({
    fileKey: z.string().min(1),
    gapId: z.string().min(1),
    expanded: z.boolean(),
  })
  .strict()

const submittedReviewRefSchema = z
  .object({
    artifactId: z.string().min(1),
    generationId: z.string().min(1),
    headOid: z.string().min(1),
    submittedAt: timestampSchema,
  })
  .strict()

const submissionInProgressSchema = z
  .object({
    artifactId: z.string().min(1),
    digest: z.string().min(1),
  })
  .strict()

const selectionSchema = z
  .object({
    fileKey: z.string().nullable(),
    hunkIndex: z.number().int().min(0),
  })
  .strict()

const filterSchema = z
  .object({
    query: z.string(),
    scope: z.enum(["all", "unreviewed", "changed", "feedback"]),
  })
  .strict()

const projectionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("aggregate") }).strict(),
  z.object({ kind: z.literal("since-last-review"), fromHeadOid: z.string().min(1) }).strict(),
  z.object({ kind: z.literal("commit"), oid: z.string().min(1) }).strict(),
])

const persistedReviewStateSchema = z
  .object({
    selection: selectionSchema,
    filter: filterSchema,
    projection: projectionSchema.optional(),
    viewed: z.record(z.string(), viewedRecordSchema),
    feedback: z.array(feedbackSchema),
    draft: draftSchema.nullable(),
    expandedGaps: z.array(expandedGapSchema),
    lastSubmission: submittedReviewRefSchema.nullable(),
    submissionInProgress: submissionInProgressSchema.nullable().optional(),
  })
  .strict()

const baseByHeadSchema = z.record(z.string(), z.object({ baseRef: z.string().min(1) }).strict()).superRefine((val, ctx) => {
  for (const key of Object.keys(val)) {
    if (!isValidBaseByHeadKey(key)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `invalid baseByHead key: ${key}`, path: [key] })
    }
  }
})

const reviewDatabaseV2Schema = z
  .object({
    version: z.literal(2),
    baseByHead: baseByHeadSchema,
    reviews: z.record(z.string(), persistedReviewStateSchema),
  })
  .strict()

// Artifact schemas

const reviewIdentitySchema = z
  .object({
    id: z.string().min(1),
    headRef: z.string().nullable(),
    baseRef: z.string().min(1),
    detachedHeadOid: z.string().nullable(),
  })
  .strict()
  .superRefine((val, ctx) => {
    const hasHeadRef = val.headRef !== null
    const hasDetached = val.detachedHeadOid !== null
    if (hasHeadRef === hasDetached) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "exactly one of headRef or detachedHeadOid must be present" })
    }
    if (hasDetached && val.detachedHeadOid !== null && !/^[0-9a-f]{40}$/i.test(val.detachedHeadOid)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "invalid detachedHeadOid", path: ["detachedHeadOid"] })
    }
  })

const reviewGenerationSchema = z
  .object({
    id: z.string().min(1),
    baseOid: z.string().min(1),
    mergeBaseOid: z.string().min(1),
    headOid: z.string().min(1),
  })
  .strict()

const submittedFeedbackSchema = z
  .object({
    id: z.string().min(1),
    kind: z.enum(["note", "suggestion"]),
    severity: z.enum(["comment", "blocking"]),
    body: z.string(),
    replacement: z.string().optional(),
    anchor: anchorSchema,
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
  })
  .strict()
  .superRefine((val, ctx) => {
    if (val.kind === "suggestion") {
      if (val.anchor.kind !== "range" || val.anchor.side !== "new") {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "suggestion requires new-side range anchor", path: ["anchor"] })
      }
      if (!val.replacement || val.replacement.trim().length === 0) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "suggestion requires non-empty replacement", path: ["replacement"] })
      }
    }
  })

const artifactCoverageSchema = z
  .object({
    viewed: z.array(z.object({ fileKey: z.string().min(1), path: z.string().min(1), contentId: z.string().min(1) }).strict()),
    notViewed: z.array(z.object({ fileKey: z.string().min(1), path: z.string().min(1) }).strict()),
  })
  .strict()

const reviewArtifactV1Schema = z
  .object({
    version: z.literal(1),
    id: z.string().min(1),
    review: reviewIdentitySchema,
    generation: reviewGenerationSchema,
    submittedAt: timestampSchema,
    decision: z.enum(["comment", "approve", "request-changes"]),
    summary: z.string(),
    projection: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("aggregate") }).strict(),
      z.object({ kind: z.literal("since-last-review"), fromHeadOid: z.string().min(1) }).strict(),
    ]),
    coverage: artifactCoverageSchema,
    feedback: z.array(submittedFeedbackSchema),
  })
  .strict()

// ---------------------------------------------------------------------------
// Explicit conversions – zod values stop inside this module
// ---------------------------------------------------------------------------

function toViewedRecord(raw: z.infer<typeof viewedRecordSchema>): ViewedRecord {
  return {
    fileKey: raw.fileKey,
    path: raw.path,
    contentId: raw.contentId,
    generationId: raw.generationId,
    viewedAt: raw.viewedAt,
  }
}

function toAnchor(raw: z.infer<typeof anchorSchema>): ReviewAnchor {
  if (raw.kind === "file") {
    return { kind: "file", fileKey: raw.fileKey, contentId: raw.contentId }
  }
  return {
    kind: "range",
    fileKey: raw.fileKey,
    contentId: raw.contentId,
    side: raw.side,
    startLine: raw.startLine,
    endLine: raw.endLine,
    ownerHunkIndex: raw.ownerHunkIndex,
    contextDigest: raw.contextDigest,
  }
}

function toFeedback(raw: z.infer<typeof feedbackSchema>): ReviewFeedback {
  const base: ReviewFeedback = {
    id: raw.id,
    kind: raw.kind,
    severity: raw.severity,
    body: raw.body,
    anchor: toAnchor(raw.anchor),
    resolution: raw.resolution,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
  }
  if (raw.replacement !== undefined) {
    return { ...base, replacement: raw.replacement }
  }
  return base
}

function toDraft(raw: z.infer<typeof draftSchema>): ReviewFeedbackDraft {
  const base = {
    anchor: toAnchor(raw.anchor),
    kind: raw.kind,
    severity: raw.severity,
    body: raw.body,
  } as ReviewFeedbackDraft
  if (raw.replacement !== undefined) {
    return { ...base, replacement: raw.replacement }
  }
  return base
}

function toExpandedGap(raw: z.infer<typeof expandedGapSchema>): ExpandedGap {
  return { fileKey: raw.fileKey, gapId: raw.gapId, expanded: raw.expanded }
}

function toSubmittedRef(raw: z.infer<typeof submittedReviewRefSchema>): SubmittedReviewRef {
  return { artifactId: raw.artifactId, generationId: raw.generationId, headOid: raw.headOid, submittedAt: raw.submittedAt }
}

function toPersistedReviewState(raw: z.infer<typeof persistedReviewStateSchema>): PersistedReviewState {
  const viewed: Record<string, ViewedRecord> = {}
  for (const [k, v] of Object.entries(raw.viewed)) viewed[k] = toViewedRecord(v)
  const feedback = raw.feedback.map(toFeedback)
  const expandedGaps = raw.expandedGaps.map(toExpandedGap)
  const projection = raw.projection ?? { kind: "aggregate" as const }
  return {
    selection: { fileKey: raw.selection.fileKey, hunkIndex: raw.selection.hunkIndex },
    filter: { query: raw.filter.query, scope: raw.filter.scope },
    projection,
    viewed,
    feedback,
    draft: raw.draft ? toDraft(raw.draft) : null,
    expandedGaps,
    lastSubmission: raw.lastSubmission ? toSubmittedRef(raw.lastSubmission) : null,
    submissionInProgress: raw.submissionInProgress ?? null,
  }
}

function toDatabase(raw: z.infer<typeof reviewDatabaseV2Schema>): ReviewDatabaseV2 {
  const reviews: Record<string, PersistedReviewState> = {}
  for (const [k, v] of Object.entries(raw.reviews)) reviews[k] = toPersistedReviewState(v)
  const baseByHead: Record<string, { baseRef: string }> = {}
  for (const [k, v] of Object.entries(raw.baseByHead)) baseByHead[k] = { baseRef: v.baseRef }
  return { version: 2, baseByHead, reviews }
}

function toIdentity(raw: z.infer<typeof reviewIdentitySchema>): ReviewIdentity {
  return { id: raw.id, headRef: raw.headRef, baseRef: raw.baseRef, detachedHeadOid: raw.detachedHeadOid }
}

function toGeneration(raw: z.infer<typeof reviewGenerationSchema>): ReviewGeneration {
  return { id: raw.id, baseOid: raw.baseOid, mergeBaseOid: raw.mergeBaseOid, headOid: raw.headOid }
}

function toSubmittedFeedback(raw: z.infer<typeof submittedFeedbackSchema>): SubmittedFeedback {
  const base: SubmittedFeedback = {
    id: raw.id,
    kind: raw.kind,
    severity: raw.severity,
    body: raw.body,
    anchor: toAnchor(raw.anchor),
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
  }
  if (raw.replacement !== undefined) return { ...base, replacement: raw.replacement }
  return base
}

function toArtifact(raw: z.infer<typeof reviewArtifactV1Schema>): ReviewArtifactV1 {
  return {
    version: 1,
    id: raw.id,
    review: toIdentity(raw.review),
    generation: toGeneration(raw.generation),
    submittedAt: raw.submittedAt,
    decision: raw.decision,
    summary: raw.summary,
    projection: raw.projection,
    coverage: {
      viewed: raw.coverage.viewed.map((v) => ({ fileKey: v.fileKey, path: v.path, contentId: v.contentId })),
      notViewed: raw.coverage.notViewed.map((v) => ({ fileKey: v.fileKey, path: v.path })),
    },
    feedback: raw.feedback.map(toSubmittedFeedback),
  }
}

// Public parsers

export type ParseDatabaseResult = { ok: true; value: ReviewDatabaseV2 } | { ok: false; error: z.ZodError }

export function parseReviewDatabaseV2(value: unknown): ParseDatabaseResult {
  const result = reviewDatabaseV2Schema.safeParse(value)
  if (!result.success) return { ok: false, error: result.error }
  return { ok: true, value: toDatabase(result.data) }
}

export function parseReviewArtifactV1(value: unknown): { ok: true; value: ReviewArtifactV1 } | { ok: false; error: z.ZodError } {
  const result = reviewArtifactV1Schema.safeParse(value)
  if (!result.success) return { ok: false, error: result.error }
  return { ok: true, value: toArtifact(result.data) }
}

export function parseReviewDatabaseV2OrThrow(value: unknown): ReviewDatabaseV2 {
  const parsed = parseReviewDatabaseV2(value)
  if (!parsed.ok) throw parsed.error
  return parsed.value
}

export function parseReviewArtifactV1OrThrow(value: unknown): ReviewArtifactV1 {
  const parsed = parseReviewArtifactV1(value)
  if (!parsed.ok) throw parsed.error
  return parsed.value
}

// Serialization helpers – ensure we write only allowed fields

export function serializeReviewDatabaseV2(database: ReviewDatabaseV2): string {
  // Validate via zod by constructing raw object and ensuring it passes, then stringify
  // Build raw compatible object for validation
  const raw = {
    version: database.version,
    baseByHead: database.baseByHead,
    reviews: Object.fromEntries(
      Object.entries(database.reviews).map(([k, v]) => [
        k,
        {
          selection: v.selection,
          filter: v.filter,
          projection: v.projection,
          viewed: v.viewed,
          feedback: v.feedback,
          draft: v.draft,
          expandedGaps: v.expandedGaps,
          lastSubmission: v.lastSubmission,
          submissionInProgress: v.submissionInProgress,
        },
      ]),
    ),
  }
  const result = reviewDatabaseV2Schema.safeParse(raw)
  if (!result.success) throw result.error
  return JSON.stringify(result.data)
}

export function serializeReviewArtifactV1(artifact: ReviewArtifactV1): string {
  const raw = {
    version: artifact.version,
    id: artifact.id,
    review: artifact.review,
    generation: artifact.generation,
    submittedAt: artifact.submittedAt,
    decision: artifact.decision,
    summary: artifact.summary,
    projection: artifact.projection,
    coverage: artifact.coverage,
    feedback: artifact.feedback,
  }
  const result = reviewArtifactV1Schema.safeParse(raw)
  if (!result.success) throw result.error
  return JSON.stringify(result.data)
}

// For tests: expose schemas for direct validation if needed, but not as domain model
export const __internal = {
  reviewDatabaseV2Schema,
  reviewArtifactV1Schema,
  persistedReviewStateSchema,
  isValidTimestamp,
  isValidBaseByHeadKey,
}
