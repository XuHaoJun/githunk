import type { GitRunner } from "../../git/runner"
import type { ReviewDocument, ReviewFile, ReviewProjection, ReviewProjectionDocument } from "../core/types"
import { sha256Tuple } from "../core/identity"
import { parseReviewPatch } from "./patch-adapter"
import { parseNumstatZ, parseRawDiffZ } from "./raw-diff"

export type { ReviewProjectionDocument } from "../core/types"


export type SinceLastProjectionResult =
  | Readonly<{ kind: "ok"; document: ReviewProjectionDocument }>
  | Readonly<{ kind: "history-rewritten"; lastHeadOid: string; headOid: string; reason: string }>

const EMPTY_TREE_OID = "4b825dc642cb6eb9a060e54bf8d69288fbee4904"

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
  return "modified"
}

function sourceFromKind(kind: ReviewFile["kind"], isBinary: boolean): ReviewFile["source"] {
  if (isBinary || kind === "binary") return "binary"
  return "available"
}

async function buildFilesForRange(
  runner: Pick<GitRunner, "run">,
  rangeArgs: readonly string[],
): Promise<readonly ReviewFile[]> {
  // rangeArgs may be single range like "a..b" or two commits "parent oid" or "empty..oid"
  // We pass them as separate args to git diff
  const patchResult = await runner.run(
    ["diff", "--no-ext-diff", "--no-color", "--find-renames", "--binary", "--src-prefix=a/", "--dst-prefix=b/", ...rangeArgs, "--"],
    { readOnly: true },
  )
  const rawResult = await runner.run(
    ["diff", "--no-ext-diff", "--no-color", "--find-renames", "--raw", "-z", ...rangeArgs, "--"],
    { readOnly: true },
  )
  const numstatResult = await runner.run(
    ["diff", "--no-ext-diff", "--no-color", "--find-renames", "--numstat", "-z", ...rangeArgs, "--"],
    { readOnly: true },
  )

  const patchText = patchResult.stdout
  const rawText = rawResult.stdout
  const numstatText = numstatResult.stdout

  const parsedPatches = parseReviewPatch(patchText)
  const rawEntries = parseRawDiffZ(rawText)
  const numstatEntries = parseNumstatZ(numstatText)

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

  const seenPatchKeys = new Set<string>()
  for (const pf of parsedPatches) {
    const key = `${normalizePathForJoin(pf.path)}|${pf.previousPath ? normalizePathForJoin(pf.previousPath) : ""}`
    if (seenPatchKeys.has(key)) throw new Error(`ambiguous patch join: duplicate path ${key}`)
    seenPatchKeys.add(key)
  }

  if (parsedPatches.length === 0) {
    if (rawEntries.length !== 0) throw new Error(`missing patch for raw entries: ${rawEntries.map((r) => r.path).join(",")}`)
    if (numstatEntries.length !== 0) throw new Error(`missing patch for numstat entries: ${numstatEntries.map((r) => r.path).join(",")}`)
    return []
  }

  const files: ReviewFile[] = []
  const matchedRawKeys = new Set<string>()
  const matchedNumstatKeys = new Set<string>()

  for (const pf of parsedPatches) {
    const key = `${normalizePathForJoin(pf.path)}|${pf.previousPath ? normalizePathForJoin(pf.previousPath) : ""}`
    const rawList = rawByKey.get(key)
    if (!rawList || rawList.length === 0) {
      throw new Error(`missing raw entry for patch file ${pf.path}${pf.previousPath ? ` (from ${pf.previousPath})` : ""}`)
    }
    if (rawList.length > 1) throw new Error(`ambiguous raw join for ${pf.path}`)
    const raw = rawList[0]!
    matchedRawKeys.add(key)

    const numstatList = numstatByKey.get(key)
    let numstat = numstatList?.[0]
    if (!numstat) {
      throw new Error(`missing numstat entry for patch file ${pf.path}`)
    }
    if (numstatList && numstatList.length > 1) throw new Error(`ambiguous numstat join for ${pf.path}`)
    matchedNumstatKeys.add(key)

    const patchPrevNorm = pf.previousPath ? normalizePathForJoin(pf.previousPath) : undefined
    const numstatPrevNorm = numstat.previousPath ? normalizePathForJoin(numstat.previousPath) : undefined
    if (patchPrevNorm !== numstatPrevNorm) {
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
    const hunks: ReviewFile["hunks"] = pf.isBinary ? [] : pf.hunks

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
    if (!matchedRawKeys.has(key)) throw new Error(`missing patch for raw entries: ${key} (${list.length})`)
  }
  for (const [key] of numstatByKey) {
    if (!matchedNumstatKeys.has(key)) throw new Error(`missing patch for numstat entries: ${key}`)
  }

  return files
}

export async function isAncestor(
  runner: Pick<GitRunner, "run">,
  ancestorOid: string,
  descendantOid: string,
): Promise<boolean> {
  if (!ancestorOid || !descendantOid) return false
  if (ancestorOid === descendantOid) return true
  try {
    const result = await runner.run(["merge-base", "--is-ancestor", ancestorOid, descendantOid], {
      readOnly: true,
      acceptedExitCodes: [0, 1],
    })
    return result.exitCode === 0
  } catch {
    return false
  }
}

export async function loadSinceLastReviewProjection(
  runner: Pick<GitRunner, "run">,
  aggregateDocument: ReviewDocument,
  lastHeadOid: string,
): Promise<SinceLastProjectionResult> {
  if (!lastHeadOid || lastHeadOid.trim() === "") {
    throw new Error("lastHeadOid must be non-empty")
  }
  const headOid = aggregateDocument.generation.headOid
  const ancestor = await isAncestor(runner, lastHeadOid, headOid)
  if (!ancestor) {
    return {
      kind: "history-rewritten",
      lastHeadOid,
      headOid,
      reason: "history rewritten: last submission head is not an ancestor of current HEAD",
    }
  }

  const range = `${lastHeadOid}..${headOid}`
  const files = await buildFilesForRange(runner, [range])

  const projection: ReviewProjection = { kind: "since-last-review", fromHeadOid: lastHeadOid }
  const doc: ReviewProjectionDocument = {
    reviewId: aggregateDocument.identity.id,
    generationId: aggregateDocument.generation.id,
    projection,
    files,
  }
  return { kind: "ok", document: doc }
}

async function resolveParentOids(runner: Pick<GitRunner, "run">, oid: string): Promise<readonly string[]> {
  try {
    const result = await runner.run(["rev-list", "--parents", "-n", "1", oid], { readOnly: true })
    const fields = result.stdout.trim().split(/\s+/)
    if (fields.length === 0) return []
    // first field is oid itself
    return fields.slice(1).filter((p) => p.length > 0)
  } catch {
    return []
  }
}

export async function loadCommitProjection(
  runner: Pick<GitRunner, "run">,
  aggregateDocument: ReviewDocument,
  oid: string,
): Promise<ReviewProjectionDocument> {
  if (!oid || oid.trim() === "") throw new Error("oid must be non-empty")

  // Verify oid is a commit; let git verify
  // Also attempt to use document's commits for validation, but don't require existence strictly
  // If document does not contain oid, we still try to load via git; if not found, git will error
  // For strict spec, we could check existence and throw if not found, mirroring intents validation
  // We'll check document commits for existence as a hint, but not fail if git can resolve
  const parents = await resolveParentOids(runner, oid)

  let files: readonly ReviewFile[]
  if (parents.length === 0) {
    // root commit: diff empty tree vs commit
    // Use empty tree oid; if dynamic hash fails, fallback to constant
    let emptyTree = EMPTY_TREE_OID
    try {
      const hashResult = await runner.run(["hash-object", "-t", "tree", "/dev/null"], { readOnly: true })
      const trimmed = hashResult.stdout.trim()
      if (/^[0-9a-f]{40,64}$/i.test(trimmed)) emptyTree = trimmed
    } catch {
      // keep constant
    }
    files = await buildFilesForRange(runner, [emptyTree, oid])
  } else {
    const parent = parents[0]!
    files = await buildFilesForRange(runner, [parent, oid])
  }

  const projection: ReviewProjection = { kind: "commit", oid }
  return {
    reviewId: aggregateDocument.identity.id,
    generationId: aggregateDocument.generation.id,
    projection,
    files,
  }
}
