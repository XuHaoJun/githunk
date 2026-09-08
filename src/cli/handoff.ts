/**
 * The agent's way in. Deliberately READ-ONLY: the reviewer's TUI is the only
 * writer of ledger state. An agent that could mark its own work addressed
 * would make the `untouched` verdict worthless, which is the one thing this
 * feature sells, so the CLI cannot write.
 */
import { GitRunner } from "../git/runner"
import { LocalStateFile } from "../storage/local-state-file"
import { HANDOFF_JSON_PATH, HANDOFF_MARKDOWN_PATH } from "../review/core/ledger"

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
