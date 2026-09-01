import { createReviewDocument } from "../core/document"
import { createReviewGeneration, createReviewIdentity, sha256Tuple } from "../core/identity"
import type { ReviewDocument, ReviewFile, ReviewHunk } from "../core/types"
import { parseReviewPatch } from "./patch-adapter"
import { parseNumstatZ, parseRawDiffZ } from "./raw-diff"
import { listCommits } from "../../git/commits"
import { resolveRefOid } from "../../git/base-inference"
import type { GitRunner } from "../../git/runner"

function normalizePathForJoin(p: string): string {
  return p.replace(/[\r\n]+$/u, "")
}

function kindFromRaw(rawStatus: string, isBinary: boolean): ReviewFile["kind"] {
  if (isBinary) return "binary"
  const letter = rawStatus[0] ?? ""
  if (letter === "R") return "renamed"
  if (letter === "C") return "copied"
  if (letter === "A") return "added"
  if (letter === "D") return "deleted"
  // M, T, U etc are modified
  return "modified"
}

function sourceFromKind(kind: ReviewFile["kind"], isBinary: boolean): ReviewFile["source"] {
  if (isBinary || kind === "binary") return "binary"
  return "available"
}

export async function loadReviewDocument(runner: Pick<GitRunner, "run">, baseRef: string): Promise<ReviewDocument> {
  const baseOid = await resolveRefOid(runner, baseRef)
  if (baseOid === undefined) throw new Error(`base ref does not resolve to a commit: ${baseRef}`)

  const headOid = await resolveRefOid(runner, "HEAD")
  if (headOid === undefined) throw new Error("HEAD does not resolve to a commit")

  const headRefResult = await runner.run(["symbolic-ref", "--quiet", "HEAD"], {
    readOnly: true,
    acceptedExitCodes: [0, 1],
  })
  const headRefRaw = headRefResult.stdout.trim()
  const headRef = headRefResult.exitCode === 0 && headRefRaw.length > 0 ? headRefRaw : null
  const identity =
    headRef === null
      ? createReviewIdentity({ headOid, baseRef })
      : createReviewIdentity({ headRef, headOid, baseRef })
  const range = `${baseRef}...HEAD`

  const [mergeBaseResult, patchResult, rawResult, numstatResult, commits] = await Promise.all([
    runner.run(["merge-base", baseRef, "HEAD"], { readOnly: true }),
    runner.run(["diff", "--no-ext-diff", "--no-color", "--find-renames", "--binary", "--src-prefix=a/", "--dst-prefix=b/", range, "--"], {
      readOnly: true,
    }),
    runner.run(["diff", "--no-ext-diff", "--no-color", "--find-renames", "--raw", "-z", range, "--"], { readOnly: true }),
    runner.run(["diff", "--no-ext-diff", "--no-color", "--find-renames", "--numstat", "-z", range, "--"], { readOnly: true }),
    listCommits(runner, `${baseRef}..HEAD`),
  ])

  const mergeBaseOid = mergeBaseResult.stdout.trim()
  if (!mergeBaseOid) throw new Error(`merge-base did not resolve for ${baseRef}...HEAD`)

  const generation = createReviewGeneration({ baseOid, mergeBaseOid, headOid })

  const patchText = patchResult.stdout
  const rawText = rawResult.stdout
  const numstatText = numstatResult.stdout

  // Empty branch diff is success not error
  const parsedPatches = parseReviewPatch(patchText)
  const rawEntries = parseRawDiffZ(rawText)
  const numstatEntries = parseNumstatZ(numstatText)

  // Build maps for joining, detecting ambiguous duplicates
  const rawByKey = new Map<string, typeof rawEntries[number][]>()
  for (const entry of rawEntries) {
    const key = `${normalizePathForJoin(entry.path)}|${entry.previousPath ? normalizePathForJoin(entry.previousPath) : ""}`
    const list = rawByKey.get(key)
    if (list) list.push(entry)
    else rawByKey.set(key, [entry])
  }

  const numstatByKey = new Map<string, typeof numstatEntries[number][]>()
  for (const entry of numstatEntries) {
    const key = `${normalizePathForJoin(entry.path)}|${entry.previousPath ? normalizePathForJoin(entry.previousPath) : ""}`
    const list = numstatByKey.get(key)
    if (list) list.push(entry)
    else numstatByKey.set(key, [entry])
  }

  // Detect duplicate keys inside patch
  const seenPatchKeys = new Set<string>()
  for (const pf of parsedPatches) {
    const key = `${normalizePathForJoin(pf.path)}|${pf.previousPath ? normalizePathForJoin(pf.previousPath) : ""}`
    if (seenPatchKeys.has(key)) throw new Error(`ambiguous patch join: duplicate path ${key}`)
    seenPatchKeys.add(key)
  }

  // If no files, return empty document (aggregate digest will be sha256Tuple([]))
  if (parsedPatches.length === 0) {
    if (rawEntries.length !== 0) throw new Error(`missing patch for raw entries: ${rawEntries.map((r) => r.path).join(",")}`)
    if (numstatEntries.length !== 0) throw new Error(`missing patch for numstat entries: ${numstatEntries.map((r) => r.path).join(",")}`)
    const commitsForDoc = commits.map((c) => ({
      oid: c.oid,
      parents: [...c.parentOids],
      author: c.authorName,
      timestamp: c.authoredAt ? Date.parse(c.authoredAt) / 1000 : 0,
      subject: c.subject,
      body: c.body,
    })) as unknown as ReviewDocument["commits"]

    return createReviewDocument({ identity, generation, commits: commitsForDoc as ReviewDocument["commits"], files: [] })
  }

  // For each patch file, find raw and numstat
  const files: ReviewFile[] = []
  const matchedRawKeys = new Set<string>()
  const matchedNumstatKeys = new Set<string>()

  for (const pf of parsedPatches) {
    const key = `${normalizePathForJoin(pf.path)}|${pf.previousPath ? normalizePathForJoin(pf.previousPath) : ""}`

    const rawList = rawByKey.get(key)
    if (!rawList || rawList.length === 0) {
      throw new Error(`missing raw entry for patch file ${pf.path}${pf.previousPath ? ` (from ${pf.previousPath})` : ""}`)
    }
    if (rawList.length > 1) {
      throw new Error(`ambiguous raw join for ${pf.path}`)
    }
    const raw = rawList[0]!
    matchedRawKeys.add(key)

    const numstatList = numstatByKey.get(key)
    // numstat may be missing for binary with - and maybe still present; but we require join
    // For deleted files, numstat still present? Let's enforce but allow missing if binary?
    // Instead, if no numstat for this key, try fallback by path only (non-rename) – but spec says reject missing joins
    let numstat = numstatList?.[0]
    if (!numstat) {
      // For some Git versions, numstat for mode-only may be "0\t0\tpath" – still present. So missing is error.
      // For empty patchBinary, numstat may have "-\t-\tpath" – still present as entry with path only.
      // If still not found, try lookup by path without previousPath (for case where patch previousPath undefined but raw has it)
      // That would be missing.
      throw new Error(`missing numstat entry for patch file ${pf.path}`)
    }
    if (numstatList && numstatList.length > 1) throw new Error(`ambiguous numstat join for ${pf.path}`)
    matchedNumstatKeys.add(key)

    // Validate that numstat previousPath matches patch previousPath when applicable
    const patchPrevNorm = pf.previousPath ? normalizePathForJoin(pf.previousPath) : undefined
    const numstatPrevNorm = numstat.previousPath ? normalizePathForJoin(numstat.previousPath) : undefined
    if (patchPrevNorm !== numstatPrevNorm) {
      // If patch indicates rename but numstat not, or vice versa, it's a missing join
      // For pure rename without edits, patch still has previousPath, numstat should too.
      // Enforce equality.
      if (patchPrevNorm !== undefined || numstatPrevNorm !== undefined) {
        throw new Error(`mismatched previousPath for ${pf.path}: patch ${patchPrevNorm} vs numstat ${numstatPrevNorm}`)
      }
    }

    const kind = kindFromRaw(raw.status, pf.isBinary)
    const source = sourceFromKind(kind, pf.isBinary)

    const normalizedHunkBody = pf.normalizedHunkBody
    const contentId = sha256Tuple([raw.oldBlobOid ?? "", raw.newBlobOid ?? "", raw.oldMode ?? "", raw.newMode ?? "", normalizedHunkBody])
    const patchDigest = pf.patchDigest

    const stats = { additions: numstat.additions, deletions: numstat.deletions }

    const hunks: readonly ReviewHunk[] = pf.isBinary ? [] : pf.hunks

    const file: ReviewFile = pf.previousPath
      ? {
          key: pf.path,
          path: pf.path,
          previousPath: pf.previousPath,
          kind,
          oldBlobOid: raw.oldBlobOid,
          newBlobOid: raw.newBlobOid,
          oldMode: raw.oldMode,
          newMode: raw.newMode,
          contentId,
          patchDigest,
          stats,
          hunks,
          source,
        }
      : {
          key: pf.path,
          path: pf.path,
          kind,
          oldBlobOid: raw.oldBlobOid,
          newBlobOid: raw.newBlobOid,
          oldMode: raw.oldMode,
          newMode: raw.newMode,
          contentId,
          patchDigest,
          stats,
          hunks,
          source,
        }

    files.push(file)
  }

  for (const [key, list] of rawByKey) {
    if (!matchedRawKeys.has(key)) {
      throw new Error(`missing patch for raw entries: ${key} (${list.length})`)
    }
  }
  for (const [key] of numstatByKey) {
    if (!matchedNumstatKeys.has(key)) {
      throw new Error(`missing patch for numstat entries: ${key}`)
    }
  }

  const commitsForDoc = commits.map((c) => ({
    oid: c.oid,
    parents: [...c.parentOids],
    author: c.authorName,
    timestamp: c.authoredAt ? Date.parse(c.authoredAt) / 1000 : 0,
    subject: c.subject,
    body: c.body,
  })) as unknown as ReviewDocument["commits"]

  return createReviewDocument({ identity, generation, commits: commitsForDoc as ReviewDocument["commits"], files })
}
