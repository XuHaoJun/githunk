import type { ReflogEntry } from "../domain/reflog"
import { reflogEntryId, shortHash } from "../domain/reflog"
import { GitRunner } from "./runner"
import { parseNulFields } from "./parse"

type CommandRunner = Pick<GitRunner, "run">

/** Matches lazygit's reflog walk (`reflog_commit_loader.go`): hash, commit time, reflog subject, parents. */
const REFLOG_FORMAT = "%H%x00%ct%x00%gs%x00%P"

/**
 * Cap on loaded entries. lazygit bounds a limited commit walk with `-300`
 * (`commit_loader.go`); a reflog is unbounded and can run to thousands of
 * entries, so the same figure bounds it here.
 */
export const REFLOG_LIMIT = 300

export type ReflogListOptions = {
  /** Whose reflog to walk; defaults to `HEAD`. */
  readonly ref?: string
  readonly limit?: number
}

export function parseReflog(raw: string, ref = "HEAD"): readonly ReflogEntry[] {
  const records = parseNulFields(raw, 4)
  const seen = new Map<string, number>()
  const entries: ReflogEntry[] = []
  for (const [index, fields] of records.entries()) {
    const oid = fields[0] ?? ""
    if (oid.length === 0) continue
    const subject = fields[2] ?? ""
    const parents = fields[3] ?? ""
    const committedAtUnix = Number.parseInt(fields[1] ?? "", 10)
    const seconds = Number.isNaN(committedAtUnix) ? 0 : committedAtUnix
    const key = `${oid}\0${subject}`
    const occurrence = seen.get(key) ?? 0
    seen.set(key, occurrence + 1)
    entries.push({
      id: reflogEntryId(oid, subject, occurrence),
      oid,
      shortOid: shortHash(oid),
      parentOids: parents === "" ? [] : parents.split(" ").filter(Boolean),
      subject,
      committedAt: new Date(seconds * 1000).toISOString(),
      committedAtUnix: seconds,
      index,
      selector: `${ref}@{${index}}`,
    })
  }
  return entries
}

export async function listReflog(runner: CommandRunner, options: ReflogListOptions = {}): Promise<readonly ReflogEntry[]> {
  const ref = options.ref ?? "HEAD"
  const limit = options.limit ?? REFLOG_LIMIT
  const args = ["-c", "log.showSignature=false", "log", "-g", "-z", `--format=${REFLOG_FORMAT}`, ref, "-n", String(limit)]
  // A fresh repository, `core.logAllRefUpdates=false`, or an expired reflog all
  // make git exit 128 ("no reflog", "does not have any commits yet"); an empty
  // Reflog tab is the honest answer rather than an error.
  const result = await runner.run(args, { readOnly: true, acceptedExitCodes: [0, 128] })
  if (result.exitCode !== 0) return []
  return parseReflog(result.stdout, ref)
}
