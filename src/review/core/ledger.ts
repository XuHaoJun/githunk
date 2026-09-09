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
import { sortedReviewFeedback } from "./selectors"
import type { ReviewDocument, ReviewFeedback, ReviewFeedbackHandoff } from "./types"

/**
 * What the agent said back, keyed by objection id.
 *
 * Replies live in a file the agent owns, read here as data and never as
 * instruction: the boundary is not "the agent cannot write" but "the agent
 * cannot write the verdict". Words are its own; status and resolution are not.
 * Without this an agent that disagreed had nowhere to put its reasoning, so the
 * argument left the ledger and lived in a chat window.
 */
export type ReviewReplies = ReadonlyMap<string, ReviewReply>

export type ReviewReply = Readonly<{
  id: string
  body: string
  at: string
}>

/**
 * - `open`      never handed off; the reviewer still owns it
 * - `untouched` handed off, and the anchored lines still resolve verbatim —
 *               whoever was asked to act did not touch them
 * - `addressed` handed off, and the anchored lines no longer resolve, so the
 *               code under the objection moved. Says the code changed, NOT
 *               that the change is correct.
 * - `resolved`   a human looked and closed it (fixed elsewhere, or persuaded)
 */
export type LedgerVerdict = "open" | "waiting" | "untouched" | "addressed" | "disputed" | "resolved"

/**
 * `atHeadOid` is the HEAD the current document was built from. Without it a
 * freshly handed-off item reads as `untouched`, which is a lie: nobody has had
 * the chance to commit yet. A verdict only becomes meaningful once HEAD has
 * moved past the handoff.
 */
export function ledgerVerdict(
  feedback: ReviewFeedback,
  atHeadOid?: string,
  options?: Readonly<{ replied?: boolean }>,
): LedgerVerdict {
  if (feedback.status === "resolved") return "resolved"
  if (feedback.status !== "handed-off") return "open"
  if (atHeadOid !== undefined && feedback.handoff?.headOid === atHeadOid) return "waiting"
  if (feedback.resolution !== "active") return "addressed"
  if (
    feedback.anchor.kind === "file"
    && feedback.handoff?.contentId !== undefined
    && feedback.handoff.contentId !== feedback.anchor.contentId
  ) return "addressed"
  // Untouched lines plus an answer is an argument, not an oversight, and it is
  // the one outcome that needs the reviewer to read rather than just look.
  return options?.replied === true ? "disputed" : "untouched"
}

export type LedgerCounts = Readonly<{
  open: number
  waiting: number
  untouched: number
  disputed: number
  addressed: number
  resolved: number
  /** Everything still asking for the reviewer's attention. */
  unsettled: number
}>

export function ledgerCounts(
  feedback: readonly ReviewFeedback[],
  atHeadOid?: string,
  replies?: ReviewReplies,
): LedgerCounts {
  let open = 0
  let waiting = 0
  let untouched = 0
  let disputed = 0
  let addressed = 0
  let resolved = 0
  for (const item of feedback) {
    const verdict = ledgerVerdict(item, atHeadOid, { replied: replies?.has(item.id) === true })
    if (verdict === "open") open++
    else if (verdict === "waiting") waiting++
    else if (verdict === "untouched") untouched++
    else if (verdict === "disputed") disputed++
    else if (verdict === "addressed") addressed++
    else resolved++
  }
  return {
    open, waiting, untouched, disputed, addressed, resolved,
    unsettled: open + waiting + untouched + disputed + addressed,
  }
}

export function ledgerBadge(verdict: LedgerVerdict): string {
  if (verdict === "waiting") return "handed-off"
  if (verdict === "disputed") return "DISPUTED"
  if (verdict === "untouched") return "UNTOUCHED"
  if (verdict === "addressed") return "addressed"
  if (verdict === "resolved") return "resolved"
  return "open"
}

/** The one-line ledger summary for the workspace header; empty when nothing is tracked. */
export function ledgerHeaderText(
  feedback: readonly ReviewFeedback[],
  atHeadOid?: string,
  replies?: ReviewReplies,
): string {
  const counts = ledgerCounts(feedback, atHeadOid, replies)
  const parts: string[] = []
  if (counts.open > 0) parts.push(`${counts.open} open`)
  if (counts.waiting > 0) parts.push(`${counts.waiting} handed off`)
  if (counts.addressed > 0) parts.push(`${counts.addressed} addressed`)
  if (counts.disputed > 0) parts.push(`${counts.disputed} DISPUTED`)
  if (counts.untouched > 0) parts.push(`${counts.untouched} UNTOUCHED`)
  if (counts.resolved > 0) parts.push(`${counts.resolved} resolved`)
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

/**
 * Every objection as one line, for a jump list.
 *
 * `{` and `}` walk the ledger one step at a time, which is fine for two and
 * useless for twenty: you cannot see the shape of what is left, or pick. This
 * is the same information GitLab puts above a merge request as its unresolved
 * thread counter and navigator.
 */
export type ObjectionListEntry = Readonly<{
  id: string
  verdict: LedgerVerdict
  text: string
}>

export function objectionList(
  state: Pick<ReviewState, "document" | "feedback">,
  atHeadOid?: string,
  replies?: ReviewReplies,
): readonly ObjectionListEntry[] {
  return sortedReviewFeedback(state).map((feedback) => {
    const verdict = ledgerVerdict(feedback, atHeadOid, { replied: replies?.has(feedback.id) === true })
    const path = pathForFeedback(state.document, feedback)
    const where = feedback.anchor.kind === "range"
      ? `${path}:${feedback.anchor.startLine}`
      : path
    const body = feedback.body.replace(/\s+/gu, " ").trim()
    const mark = feedback.severity === "blocking" ? "!" : "◆"
    return {
      id: feedback.id,
      verdict,
      text: `${ledgerBadge(verdict).padEnd(10)} ${mark} ${where}  ${body.length > 0 ? body : "(empty)"}`,
    }
  })
}

// ---------------------------------------------------------------------------
// The agent's mailbox
//
// Everything below produces the file an agent reads to learn what the reviewer
// wants changed. A mailbox rather than a connection: githunk writes it and
// stops, the agent reads it whenever it likes, and neither has to be running
// for the other to work. hunk does the same job over a loopback daemon and its
// own guide documents how to debug an agent sandbox blocking the port
// (learn-projects/hunk/docs/agent-workflows.md); a file under the git directory
// has no port to block, survives ssh, and any language can read it.
//
// Written on `A`, read back through `githunk handoff [--json]`. That CLI is
// read-only on purpose: an agent able to mark its own work addressed would make
// the `untouched` verdict worthless, and that verdict is the whole point.
// ---------------------------------------------------------------------------

/** Paths relative to the git directory, in githunk's usual `githunk/` namespace. */
export const HANDOFF_JSON_PATH = "githunk/handoff/pending.json"
export const HANDOFF_MARKDOWN_PATH = "githunk/handoff/pending.md"
/** Written by the agent, read by githunk. Separate file, separate owner, no lock. */
export const HANDOFF_REPLIES_PATH = "githunk/handoff/replies.json"

/** Parse the agent's reply file, treating anything malformed as no replies at all. */
export function parseReviewReplies(raw: string | undefined): ReviewReplies {
  const out = new Map<string, ReviewReply>()
  if (raw === undefined || raw.trim() === "") return out
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return out
  }
  if (typeof parsed !== "object" || parsed === null) return out
  const replies = (parsed as { replies?: unknown }).replies
  if (!Array.isArray(replies)) return out
  for (const entry of replies) {
    if (typeof entry !== "object" || entry === null) continue
    const { id, body, at } = entry as { id?: unknown; body?: unknown; at?: unknown }
    if (typeof id !== "string" || id.trim() === "" || typeof body !== "string" || body.trim() === "") continue
    out.set(id, { id, body, at: typeof at === "string" ? at : "" })
  }
  return out
}

export function serializeReviewReplies(replies: readonly ReviewReply[]): string {
  return `${JSON.stringify({ version: 1, replies }, null, 2)}\n`
}

/** One objection as the agent sees it: enough to locate the lines and read the ask. */
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

/**
 * The JSON contract at HANDOFF_JSON_PATH. `version` is the promise to whoever
 * parses it; the markdown beside it is the same content for a reader who would
 * rather not parse anything.
 */
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
    .filter((feedback) => feedback.resolution === "active" && ledgerVerdict(feedback) !== "resolved")
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
  const side = item.side === null ? "" : ` (${item.side} side)`
  return `${item.path}:${lines}${side}`
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
    "If you disagree with one, say so instead of quietly skipping it:",
    "",
    "    githunk handoff reply --id <id> --body \"why you did not make this change\"",
    "",
    "The reviewer sees your answer next to their objection. It does not settle the",
    "objection — an answered item whose lines are unchanged comes back DISPUTED, which",
    "is a question for them, not a verdict for you.",
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
