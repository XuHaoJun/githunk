import type { ReviewState } from "./state"
import type { ReviewIdentity, ReviewGeneration } from "./types"
import type { ReviewFeedback } from "./types"

export type ReviewDecision = "comment" | "approve" | "request-changes"

export type SubmittedFeedback = Readonly<{
  id: string
  kind: "note" | "suggestion"
  severity: "comment" | "blocking"
  body: string
  replacement?: string
  anchor: ReviewFeedback["anchor"]
  createdAt: string
  updatedAt: string
}>

export type ReviewArtifactV1 = Readonly<{
  version: 1
  id: string
  review: ReviewIdentity
  generation: ReviewGeneration
  submittedAt: string
  decision: ReviewDecision
  summary: string
  projection: Readonly<{ kind: "aggregate" } | { kind: "since-last-review"; fromHeadOid: string }>
  coverage: Readonly<{
    viewed: readonly Readonly<{ fileKey: string; path: string; contentId: string }>[]
    notViewed: readonly Readonly<{ fileKey: string; path: string }>[]
  }>
  feedback: readonly SubmittedFeedback[]
}>

export type FinishValidationResult = { ok: true } | { ok: false; reason: string }

export function validateFinishReview(
  state: ReviewState,
  input: { decision: ReviewDecision; summary: string },
): FinishValidationResult {
  if (state.draft !== null) {
    return { ok: false, reason: "draft-open" }
  }
  if (state.projection.kind !== "aggregate") {
    return { ok: false, reason: "projection-invalid" }
  }
  if (state.feedback.some((f) => f.kind === "suggestion" && (
    f.anchor.kind !== "range" || f.anchor.side !== "new" || !f.replacement || f.replacement.trim().length === 0 ||
    !state.document.files.some((file) => file.key === f.anchor.fileKey && file.contentId === f.anchor.contentId)
  ))) return { ok: false, reason: "suggestion-invalid" }
  if (state.projection.kind === "commit") {
    return { ok: false, reason: "commit-projection-invalid" }
  }
  const hasStaleOrOrphaned = state.feedback.some((f) => f.resolution !== "active")
  if (hasStaleOrOrphaned) {
    return { ok: false, reason: "feedback-needs-reanchor" }
  }
  const summaryTrimmed = input.summary.trim()
  const hasBlocking = state.feedback.some((f) => f.severity === "blocking")
  const hasComment = state.feedback.some((f) => f.severity === "comment")

  if (input.decision === "approve" || input.decision === "request-changes") {
    if (summaryTrimmed.length === 0) {
      return { ok: false, reason: "summary-required" }
    }
  }

  if (input.decision === "request-changes") {
    if (!hasBlocking) {
      return { ok: false, reason: "request-changes-requires-blocking" }
    }
    return { ok: true }
  }

  if (input.decision === "approve") {
    if (hasBlocking) {
      return { ok: false, reason: "approve-has-blocking-feedback" }
    }
    return { ok: true }
  }

  if (hasBlocking) {
    return { ok: false, reason: "comment-has-blocking-feedback" }
  }
  if (summaryTrimmed.length === 0 && !hasComment) {
    if (state.feedback.length === 0) {
      return { ok: false, reason: "comment-requires-summary-or-feedback" }
    }
    return { ok: false, reason: "comment-requires-summary-or-feedback" }
  }

  return { ok: true }
}

export function buildReviewArtifact(
  state: ReviewState,
  params: { id: string; submittedAt: string; decision: ReviewDecision; summary: string },
): ReviewArtifactV1 {
  const validation = validateFinishReview(state, { decision: params.decision, summary: params.summary })
  if (!validation.ok) {
    throw new Error(`cannot build artifact: ${validation.reason}`)
  }
  if (state.projection.kind === "commit") {
    throw new Error(`commit projection cannot be submitted`)
  }
  let projection: ReviewArtifactV1["projection"]
  if (state.projection.kind === "aggregate") {
    projection = { kind: "aggregate" }
  } else if (state.projection.kind === "since-last-review") {
    projection = { kind: "since-last-review", fromHeadOid: state.projection.fromHeadOid }
  } else {
    throw new Error(`unsupported projection for artifact`)
  }
  const viewed: { fileKey: string; path: string; contentId: string }[] = []
  const notViewed: { fileKey: string; path: string }[] = []
  for (const file of state.document.files) {
    const rec = state.viewed[file.key]
    if (rec && rec.path === file.path && rec.contentId === file.contentId) {
      viewed.push({ fileKey: file.key, path: file.path, contentId: file.contentId })
    } else {
      notViewed.push({ fileKey: file.key, path: file.path })
    }
  }

  const indexByKey = new Map(state.document.files.map((f, i) => [f.key, i] as const))
  const sorted = [...state.feedback].sort((a, b) => {
    const ia = indexByKey.get(a.anchor.fileKey) ?? Number.MAX_SAFE_INTEGER
    const ib = indexByKey.get(b.anchor.fileKey) ?? Number.MAX_SAFE_INTEGER
    if (ia !== ib) return ia - ib
    const la = a.anchor.kind === "range" ? a.anchor.startLine : 0
    const lb = b.anchor.kind === "range" ? b.anchor.startLine : 0
    if (la !== lb) return la - lb
    return a.id.localeCompare(b.id)
  })

  const feedback: SubmittedFeedback[] = sorted.map((f) => ({
    id: f.id,
    kind: f.kind,
    severity: f.severity,
    body: f.body,
    ...(f.replacement !== undefined ? { replacement: f.replacement } : {}),
    anchor: f.anchor,
    createdAt: f.createdAt,
    updatedAt: f.updatedAt,
  }))

  return {
    version: 1,
    id: params.id,
    review: state.document.identity,
    generation: state.document.generation,
    submittedAt: params.submittedAt,
    decision: params.decision,
    summary: params.summary,
    projection,
    coverage: {
      viewed: viewed as readonly { fileKey: string; path: string; contentId: string }[],
      notViewed: notViewed as readonly { fileKey: string; path: string }[],
    },
    feedback,
  }
}

export function renderReviewArtifactMarkdown(artifact: ReviewArtifactV1): string {
  const lines: string[] = []
  lines.push(`# Review: ${artifact.decision}`)
  lines.push("")
  lines.push(artifact.summary)
  lines.push("")
  lines.push(`## Generation`)
  lines.push("")
  lines.push(`- Review: ${artifact.review.id}`)
  lines.push(`- Base: ${artifact.review.baseRef}`)
  lines.push(`- Head: ${artifact.review.headRef ?? artifact.review.detachedHeadOid ?? ""}`)
  lines.push(`- Generation: ${artifact.generation.id}`)
  lines.push(`- BaseOid: ${artifact.generation.baseOid}`)
  lines.push(`- MergeBaseOid: ${artifact.generation.mergeBaseOid}`)
  lines.push(`- HeadOid: ${artifact.generation.headOid}`)
  lines.push(`- SubmittedAt: ${artifact.submittedAt}`)
  if (artifact.projection.kind === "since-last-review") {
    lines.push(`- Projection: since-last-review from ${artifact.projection.fromHeadOid}`)
  } else {
    lines.push(`- Projection: aggregate`)
  }
  lines.push("")
  lines.push(`## Coverage`)
  lines.push("")
  const total = artifact.coverage.viewed.length + artifact.coverage.notViewed.length
  lines.push(`Viewed ${artifact.coverage.viewed.length}/${total}`)
  if (artifact.coverage.viewed.length > 0) {
    lines.push("")
    lines.push(`Viewed files:`)
    for (const v of artifact.coverage.viewed) {
      lines.push(`- ${v.path} (${v.fileKey})`)
    }
  }
  if (artifact.coverage.notViewed.length > 0) {
    lines.push("")
    lines.push(`Not viewed files:`)
    for (const n of artifact.coverage.notViewed) {
      lines.push(`- ${n.path} (${n.fileKey})`)
    }
  }
  lines.push("")

  const blocking = artifact.feedback.filter((f) => f.severity === "blocking")
  const comment = artifact.feedback.filter((f) => f.severity === "comment")

  const filePathByKey = new Map<string, string>()
  for (const v of artifact.coverage.viewed) filePathByKey.set(v.fileKey, v.path)
  for (const n of artifact.coverage.notViewed) filePathByKey.set(n.fileKey, n.path)

  function renderGroup(title: string, group: readonly SubmittedFeedback[]) {
    lines.push(`## ${title}`)
    lines.push("")
    if (group.length === 0) {
      lines.push(`_none_`)
      lines.push("")
      return
    }
    for (const fb of group) {
      const anchor = fb.anchor
      const path = filePathByKey.get(anchor.fileKey) ?? anchor.fileKey
      const location = anchor.kind === "range" ? `${path}:${anchor.startLine}-${anchor.endLine} (${anchor.side})` : `${path} (file)`
      lines.push(`### ${fb.severity} ${fb.kind} at ${location}`)
      lines.push("")
      lines.push(fb.body)
      lines.push("")
      if (fb.kind === "suggestion" && fb.replacement !== undefined) {
        lines.push("```suggestion")
        lines.push(fb.replacement)
        lines.push("```")
        lines.push("")
      }
    }
  }

  renderGroup("Blocking Feedback", blocking)
  renderGroup("Comment Feedback", comment)

  return lines.join("\n")
}
