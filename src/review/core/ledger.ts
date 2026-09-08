/**
 * Derives the verdict on a piece of feedback from the pair
 * (`status`, `resolution`) and renders the handoff mailbox.
 *
 * The verdict is derived, never stored, because both inputs are already
 * maintained: `reconcileAnchor` (src/review/core/anchors.ts) recomputes
 * `resolution` on every generation, and `status` only ever moves on an
 * explicit user act. Nothing here runs Git.
 */
import type { ReviewState } from "./state"
import type { ReviewDocument, ReviewFeedback, ReviewFeedbackHandoff } from "./types"

/**
 * - `open`      never handed off; the reviewer still owns it
 * - `untouched` handed off, and the anchored lines still resolve verbatim —
 *               whoever was asked to act did not touch them
 * - `addressed` handed off, and the anchored lines no longer resolve, so the
 *               code under the objection moved. Says the code changed, NOT
 *               that the change is correct.
 * - `retired`   a human looked and closed it (fixed elsewhere, or persuaded)
 */
export type LedgerVerdict = "open" | "waiting" | "untouched" | "addressed" | "retired"

/**
 * `atHeadOid` is the HEAD the current document was built from. Without it a
 * freshly handed-off item reads as `untouched`, which is a lie: nobody has had
 * the chance to commit yet. A verdict only becomes meaningful once HEAD has
 * moved past the handoff.
 */
export function ledgerVerdict(feedback: ReviewFeedback, atHeadOid?: string): LedgerVerdict {
  if (feedback.status === "retired") return "retired"
  if (feedback.status !== "handed-off") return "open"
  if (atHeadOid !== undefined && feedback.handoff?.headOid === atHeadOid) return "waiting"
  return feedback.resolution === "active" ? "untouched" : "addressed"
}

export type LedgerCounts = Readonly<{
  open: number
  waiting: number
  untouched: number
  addressed: number
  retired: number
  /** Everything still asking for the reviewer's attention. */
  unsettled: number
}>

export function ledgerCounts(feedback: readonly ReviewFeedback[], atHeadOid?: string): LedgerCounts {
  let open = 0
  let waiting = 0
  let untouched = 0
  let addressed = 0
  let retired = 0
  for (const item of feedback) {
    const verdict = ledgerVerdict(item, atHeadOid)
    if (verdict === "open") open++
    else if (verdict === "waiting") waiting++
    else if (verdict === "untouched") untouched++
    else if (verdict === "addressed") addressed++
    else retired++
  }
  return { open, waiting, untouched, addressed, retired, unsettled: open + waiting + untouched + addressed }
}

export function ledgerBadge(verdict: LedgerVerdict): string {
  if (verdict === "waiting") return "handed-off"
  if (verdict === "untouched") return "UNTOUCHED"
  if (verdict === "addressed") return "addressed"
  if (verdict === "retired") return "retired"
  return "open"
}

/** The one-line ledger summary for the workspace header; empty when nothing is tracked. */
export function ledgerHeaderText(feedback: readonly ReviewFeedback[], atHeadOid?: string): string {
  const counts = ledgerCounts(feedback, atHeadOid)
  const parts: string[] = []
  if (counts.open > 0) parts.push(`${counts.open} open`)
  if (counts.waiting > 0) parts.push(`${counts.waiting} handed off`)
  if (counts.addressed > 0) parts.push(`${counts.addressed} addressed`)
  if (counts.untouched > 0) parts.push(`${counts.untouched} UNTOUCHED`)
  if (counts.retired > 0) parts.push(`${counts.retired} retired`)
  return parts.join(" · ")
}

/**
 * The most recent handoff, as a checkpoint to diff from.
 *
 * A handoff is a sharper checkpoint than a finished review for "what changed
 * since": it is the exact moment the reviewer asked someone to change things.
 */
export function latestHandoff(
  feedback: readonly ReviewFeedback[],
): Readonly<{ at: string; headOid: string }> | undefined {
  let latest: ReviewFeedbackHandoff | undefined
  for (const item of feedback) {
    const handoff = item.handoff
    if (handoff === undefined) continue
    if (latest === undefined || handoff.at > latest.at) latest = handoff
  }
  return latest
}

/**
 * The point "what changed since" is measured from: the later of the last
 * finished review and the last handoff. Both stamps come from the same clock,
 * so the comparison needs no Git.
 */
export type ReviewCheckpoint = Readonly<{ kind: "submission" | "handoff"; at: string; headOid: string }>

export function reviewCheckpoint(
  state: Pick<ReviewState, "feedback" | "lastSubmission">,
): ReviewCheckpoint | undefined {
  const handoff = latestHandoff(state.feedback)
  const submission = state.lastSubmission
  if (!submission) return handoff && { kind: "handoff", at: handoff.at, headOid: handoff.headOid }
  if (!handoff || submission.submittedAt >= handoff.at) {
    return { kind: "submission", at: submission.submittedAt, headOid: submission.headOid }
  }
  return { kind: "handoff", at: handoff.at, headOid: handoff.headOid }
}

// ---------------------------------------------------------------------------
// Mailbox
// ---------------------------------------------------------------------------

/** Paths relative to the git directory, in githunk's usual `githunk/` namespace. */
export const HANDOFF_JSON_PATH = "githunk/handoff/pending.json"
export const HANDOFF_MARKDOWN_PATH = "githunk/handoff/pending.md"

export type HandoffItem = Readonly<{
  id: string
  path: string
  side: "old" | "new" | null
  startLine: number | null
  endLine: number | null
  severity: "comment" | "blocking"
  kind: "note" | "suggestion"
  body: string
  replacement?: string
}>

export type HandoffMailbox = Readonly<{
  version: 1
  generatedAt: string
  reviewId: string
  headOid: string
  baseRef: string | null
  items: readonly HandoffItem[]
}>

function pathForFeedback(document: ReviewDocument, feedback: ReviewFeedback): string {
  return document.files.find((file) => file.key === feedback.anchor.fileKey)?.path ?? feedback.anchor.fileKey
}

export function buildHandoffMailbox(
  state: Pick<ReviewState, "document" | "feedback">,
  input: { generatedAt: string; headOid: string },
): HandoffMailbox {
  const items = state.feedback
    .filter((feedback) => ledgerVerdict(feedback) !== "retired")
    .map((feedback): HandoffItem => {
      const range = feedback.anchor.kind === "range" ? feedback.anchor : null
      return {
        id: feedback.id,
        path: pathForFeedback(state.document, feedback),
        side: range?.side ?? null,
        startLine: range?.startLine ?? null,
        endLine: range?.endLine ?? null,
        severity: feedback.severity,
        kind: feedback.kind,
        body: feedback.body,
        ...(feedback.replacement === undefined ? {} : { replacement: feedback.replacement }),
      }
    })
  return {
    version: 1,
    generatedAt: input.generatedAt,
    reviewId: state.document.identity.id,
    headOid: input.headOid,
    baseRef: state.document.identity.baseRef ?? null,
    items,
  }
}

function locationText(item: HandoffItem): string {
  if (item.startLine === null) return item.path
  const lines = item.startLine === item.endLine ? `${item.startLine}` : `${item.startLine}-${item.endLine}`
  return `${item.path}:${lines}`
}

export function renderHandoffMarkdown(mailbox: HandoffMailbox): string {
  const lines: string[] = []
  lines.push("# githunk — open objections")
  lines.push("")
  lines.push(`Handed off at ${mailbox.generatedAt} from HEAD ${mailbox.headOid.slice(0, 12)}.`)
  lines.push("")
  if (mailbox.items.length === 0) {
    lines.push("Nothing outstanding.")
    lines.push("")
    return lines.join("\n")
  }
  lines.push(
    "Address each item below. Do NOT report these as done — githunk decides whether an",
    "item was addressed by re-anchoring it against your commits. An item whose lines you",
    "leave byte-identical comes back marked UNTOUCHED.",
    "",
  )
  for (const item of mailbox.items) {
    const mark = item.severity === "blocking" ? "!" : "-"
    lines.push(`${mark} [${item.id}] ${locationText(item)}`)
    for (const bodyLine of item.body.split("\n")) lines.push(`      ${bodyLine}`)
    if (item.replacement !== undefined) {
      lines.push("      suggested replacement:")
      for (const replacementLine of item.replacement.split("\n")) lines.push(`        ${replacementLine}`)
    }
    lines.push("")
  }
  return lines.join("\n")
}
