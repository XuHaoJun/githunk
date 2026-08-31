import { sha256Tuple } from "./identity"
import type { ReviewAnchor, ReviewFile, ReviewHunk } from "./types"
import type { ReviewDocument } from "./types"
import type { ReviewLineSelection } from "./state"

export type AnchorReconciliation =
  | { resolution: "active"; anchor: ReviewAnchor }
  | { resolution: "stale"; anchor: ReviewAnchor }
  | { resolution: "orphaned"; anchor: ReviewAnchor }

function hunkSideRange(hunk: ReviewHunk, side: "old" | "new"): [number, number] | null {
  if (side === "old") {
    if (hunk.oldCount === 0) return null
    return [hunk.oldStart, hunk.oldStart + hunk.oldCount - 1]
  }
  if (hunk.newCount === 0) return null
  return [hunk.newStart, hunk.newStart + hunk.newCount - 1]
}

type SideLine = { lineNumber: number; content: string }

export function sideLinesForHunk(hunk: ReviewHunk, side: "old" | "new"): SideLine[] {
  const result: SideLine[] = []
  let curOld = hunk.oldStart
  let curNew = hunk.newStart
  for (const raw of hunk.lines) {
    const marker = raw.length > 0 ? raw[0] : ""
    const content = raw.length > 0 ? raw.slice(1) : ""
    if (marker === " ") {
      if (side === "old") result.push({ lineNumber: curOld, content })
      if (side === "new") result.push({ lineNumber: curNew, content })
      curOld++
      curNew++
    } else if (marker === "-") {
      if (side === "old") result.push({ lineNumber: curOld, content })
      curOld++
    } else if (marker === "+") {
      if (side === "new") result.push({ lineNumber: curNew, content })
      curNew++
    } else {
      // Lines without expected marker: treat as context for both sides
      if (side === "old") result.push({ lineNumber: curOld, content: raw })
      if (side === "new") result.push({ lineNumber: curNew, content: raw })
      curOld++
      curNew++
    }
  }
  return result
}

function extractSelectedContent(hunk: ReviewHunk, side: "old" | "new", startLine: number, endLine: number): string[] {
  const lines = sideLinesForHunk(hunk, side)
  const mapByNumber = new Map(lines.map((e, idx) => [e.lineNumber, idx] as const))
  const startIdx = mapByNumber.get(startLine)
  const endIdx = mapByNumber.get(endLine)
  if (startIdx === undefined || endIdx === undefined) {
    throw new Error(`range ${startLine}-${endLine} not found in hunk ${hunk.index} side ${side}`)
  }
  if (endIdx < startIdx) throw new Error(`invalid range order`)
  // Ensure contiguous numeric lines: the slice length should equal end-start+1
  const len = endLine - startLine + 1
  if (endIdx - startIdx + 1 !== len) {
    throw new Error(`range maps to discontiguous hunk lines`)
  }
  return lines.slice(startIdx, endIdx + 1).map((e) => e.content)
}

function computeContextDigest(contents: readonly string[]): string {
  // Digest over normalized source lines: each line content after marker.
  // Normalization here is exact content after stripping marker; callers may trim if needed.
  // Using sha256Tuple keeps boundaries unambiguous.
  return sha256Tuple([...contents])
}

export function createFileAnchor(file: ReviewFile): ReviewAnchor {
  return { kind: "file", fileKey: file.key, contentId: file.contentId }
}

export function createRangeAnchor(
  file: ReviewFile,
  range: { side: "old" | "new"; startLine: number; endLine: number },
): ReviewAnchor {
  const { side, startLine, endLine } = range
  if (!Number.isInteger(startLine) || !Number.isInteger(endLine)) {
    throw new Error(`startLine and endLine must be integers`)
  }
  if (startLine < 1 || endLine < 1) {
    throw new Error(`line numbers must be >= 1 (got ${startLine}-${endLine})`)
  }
  if (endLine < startLine) {
    throw new Error(`endLine must be >= startLine (got ${startLine}-${endLine})`)
  }
  if (side !== "old" && side !== "new") {
    throw new Error(`side must be old or new (got ${side as string})`)
  }
  if (file.source === "binary" || file.source === "too-large") {
    throw new Error(`range anchors not allowed for binary or too-large files`)
  }
  // Find owner hunk where range fully inside side interval
  let owner: ReviewHunk | undefined
  for (const hunk of file.hunks) {
    const interval = hunkSideRange(hunk, side)
    if (!interval) continue
    const [s, e] = interval
    if (startLine >= s && endLine <= e) {
      owner = hunk
      break
    }
  }
  if (!owner) {
    // Fallback: find hunk containing startLine (for better error) and check end
    for (const hunk of file.hunks) {
      const interval = hunkSideRange(hunk, side)
      if (!interval) continue
      const [s, e] = interval
      if (startLine >= s && startLine <= e) {
        throw new Error(`range ${startLine}-${endLine} spans beyond hunk ${hunk.index} on ${side} side (${s}-${e})`)
      }
    }
    throw new Error(`range ${startLine}-${endLine} not inside any hunk on ${side} side`)
  }

  const selected = extractSelectedContent(owner, side, startLine, endLine)
  const digest = computeContextDigest(selected)

  return {
    kind: "range",
    fileKey: file.key,
    contentId: file.contentId,
    side,
    startLine,
    endLine,
    ownerHunkIndex: owner.index,
    contextDigest: digest,
  }
}

export function createLineSelection(
  file: ReviewFile,
  input: { hunkIndex: number; side: "old" | "new"; line: number },
): ReviewLineSelection {
  if (!Number.isInteger(input.hunkIndex) || input.hunkIndex < 0) throw new Error("invalid hunkIndex")
  if (input.side !== "old" && input.side !== "new") throw new Error("invalid side")
  if (!Number.isInteger(input.line) || input.line < 1) throw new Error("invalid line")
  const hunk = file.hunks.find((candidate) => candidate.index === input.hunkIndex)
  if (!hunk) throw new Error("hunk not found")
  if (file.source === "binary" || file.source === "too-large") throw new Error("line selections not allowed")
  const lines = sideLinesForHunk(hunk, input.side)
  if (!lines.some((entry) => entry.lineNumber === input.line)) throw new Error("line not found")
  const anchor = createRangeAnchor(file, { side: input.side, startLine: input.line, endLine: input.line })
  return { fileKey: file.key, hunkIndex: input.hunkIndex, side: input.side, line: input.line, contentId: anchor.contentId, contextDigest: anchor.contextDigest }
}

export function reconcileAnchor(anchor: ReviewAnchor, document: ReviewDocument): AnchorReconciliation {
  if (anchor.kind === "file") {
    const file = document.files.find((f) => f.key === anchor.fileKey)
    if (!file) {
      return { resolution: "orphaned", anchor }
    }
    // File anchors stay active if file exists; update contentId to current
    const updated: ReviewAnchor = { kind: "file", fileKey: file.key, contentId: file.contentId }
    return { resolution: "active", anchor: updated }
  }

  // range anchor
  const file = document.files.find((f) => f.key === anchor.fileKey)
  if (!file) {
    return { resolution: "orphaned", anchor }
  }
  // If file is binary, range is no longer valid
  if (file.source === "binary" || file.source === "too-large") {
    return { resolution: "stale", anchor }
  }
  // Unchanged content keeps active at same location (no relocation needed)
  if (file.contentId === anchor.contentId) {
    // Verify owner still valid and range still inside hunk; if not, treat as stale
    const owner = file.hunks.find((h) => h.index === anchor.ownerHunkIndex)
    if (owner) {
      const interval = hunkSideRange(owner, anchor.side)
      if (interval && anchor.startLine >= interval[0] && anchor.endLine <= interval[1]) {
        // Quick check: recompute digest for same location; if digest matches, active, else stale (contentId same but digest mismatch indicates corruption)
        try {
          const sel = extractSelectedContent(owner, anchor.side, anchor.startLine, anchor.endLine)
          const d = computeContextDigest(sel)
          if (d === anchor.contextDigest) {
            return { resolution: "active", anchor }
          }
        } catch {
          // fall through to stale
        }
      }
    }
    // A same-content anchor that cannot be verified has a stale location. Do
    // not keep an invalid persisted anchor active: Finish validation relies on
    // this semantic check to require an explicit re-anchor.
    return { resolution: "stale", anchor }
  }

  // Content changed: attempt unique context relocation
  const len = anchor.endLine - anchor.startLine + 1
  const candidates: { hunk: ReviewHunk; startLine: number; endLine: number }[] = []

  for (const hunk of file.hunks) {
    const interval = hunkSideRange(hunk, anchor.side)
    if (!interval) continue
    const [s, e] = interval
    const hunkLineCount = e - s + 1
    if (hunkLineCount < len) continue
    const sideLines = sideLinesForHunk(hunk, anchor.side)
    // Build map for quick digest check: iterate possible windows of length len
    for (let startIdx = 0; startIdx + len - 1 < sideLines.length; startIdx++) {
      const endIdx = startIdx + len - 1
      const candStart = sideLines[startIdx]!.lineNumber
      const candEnd = sideLines[endIdx]!.lineNumber
      // Ensure contiguous numbers (they should be)
      if (candEnd - candStart + 1 !== len) continue
      // Check that window is fully inside interval (it is)
      const contents = sideLines.slice(startIdx, endIdx + 1).map((x) => x.content)
      const d = computeContextDigest(contents)
      if (d === anchor.contextDigest) {
        candidates.push({ hunk, startLine: candStart, endLine: candEnd })
      }
    }
  }

  if (candidates.length === 1) {
    const match = candidates[0]!
    const relocated: ReviewAnchor = {
      kind: "range",
      fileKey: file.key,
      contentId: file.contentId,
      side: anchor.side,
      startLine: match.startLine,
      endLine: match.endLine,
      ownerHunkIndex: match.hunk.index,
      contextDigest: anchor.contextDigest,
    }
    return { resolution: "active", anchor: relocated }
  }

  // Zero or multiple matches => stale, retain last known location
  return { resolution: "stale", anchor }
}
