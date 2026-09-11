/**
 * The agent's way in and its way to answer back.
 *
 * It cannot write ledger state: the reviewer's TUI is the only writer of
 * status and resolution, because an agent that could mark its own work
 * addressed would make the `untouched` verdict worthless. Replies are a
 * different thing — the agent's own words in the agent's own file, which
 * githunk reads as data. Separate files, separate owners, no lock.
 */
import { GitRunner } from "../git/runner"
import { z } from "zod"
import { LocalStateFile } from "../storage/local-state-file"
import { HANDOFF_JSON_PATH, HANDOFF_MARKDOWN_PATH, HANDOFF_REPLIES_PATH, parseReviewReplies, renderHandoffMarkdown, serializeReviewReplies, type HandoffMailbox, type ReviewReply } from "../review/core/ledger"

export type HandoffOutcome = { readonly text: string; readonly exitCode: number }
const handoffMailboxSchema = z
  .object({
    items: z.array(z.object({ id: z.string().min(1) }).passthrough())
  })
  .passthrough()
const canonicalHandoffSchema = z
  .object({
    version: z.literal(1),
    generatedAt: z.string(),
    reviewId: z.string(),
    headOid: z.string(),
    baseRef: z.string().nullable(),
    items: z.array(
      z
        .object({
          id: z.string().min(1),
          path: z.string(),
          side: z.enum(["old", "new"]).nullable(),
          startLine: z.number().int().nullable(),
          endLine: z.number().int().nullable(),
          severity: z.enum(["comment", "blocking"]),
          kind: z.enum(["note", "suggestion"]),
          body: z.string(),
          replacement: z.string().optional()
        })
        .strict()
    )
  })
  .strict()

function parseCanonicalHandoff(raw: string | undefined): HandoffMailbox | undefined {
  if (raw === undefined || raw.trim() === "") return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return undefined
  }
  const result = canonicalHandoffSchema.safeParse(parsed)
  return result.success ? (result.data as HandoffMailbox) : undefined
}
const replyFileSchema = z
  .object({
    version: z.literal(1).optional(),
    replies: z.array(
      z
        .object({
          id: z
            .string()
            .min(1)
            .refine((id) => id.trim() !== ""),
          body: z.string().refine((body) => body.trim() !== ""),
          at: z.string().optional()
        })
        .strict()
    )
  })
  .strict()

function handoffContainsId(raw: string | undefined, id: string): boolean {
  if (raw === undefined || raw.trim() === "") return false
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return false
  }
  const mailbox = handoffMailboxSchema.safeParse(parsed)
  return mailbox.success && mailbox.data.items.some((item) => item.id === id)
}

export async function runHandoff(input: { json: boolean; cwd: string }): Promise<HandoffOutcome> {
  const runner = new GitRunner({ cwd: input.cwd })
  const jsonFile = new LocalStateFile({ runner, relativePath: HANDOFF_JSON_PATH, pathKind: "handoff" })
  let text: string | undefined
  try {
    if (input.json) {
      text = await jsonFile.readText()
    } else {
      // JSON is the durable mailbox; markdown is a convenience rendering.
      // Reading the canonical file here keeps a crash between the two atomic
      // renames from making the CLI show an older handoff.
      const canonical = parseCanonicalHandoff(await jsonFile.readText())
      if (canonical !== undefined) {
        text = renderHandoffMarkdown(canonical)
      } else {
        const markdownFile = new LocalStateFile({ runner, relativePath: HANDOFF_MARKDOWN_PATH, pathKind: "handoff" })
        text = await markdownFile.readText()
      }
    }
  } catch (error) {
    return { text: error instanceof Error ? error.message : String(error), exitCode: 1 }
  }
  if (text === undefined) {
    return {
      text: "No handoff yet. Open githunk, review the branch, and press A to hand off open feedback.",
      exitCode: 1
    }
  }
  return { text, exitCode: 0 }
}

export async function runHandoffReply(input: { id: string; body: string; cwd: string }): Promise<HandoffOutcome> {
  if (input.id.trim() === "" || input.body.trim() === "") {
    return { text: "handoff reply requires a non-empty id and body", exitCode: 1 }
  }
  const runner = new GitRunner({ cwd: input.cwd })
  const mailboxFile = new LocalStateFile({ runner, relativePath: HANDOFF_JSON_PATH, pathKind: "handoff" })
  const file = new LocalStateFile({ runner, relativePath: HANDOFF_REPLIES_PATH, pathKind: "handoff" })
  try {
    const mailbox = await mailboxFile.readText()
    if (!handoffContainsId(mailbox, input.id)) {
      return { text: `objection not found in the current handoff: ${input.id}`, exitCode: 1 }
    }
    const rawReplies = await file.readText()
    let parsedReplies: unknown = { replies: [] }
    if (rawReplies !== undefined && rawReplies.trim() !== "") {
      try {
        parsedReplies = JSON.parse(rawReplies)
      } catch {
        throw new Error("handoff replies file is malformed")
      }
    }
    if (!replyFileSchema.safeParse(parsedReplies).success) {
      throw new Error("handoff replies file is malformed")
    }
    const existing = parseReviewReplies(rawReplies)
    const at = new Date().toISOString()
    const next = new Map<string, ReviewReply>(existing)
    next.set(input.id, { id: input.id, body: input.body, at })
    await file.writeText(serializeReviewReplies([...next.values()]))
    return { text: `Replied to ${input.id}.`, exitCode: 0 }
  } catch (error) {
    return { text: error instanceof Error ? error.message : String(error), exitCode: 1 }
  }
}
