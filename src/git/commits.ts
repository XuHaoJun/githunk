import type { CommitDetails, CommitSummary } from "../domain/commit"
import type { DiffDocument } from "../domain/diff/document"
import { parseDiff } from "../domain/diff/parse"
import { GitRunner } from "./runner"

type CommandRunner = Pick<GitRunner, "run">

/** Each commit is one NUL record; the seven fields are line-framed. */
const LOG_FORMAT = "%H%n%h%n%P%n%an%n%aI%n%s%n%b"

function parseSummary(record: string): CommitSummary | undefined {
  const fields = record.split("\n")
  if (fields.length < 7) return undefined
  const oid = fields[0]!
  const shortOid = fields[1]!
  const parents = fields[2]!
  const authorName = fields[3]!
  const authoredAt = fields[4]!
  const subject = fields[5]!
  if (!oid || !shortOid || !authorName || !authoredAt) return undefined
  return {
    oid,
    shortOid,
    parentOids: parents === "" ? [] : parents.split(" ").filter(Boolean),
    authorName,
    authoredAt,
    subject,
    body: fields.slice(6).join("\n"),
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
function detailsFromShow(raw: string, oid: string, parentOids: readonly string[]): CommitDetails {
  const headerEnd = raw.indexOf("\n\n")
  const messageStart = headerEnd < 0 ? raw.length : headerEnd + 2
  const patchText = patchFromShow(raw)
  const patchOffset = patchText.length === 0 ? raw.length : raw.indexOf(patchText, messageStart)
  const preambleEnd = patchOffset < 0 ? raw.length : patchOffset
  const preamble = raw.slice(0, preambleEnd)
  const messageLines = raw.slice(messageStart, preambleEnd < 0 ? raw.length : preambleEnd).replace(/\n+$/, "").split(/\r?\n/)
  const lines = messageLines.map((line) => line.startsWith("    ") ? line.slice(4) : line)
  const subject = lines.shift() ?? ""
  const body = lines.join("\n").replace(/^\n+/, "").replace(/\n+$/, "")
  const authorName = (metadataValue(raw, "Author") ?? "").trim()
  const authoredAt = metadataValue(raw, "AuthorDate") ?? ""
  const shortOid = oid.slice(0, 7)
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
    preamble,
  }
}

async function parentOidsFor(runner: CommandRunner, oid: string): Promise<readonly string[]> {
  const result = await runner.run(["rev-list", "--parents", "-n", "1", oid], { readOnly: true })
  const fields = result.stdout.trim().split(/\s+/)
  return fields.slice(1)
}

export async function loadCommit(runner: CommandRunner, oid: string): Promise<CommitDetails> {
  const result = await runner.run(["show", "--format=fuller", "--no-ext-diff", "--no-color", "--find-renames", "--binary", "--stat", "-m", oid, "--"], { readOnly: true })
  const parents = await parentOidsFor(runner, oid)
  return detailsFromShow(result.stdout, oid, parents)
}

export async function loadCommitFilePatch(runner: CommandRunner, oid: string, path: string): Promise<DiffDocument> {
  const result = await runner.run(["show", "--format=fuller", "--no-ext-diff", "--no-color", "--find-renames", "--binary", "-m", oid, "--", path], { readOnly: true })
  return parseDiff(patchFromShow(result.stdout))
}
