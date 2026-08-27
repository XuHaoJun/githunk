import { parsePatchFiles, type ParsedPatch } from "@pierre/diffs"
import { createReviewHunk } from "../core/document"
import { sha256Tuple } from "../core/identity"
import type { ReviewHunk } from "../core/types"

// ── helpers copied from learn-projects/hunk for authoritative sanitization ──

function stripTerminalControl(text: string): string {
  return text
    .replace(/\x1bP[\s\S]*?\x1b\\/g, "")
    .replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b[@-_]/g, "")
}

function stripGitLogMetadata(text: string): string {
  const COMMIT_BOUNDARY = /^commit [0-9a-f]{4,64}(?: |$)/m
  if (!COMMIT_BOUNDARY.test(text)) return text
  const lines = text.split("\n")
  const out: string[] = []
  let inHeader = false
  for (const line of lines) {
    if (COMMIT_BOUNDARY.test(line)) {
      inHeader = true
      continue
    }
    if (inHeader) {
      if (line.startsWith("diff --git ") || line.startsWith("--- ") || line.startsWith("+++ ")) {
        inHeader = false
        out.push(line)
      }
      continue
    }
    out.push(line)
  }
  return out.join("\n")
}

type GitHeaderRewriteMode = "add" | "prepend-prefix" | "strip"

export interface SanitizedGitPatchFilePaths {
  readonly path: string
  readonly previousPath?: string
}

export interface SanitizedGitPatch {
  readonly text: string
  readonly filePaths: readonly (SanitizedGitPatchFilePaths | undefined)[]
}

const gitQuotedUtf8Decoder = new TextDecoder("utf-8", { fatal: true })
const gitQuotedUtf8Encoder = new TextEncoder()
const gitUnsafeDecodedHeaderCharacter = /[\x00-\x1f\x7f-\x9f]/

const gitSimpleEscapeBytes: Readonly<Record<string, number>> = {
  a: 0x07,
  b: 0x08,
  t: 0x09,
  n: 0x0a,
  v: 0x0b,
  f: 0x0c,
  r: 0x0d,
  "\\": 0x5c,
  '"': 0x22,
}

function decodeGitQuotedUtf8Path(path: string): string {
  let decodedPath = ""
  let index = 0
  while (index < path.length) {
    const escape = path.slice(index).match(/^\\([0-7]{3})/)
    if (!escape) {
      if (path[index] === "\\" && index + 1 < path.length) {
        decodedPath += path.slice(index, index + 2)
        index += 2
      } else {
        decodedPath += path[index]!
        index += 1
      }
      continue
    }
    const escapedBytes: number[] = []
    const escapedText: string[] = []
    while (index < path.length) {
      const byteEscape = path.slice(index).match(/^\\([0-7]{3})/)
      if (!byteEscape) break
      escapedText.push(byteEscape[0]!)
      escapedBytes.push(Number.parseInt(byteEscape[1]!, 8))
      index += byteEscape[0]!.length
    }
    if (escapedBytes.every((b) => b >= 0x80 && b <= 0xff)) {
      try {
        const decodedBytes = gitQuotedUtf8Decoder.decode(Uint8Array.from(escapedBytes))
        if (!gitUnsafeDecodedHeaderCharacter.test(decodedBytes)) {
          decodedPath += decodedBytes
          continue
        }
      } catch {
        // preserve original
      }
    }
    decodedPath += escapedText.join("")
  }
  return decodedPath
}

function decodeGitQuotedPath(path: string): string | null {
  const bytes: number[] = []
  let index = 0
  while (index < path.length) {
    if (path[index] !== "\\") {
      const cp = path.codePointAt(index)
      if (cp === undefined) break
      const scalar = String.fromCodePoint(cp)
      bytes.push(...gitQuotedUtf8Encoder.encode(scalar))
      index += scalar.length
      continue
    }
    const octalEscape = path.slice(index).match(/^\\([0-7]{1,3})/)
    if (octalEscape) {
      const byte = Number.parseInt(octalEscape[1]!, 8)
      if (byte > 0xff) return null
      bytes.push(byte)
      index += octalEscape[0]!.length
      continue
    }
    const escaped = path[index + 1]
    const byte = escaped ? gitSimpleEscapeBytes[escaped] : undefined
    if (byte === undefined) return null
    bytes.push(byte)
    index += 2
  }
  try {
    return gitQuotedUtf8Decoder.decode(Uint8Array.from(bytes))
  } catch {
    return null
  }
}

function normalizeDiffPath(p: string | undefined): string | undefined {
  return p?.replace(/[\r\n]+$/u, "")
}

export function normalizeDiffMetadataPaths(metadata: { name: string; prevName?: string }): { name: string; prevName?: string } {
  const name = normalizeDiffPath(metadata.name) ?? metadata.name
  const prevName = normalizeDiffPath(metadata.prevName)
  if (name === metadata.name && prevName === metadata.prevName) return metadata
  if (prevName === undefined) return { name }
  return { name, prevName }
}

function withGitPrefix(path: string, prefix: "a/" | "b/"): string {
  return path.startsWith(prefix) ? path : `${prefix}${path}`
}

const GIT_MNEMONIC_PREFIXES = new Set(["c", "i", "o", "w", "1", "2"])

function splitGitMnemonicPrefix(path: string): { prefix: string | null; rest: string } {
  if (path.length >= 2 && path[1] === "/" && GIT_MNEMONIC_PREFIXES.has(path[0]!)) {
    return { prefix: path[0]!, rest: path.slice(2) }
  }
  return { prefix: null, rest: path }
}

function stripGitPathQuotes(path: string): string {
  if (path.startsWith('"') && path.endsWith('"') && path.length >= 2) {
    return path.slice(1, -1)
  }
  return path
}

const gitMetadataPathMarkers = ["rename from ", "rename to ", "copy from ", "copy to "] as const

function rewriteGitMetadataPathLine(line: string): string {
  for (const marker of gitMetadataPathMarkers) {
    if (line.startsWith(marker)) {
      const rawPath = line.slice(marker.length)
      // If quoted, decode quoted bytes for metadata line; keep outer quotes removed.
      if (rawPath.startsWith('"') && rawPath.endsWith('"')) {
        const inner = rawPath.slice(1, -1)
        const decoded = decodeGitQuotedPath(inner)
        if (decoded !== null) return marker + decoded
        const utf8Decoded = decodeGitQuotedUtf8Path(inner)
        return marker + utf8Decoded
      }
      // For non-quoted metadata paths, leave as-is
      return line
    }
  }
  return line
}

function findRenameOrCopyMetadata(blockLines: string[]): { oldPath?: string; newPath?: string } {
  let oldPath: string | undefined
  let newPath: string | undefined
  for (const line of blockLines) {
    if (line.startsWith("rename from ")) oldPath = line.slice("rename from ".length)
    if (line.startsWith("rename to ")) newPath = line.slice("rename to ".length)
    if (line.startsWith("copy from ")) oldPath = line.slice("copy from ".length)
    if (line.startsWith("copy to ")) newPath = line.slice("copy to ".length)
  }
  if (oldPath?.startsWith('"')) {
    const inner = oldPath.slice(1, -1)
    oldPath = decodeGitQuotedPath(inner) ?? decodeGitQuotedUtf8Path(inner) ?? stripGitPathQuotes(oldPath)
  }
  if (newPath?.startsWith('"')) {
    const inner = newPath.slice(1, -1)
    newPath = decodeGitQuotedPath(inner) ?? decodeGitQuotedUtf8Path(inner) ?? stripGitPathQuotes(newPath)
  }
  if (oldPath === undefined && newPath === undefined) return {}
  if (oldPath === undefined) return { newPath: newPath! }
  if (newPath === undefined) return { oldPath: oldPath! }
  return { oldPath, newPath }
}

function resolveDecodedGitFilePaths(
  decodedPair: { oldPath: string; newPath: string } | undefined,
  blockLines: string[],
): SanitizedGitPatchFilePaths | undefined {
  const meta = findRenameOrCopyMetadata(blockLines)
  if (meta.oldPath !== undefined || meta.newPath !== undefined) {
    // Prefer metadata when present; fall back to header pair for missing side
    const path = meta.newPath ?? decodedPair?.newPath
    const previousPath = meta.oldPath ?? decodedPair?.oldPath
    if (path === undefined) return undefined
    // Strip a/b prefix if present in metadata (shouldn't be)
    const cleanPath = path.replace(/^[ab]\//, "")
    const cleanPrev = previousPath?.replace(/^[ab]\//, "")
    return cleanPrev ? { path: cleanPath, previousPath: cleanPrev } : { path: cleanPath }
  }
  if (decodedPair) {
    const cleanPath = decodedPair.newPath.replace(/^[ab]\//, "")
    const cleanPrev = decodedPair.oldPath.replace(/^[ab]\//, "")
    // If paths identical, it's not a rename; only path
    if (cleanPath === cleanPrev) return { path: cleanPath }
    // Check if block indicates rename/copy via header? If not rename, just path.
    // Heuristic: if block contains rename markers, keep previousPath; otherwise omit
    const hasRename = blockLines.some((l) => l.startsWith("rename ") || l.startsWith("copy "))
    if (hasRename) return { path: cleanPath, previousPath: cleanPrev }
    // For ordinary files, path is current; previous not needed
    return { path: cleanPath }
  }
  return undefined
}

function shouldStripMnemonicPair(oldPath: string, newPath: string, blockLines: string[]): boolean {
  const oldSplit = splitGitMnemonicPrefix(oldPath)
  const newSplit = splitGitMnemonicPrefix(newPath)
  if (oldSplit.prefix === null || newSplit.prefix === null) return false
  if (oldSplit.prefix !== newSplit.prefix) return false
  // If both have same mnemonic prefix, it's real mnemonic output when block contains no rename metadata
  const meta = findRenameOrCopyMetadata(blockLines)
  if (meta.oldPath !== undefined || meta.newPath !== undefined) {
    // If metadata exists, this is likely plain path that happens to look like mnemonic, not real mnemonic
    return true
  }
  return false
}

function canonicalizeKnownGitPathPair(
  oldPath: string,
  newPath: string,
  blockLines: string[],
): { oldPath: string; newPath: string; rewriteMode: GitHeaderRewriteMode | null; changed: boolean; isCanonical: boolean } | null {
  const oldHasPrefix = oldPath.startsWith("a/") || oldPath.startsWith("b/")
  const newHasPrefix = newPath.startsWith("a/") || newPath.startsWith("b/")

  const oldMnemonic = splitGitMnemonicPrefix(oldPath)
  const newMnemonic = splitGitMnemonicPrefix(newPath)

  if (oldHasPrefix && newHasPrefix) {
    // Already canonical a/b
    return { oldPath, newPath, rewriteMode: null, changed: false, isCanonical: true }
  }

  if (oldMnemonic.prefix !== null && newMnemonic.prefix !== null) {
    if (shouldStripMnemonicPair(oldPath, newPath, blockLines)) {
      // These are noprefix rename paths that look like mnemonic; treat as noprefix
      const cleanOld = oldPath
      const cleanNew = newPath
      return {
        oldPath: withGitPrefix(cleanOld, "a/"),
        newPath: withGitPrefix(cleanNew, "b/"),
        rewriteMode: "add",
        changed: true,
        isCanonical: false,
      }
    }
    // Real mnemonic: strip prefix letter and re-add a/b
    return {
      oldPath: withGitPrefix(oldMnemonic.rest, "a/"),
      newPath: withGitPrefix(newMnemonic.rest, "b/"),
      rewriteMode: "strip",
      changed: true,
      isCanonical: false,
    }
  }

  if (!oldHasPrefix || !newHasPrefix) {
    // Missing prefix on one or both; prepend
    return {
      oldPath: withGitPrefix(oldPath, "a/"),
      newPath: withGitPrefix(newPath, "b/"),
      rewriteMode: "prepend-prefix",
      changed: true,
      isCanonical: false,
    }
  }

  return null
}

function canonicalizeGitPathPair(
  oldPath: string,
  newPath: string,
  blockLines: string[],
): { oldPath: string; newPath: string; rewriteMode: GitHeaderRewriteMode | null } {
  const strippedOld = stripGitPathQuotes(oldPath)
  const strippedNew = stripGitPathQuotes(newPath)
  const known = canonicalizeKnownGitPathPair(strippedOld, strippedNew, blockLines)
  if (known) return { oldPath: known.oldPath, newPath: known.newPath, rewriteMode: known.rewriteMode }
  // Fallback: ensure a/b
  return {
    oldPath: withGitPrefix(strippedOld, "a/"),
    newPath: withGitPrefix(strippedNew, "b/"),
    rewriteMode: "add",
  }
}

function rewriteUnifiedFileLine(line: string, marker: "--- " | "+++ ", prefix: "a/" | "b/", mode: GitHeaderRewriteMode): string {
  const rest = line.slice(marker.length)
  if (rest === "/dev/null") return line
  // Handle quoted paths in ---/+++ lines
  let path = rest
  let suffix = ""
  // git adds tab + timestamp for some headers; preserve suffix after tab
  const tabIdx = path.indexOf("\t")
  if (tabIdx >= 0) {
    suffix = path.slice(tabIdx)
    path = path.slice(0, tabIdx)
  }
  if (mode === "strip") {
    const split = splitGitMnemonicPrefix(path.replace(/^"|"$/g, ""))
    if (split.prefix !== null) path = split.rest
    else path = path.replace(/^[ab]\//, "")
  }
  // Strip quotes and decode
  if (path.startsWith('"') && path.endsWith('"')) {
    const inner = path.slice(1, -1)
    const decoded = decodeGitQuotedPath(inner)
    if (decoded !== null) path = decoded
    else path = decodeGitQuotedUtf8Path(inner)
  }
  // Ensure prefix
  if (!path.startsWith(prefix)) {
    if (path.startsWith("a/") || path.startsWith("b/")) {
      // swap to correct side
      path = prefix + path.slice(2)
    } else {
      path = prefix + path
    }
  }
  return marker + path + suffix
}

function rewriteGitPatchBlock(blockLines: string[]): { lines: string[]; filePaths: SanitizedGitPatchFilePaths | undefined } {
  const firstLine = blockLines[0]
  if (!firstLine?.startsWith("diff --git ")) {
    return { lines: blockLines, filePaths: undefined }
  }
  const result = rewriteGitDiffHeader(firstLine, blockLines)
  let blockRewriteMode = result.rewriteMode
  const rewrittenLines = [result.line]
  for (const line of blockLines.slice(1)) {
    if (blockRewriteMode && line.startsWith("--- ")) {
      rewrittenLines.push(rewriteUnifiedFileLine(line, "--- ", "a/", blockRewriteMode))
      continue
    }
    if (blockRewriteMode && line.startsWith("+++ ")) {
      const rewriteMode = blockRewriteMode
      blockRewriteMode = null
      rewrittenLines.push(rewriteUnifiedFileLine(line, "+++ ", "b/", rewriteMode))
      continue
    }
    rewrittenLines.push(rewriteGitMetadataPathLine(line))
  }
  return {
    lines: rewrittenLines,
    filePaths: resolveDecodedGitFilePaths(result.decodedPair, blockLines),
  }
}

function rewriteGitDiffHeader(
  line: string,
  blockLines: string[],
): { line: string; rewriteMode: GitHeaderRewriteMode | null; decodedPair?: { oldPath: string; newPath: string } } {
  const rest = line.slice("diff --git ".length).trimEnd()
  const quotedMatch = rest.match(/^"((?:\\.|[^"\\])*)" "((?:\\.|[^"\\])*)"$/)
  if (quotedMatch) {
    const quotedOldPath = quotedMatch[1] ?? ""
    const quotedNewPath = quotedMatch[2] ?? ""
    const oldPath = decodeGitQuotedUtf8Path(quotedOldPath)
    const newPath = decodeGitQuotedUtf8Path(quotedNewPath)
    const pair = canonicalizeGitPathPair(oldPath, newPath, blockLines)
    const decodedOldPath = decodeGitQuotedPath(quotedOldPath)
    const decodedNewPath = decodeGitQuotedPath(quotedNewPath)
    if (decodedOldPath !== null && decodedNewPath !== null) {
      const can = canonicalizeGitPathPair(decodedOldPath, decodedNewPath, blockLines)
      return {
        line: `diff --git ${pair.oldPath} ${pair.newPath}`,
        rewriteMode: pair.rewriteMode,
        decodedPair: { oldPath: can.oldPath, newPath: can.newPath },
      }
    }
    return {
      line: `diff --git ${pair.oldPath} ${pair.newPath}`,
      rewriteMode: pair.rewriteMode,
    }
  }

  const tokens = rest.split(" ")
  if (tokens.length >= 2 && tokens.length % 2 === 0) {
    const half = tokens.length / 2
    const firstHalf = tokens.slice(0, half).join(" ")
    const secondHalf = tokens.slice(half).join(" ")
    const knownPair = canonicalizeKnownGitPathPair(firstHalf, secondHalf, blockLines)
    if (knownPair?.changed) {
      return {
        line: `diff --git ${knownPair.oldPath} ${knownPair.newPath}`,
        rewriteMode: knownPair.rewriteMode,
      }
    }
    if (knownPair?.isCanonical) {
      return { line, rewriteMode: null }
    }
    if (firstHalf === secondHalf && firstHalf.length > 0) {
      return {
        line: `diff --git ${withGitPrefix(firstHalf, "a/")} ${withGitPrefix(secondHalf, "b/")}`,
        rewriteMode: "add",
      }
    }
  }

  // Fallback: try simple two-token split
  const simpleTokens = rest.split(" ")
  if (simpleTokens.length === 2) {
    const [oldTok, newTok] = simpleTokens as [string, string]
    const pair = canonicalizeGitPathPair(oldTok!, newTok!, blockLines)
    return {
      line: `diff --git ${pair.oldPath} ${pair.newPath}`,
      rewriteMode: pair.rewriteMode,
      decodedPair: { oldPath: oldTok!, newPath: newTok! },
    }
  }

  return { line, rewriteMode: null }
}

export function sanitizeGitPatch(patchText: string): SanitizedGitPatch {
  if (!patchText.includes("diff --git ")) {
    return { text: patchText, filePaths: [] }
  }
  const lines = patchText.split("\n")
  const normalizedLines: string[] = []
  const filePaths: Array<SanitizedGitPatchFilePaths | undefined> = []
  let blockLines: string[] = []
  const flushBlock = () => {
    if (blockLines.length === 0) return
    const rewritten = rewriteGitPatchBlock(blockLines)
    normalizedLines.push(...rewritten.lines)
    filePaths.push(rewritten.filePaths)
    blockLines = []
  }
  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      flushBlock()
      blockLines.push(line)
      continue
    }
    if (blockLines.length > 0) {
      blockLines.push(line)
    } else {
      normalizedLines.push(line)
    }
  }
  flushBlock()
  return { text: normalizedLines.join("\n"), filePaths }
}

export function sanitizePatch(patchText: string): SanitizedGitPatch {
  return sanitizeGitPatch(stripGitLogMetadata(stripTerminalControl(patchText.replaceAll("\r\n", "\n"))))
}

// ── chunk handling ──

function stripPrefixes(path: string): string {
  return path.replace(/^[ab]\//, "")
}

export function splitPatchIntoFileChunks(rawPatch: string): string[] {
  const patch = rawPatch.replaceAll("\r\n", "\n")
  const lines = patch.split("\n")
  const chunks: string[] = []
  let current: string[] = []
  const hasGitHeaders = lines.some((l) => l.startsWith("diff --git "))
  const flush = () => {
    if (current.length > 0) {
      chunks.push(`${current.join("\n").trimEnd()}\n`)
      current = []
    }
  }
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!
    if (hasGitHeaders && line.startsWith("diff --git ")) {
      flush()
      current.push(line)
      continue
    }
    if (!hasGitHeaders && line.startsWith("--- ") && lines[index + 1]?.startsWith("+++ ")) {
      flush()
      current.push(line)
      current.push(lines[index + 1]!)
      index += 1
      continue
    }
    if (current.length > 0) current.push(line)
  }
  flush()
  return chunks
}

export function findPatchChunk(metadata: { name: string; prevName?: string }, chunks: string[], index: number): string {
  const byIndex = chunks[index]
  if (byIndex) return byIndex
  return (
    chunks.find((chunk) =>
      [metadata.name, metadata.prevName]
        .map((v) => normalizeDiffPath(v))
        .filter((v): v is string => Boolean(v))
        .map(stripPrefixes)
        .some((path) => chunk.includes(`a/${path}`) || chunk.includes(`b/${path}`) || chunk.includes(path)),
    ) ?? ""
  )
}

// ── hunk extraction from normalized patch chunk ──

function parseHunkHeader(line: string): { oldStart: number; oldCount: number; newStart: number; newCount: number } | null {
  const m = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/)
  if (!m) return null
  const oldStart = Number.parseInt(m[1]!, 10)
  const oldCount = m[2] !== undefined ? Number.parseInt(m[2], 10) : 1
  const newStart = Number.parseInt(m[3]!, 10)
  const newCount = m[4] !== undefined ? Number.parseInt(m[4], 10) : 1
  return { oldStart, oldCount, newStart, newCount }
}

function extractHunksFromChunk(chunk: string): Omit<ReviewHunk, "digest">[] {
  const lines = chunk.split("\n")
  const hunks: Omit<ReviewHunk, "digest">[] = []
  let currentHunk: { oldStart: number; oldCount: number; newStart: number; newCount: number; lines: string[] } | null = null
  let hunkIndex = 0

  for (const line of lines) {
    const header = parseHunkHeader(line)
    if (header) {
      if (currentHunk) {
        hunks.push({
          index: hunkIndex++,
          oldStart: currentHunk.oldStart,
          oldCount: currentHunk.oldCount,
          newStart: currentHunk.newStart,
          newCount: currentHunk.newCount,
          lines: currentHunk.lines,
        })
      }
      currentHunk = { ...header, lines: [] }
      continue
    }
    if (currentHunk === null) continue
    // Ignore "\ No newline at end of file"
    if (line.startsWith("\\")) continue
    // Hunk content lines are prefixed with " ", "+", "-"
    // Also handle possible empty lines that are context with a single space? Git writes " " for blank context lines.
    // If line is empty string due to trailing newline, skip.
    // Valid hunk lines include exactly those prefixes; if line doesn't start with those, it might be next header or metadata, ignore.
    if (line.length === 0) continue
    if (line[0] === " " || line[0] === "+" || line[0] === "-") {
      currentHunk.lines.push(line)
    } else {
      // Reached end of hunk (e.g., diff --git of next file would have been caught as header, but other metadata)
      // If we encounter a line that is not a hunk line and not a header, consider hunk ended.
      // However for robustness, treat any non-hunk line as hunk terminator except when inside hunk body the patch may contain other?
      // For simplicity, if line starts with "diff ", "index ", "--- ", "+++ ", "old mode", "new mode", etc, we terminate.
      // But we already skip those before hunk; after hunk, any such line means new file, but we already handle diff --git flush.
      // So we can just ignore non-hunk lines.
      continue
    }
  }
  if (currentHunk) {
    hunks.push({
      index: hunkIndex,
      oldStart: currentHunk.oldStart,
      oldCount: currentHunk.oldCount,
      newStart: currentHunk.newStart,
      newCount: currentHunk.newCount,
      lines: currentHunk.lines,
    })
  }
  return hunks
}

function patchLooksBinary(patch: string): boolean {
  return patch.includes("GIT binary patch") || patch.includes("Binary files ")
}

export type ParsedPatchFile = {
  readonly path: string
  readonly previousPath?: string
  readonly patch: string
  readonly patchDigest: string
  readonly normalizedHunkBody: string
  readonly hunks: readonly ReviewHunk[]
  readonly isBinary: boolean
}

/**
 * Parse patch text via @pierre/diffs and convert each file into normalized ReviewHunks.
 * Isolated Pierre boundary: Pierre types never leak; only core ReviewHunk objects are returned.
 */
export function parseReviewPatch(patchText: string): readonly ParsedPatchFile[] {
  // Normalize patch once
  const sanitized = sanitizePatch(patchText)
  const sanitizedText = sanitized.text

  let parsedPatches: ParsedPatch[]
  try {
    parsedPatches = parsePatchFiles(sanitizedText, "patch", true)
  } catch {
    return []
  }

  const metadataFiles = parsedPatches.flatMap((entry) => entry.files)
  const chunks = splitPatchIntoFileChunks(sanitizedText)

  const result: ParsedPatchFile[] = []
  for (let index = 0; index < metadataFiles.length; index++) {
    const metadata = metadataFiles[index]!
    const decodedPaths = sanitized.filePaths[index]
    // Prefer exact decoded paths when available
    const normalizedMetadata = decodedPaths
      ? { name: decodedPaths.path, prevName: decodedPaths.previousPath }
      : normalizeDiffMetadataPaths(metadata as unknown as { name: string; prevName?: string })

    const patchChunk = findPatchChunk(metadata as unknown as { name: string; prevName?: string }, chunks, index)
    const normalizedPatch = patchChunk // already sanitized
    const patchDigest = sha256Tuple([normalizedPatch])

    const isBinary = patchLooksBinary(normalizedPatch)
    const rawHunks = isBinary ? [] : extractHunksFromChunk(normalizedPatch)
    const hunks: ReviewHunk[] = rawHunks.map((h) => createReviewHunk(h))

    const normalizedHunkBody = hunks.flatMap((h) => h.lines).join("\n") + (hunks.length > 0 ? "\n" : "")

    // Path handling: for Pierre metadata, name is current path without prefix after sanitization
    // For decoded path, it's already without a/b. Use it.
    const path = normalizedMetadata.name.replace(/^[ab]\//, "")
    const previousPath = normalizedMetadata.prevName?.replace(/^[ab]\//, "")

    if (previousPath !== undefined) {
      result.push({
        path,
        previousPath,
        patch: normalizedPatch,
        patchDigest,
        normalizedHunkBody,
        hunks,
        isBinary,
      })
    } else {
      result.push({
        path,
        patch: normalizedPatch,
        patchDigest,
        normalizedHunkBody,
        hunks,
        isBinary,
      })
    }
  }
  return result
}
