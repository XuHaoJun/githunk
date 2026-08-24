import type { CommitDetails, CommitSummary } from "../domain/commit"
import type { DiffDocument } from "../domain/diff/document"
import { parseDiff } from "../domain/diff/parse"
import { GitRunner } from "./runner"

type CommandRunner = Pick<GitRunner, "run">

/** `%x1f` separates fields; `-z` terminates each record with NUL. */
const LOG_FORMAT = "%H%x1f%h%x1f%P%x1f%an%x1f%aI%x1f%s%x1f%b"

function parseSummary(record: string): CommitSummary | undefined {
  const fields = record.split("\x1f")
  if (fields.length < 7) return undefined
  const [oid, shortOid, parents, authorName, authoredAt, subject, ...bodyFields] = fields
  if (!oid || !shortOid || !authorName || !authoredAt || subject === undefined) return undefined
  return {
    oid,
    shortOid,
    parentOids: parents === undefined || parents === "" ? [] : parents.split(" ").filter(Boolean),
    authorName,
    authoredAt,
    subject,
    body: bodyFields.join("\x1f"),
  }
}

export function parseCommitLog(raw: string): readonly CommitSummary[] {
  return raw.split("\0").map(parseSummary).filter((summary): summary is CommitSummary => summary !== undefined)
}

export async function listCommits(runner: CommandRunner, range: string, filter?: string): Promise<readonly CommitSummary[]> {
  const args = ["log", "-z", `--format=${LOG_FORMAT}`, range]
  if (filter !== undefined && filter.length > 0) args.push("--", filter)
  const result = await runner.run(args, { readOnly: true })
  return parseCommitLog(result.stdout)
}

function patchFromShow(raw: string): string {
  const match = /(?:^|\n)(diff --(?:git|cc) )/.exec(raw)
  if (match === null || match.index === undefined) return ""
  return raw.slice(match.index + (match[0].startsWith("\n") ? 1 : 0))
}

function metadataValue(raw: string, label: string): string | undefined {
  const match = new RegExp(`^${label}: ([^\\n]*)$`, "m").exec(raw)
  return match?.[1]
}

function detailsFromShow(raw: string, oid: string): CommitDetails {
  const headerEnd = raw.indexOf("\n\n")
  const messageStart = headerEnd < 0 ? raw.length : headerEnd + 2
  const patchText = patchFromShow(raw)
  const patchOffset = patchText.length === 0 ? raw.length : raw.indexOf(patchText, messageStart)
  const messageLines = raw.slice(messageStart, patchOffset < 0 ? raw.length : patchOffset).replace(/\n+$/, "").split(/\r?\n/)
  const lines = messageLines.map((line) => line.startsWith("    ") ? line.slice(4) : line)
  const subject = lines.shift() ?? ""
  const body = lines.join("\n").replace(/^\n+/, "").replace(/\n+$/, "")
  const authorName = metadataValue(raw, "Author") ?? ""
  const authoredAt = metadataValue(raw, "AuthorDate") ?? ""
  const shortOid = oid.slice(0, 7)
  const parentLine = /^Merge: (.*)$/m.exec(raw)?.[1] ?? metadataValue(raw, "Parent") ?? ""
  const parentOids = parentLine === "" ? [] : parentLine.split(/\s+/).filter(Boolean)
  const document = parseDiff(patchText)
  return {
    oid,
    shortOid,
    parentOids,
    authorName,
    authoredAt,
    subject,
    body,
    document,
    patch: document,
    raw,
  }
}

export async function loadCommit(runner: CommandRunner, oid: string): Promise<CommitDetails> {
  const result = await runner.run(["show", "--format=fuller", "--no-ext-diff", "--no-color", "--find-renames", "--binary", oid, "--"], { readOnly: true })
  return detailsFromShow(result.stdout, oid)
}

export async function loadCommitFilePatch(runner: CommandRunner, oid: string, path: string): Promise<DiffDocument> {
  const result = await runner.run(["show", "--format=fuller", "--no-ext-diff", "--no-color", "--find-renames", "--binary", oid, "--", path], { readOnly: true })
  return parseDiff(patchFromShow(result.stdout))
}
