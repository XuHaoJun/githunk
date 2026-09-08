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
import { LocalStateFile } from "../storage/local-state-file"
import {
  HANDOFF_JSON_PATH,
  HANDOFF_MARKDOWN_PATH,
  HANDOFF_REPLIES_PATH,
  parseReviewReplies,
  serializeReviewReplies,
  type ReviewReply,
} from "../review/core/ledger"

export type HandoffOutcome = { readonly text: string; readonly exitCode: number }

export async function runHandoff(input: { json: boolean; cwd: string }): Promise<HandoffOutcome> {
  const runner = new GitRunner({ cwd: input.cwd })
  const file = new LocalStateFile({
    runner,
    relativePath: input.json ? HANDOFF_JSON_PATH : HANDOFF_MARKDOWN_PATH,
    pathKind: "handoff",
  })
  let text: string | undefined
  try {
    text = await file.readText()
  } catch (error) {
    return { text: error instanceof Error ? error.message : String(error), exitCode: 1 }
  }
  if (text === undefined) {
    return {
      text: "No handoff yet. Open githunk, review the branch, and press H to hand off open feedback.",
      exitCode: 1,
    }
  }
  return { text, exitCode: 0 }
}

export async function runHandoffReply(input: { id: string; body: string; cwd: string }): Promise<HandoffOutcome> {
  const runner = new GitRunner({ cwd: input.cwd })
  const file = new LocalStateFile({ runner, relativePath: HANDOFF_REPLIES_PATH, pathKind: "handoff" })
  try {
    const existing = parseReviewReplies(await file.readText())
    const at = new Date().toISOString()
    const next = new Map<string, ReviewReply>(existing)
    next.set(input.id, { id: input.id, body: input.body, at })
    await file.writeText(serializeReviewReplies([...next.values()]))
    return { text: `Replied to ${input.id}.`, exitCode: 0 }
  } catch (error) {
    return { text: error instanceof Error ? error.message : String(error), exitCode: 1 }
  }
}
