import type { GitRunner } from "../../git/runner"
import type { ReviewDocument, SourceContextRequest, SourceContextResult } from "../core/types"

export type { SourceContextRequest, SourceContextResult } from "../core/types"


export type SourceContextError =
  | Readonly<{ kind: "binary"; fileKey: string; side: "old" | "new" }>
  | Readonly<{ kind: "too-large"; fileKey: string; side: "old" | "new"; maxBytes: number; blobOid: string }>
  | Readonly<{ kind: "unavailable"; fileKey: string; side: "old" | "new"; reason: string }>
  | Readonly<{ kind: "stale-generation"; requestGenerationId: string; currentGenerationId: string }>
  | Readonly<{ kind: "stale-review"; requestReviewId: string; currentReviewId: string }>
  | Readonly<{ kind: "file-not-found"; fileKey: string }>
  | Readonly<{ kind: "invalid-range"; startLine: number; endLine: number; reason: string }>

export type SourceContextOutcome =
  | Readonly<{ ok: true; result: SourceContextResult }>
  | Readonly<{ ok: false; error: SourceContextError }>

const DEFAULT_MAX_BYTES = 1_000_000

function isZeroOid(oid: string | null): boolean {
  if (oid === null) return true
  return /^0+$/.test(oid)
}

function normalizedReviewSourceLines(sourceText: string): readonly string[] {
  const normalized = sourceText.replaceAll("\r\n", "\n")
  const trimmed = normalized.endsWith("\n") ? normalized.slice(0, -1) : normalized
  return trimmed.length === 0 ? [] : trimmed.split("\n")
}

export async function loadSourceContext(
  runner: Pick<GitRunner, "run">,
  document: ReviewDocument,
  request: SourceContextRequest,
  options?: Readonly<{ maxBytes?: number }>,
): Promise<SourceContextOutcome> {
  const maxBytes = options?.maxBytes ?? DEFAULT_MAX_BYTES

  if (request.reviewId !== document.identity.id) {
    return {
      ok: false,
      error: {
        kind: "stale-review",
        requestReviewId: request.reviewId,
        currentReviewId: document.identity.id,
      },
    }
  }

  if (request.generationId !== document.generation.id) {
    return {
      ok: false,
      error: {
        kind: "stale-generation",
        requestGenerationId: request.generationId,
        currentGenerationId: document.generation.id,
      },
    }
  }

  if (
    !Number.isInteger(request.startLine) ||
    !Number.isInteger(request.endLine) ||
    request.startLine < 1 ||
    request.endLine < 1 ||
    request.endLine < request.startLine
  ) {
    return {
      ok: false,
      error: {
        kind: "invalid-range",
        startLine: request.startLine,
        endLine: request.endLine,
        reason: "startLine and endLine must be integers >=1 and endLine >= startLine",
      },
    }
  }

  const file = document.files.find((f) => f.key === request.fileKey)
  if (!file) {
    return {
      ok: false,
      error: { kind: "file-not-found", fileKey: request.fileKey },
    }
  }

  if (request.side !== "old" && request.side !== "new") {
    return {
      ok: false,
      error: { kind: "invalid-range", startLine: request.startLine, endLine: request.endLine, reason: "side must be old or new" },
    }
  }

  // Binary files cannot provide line-anchored source
  if (file.source === "binary" || file.kind === "binary") {
    return { ok: false, error: { kind: "binary", fileKey: file.key, side: request.side } }
  }
  if (file.source === "too-large") {
    const blobOid = request.side === "old" ? file.oldBlobOid : file.newBlobOid
    return {
      ok: false,
      error: {
        kind: "too-large",
        fileKey: file.key,
        side: request.side,
        maxBytes,
        blobOid: blobOid ?? "",
      },
    }
  }

  const blobOid = request.side === "old" ? file.oldBlobOid : file.newBlobOid

  if (isZeroOid(blobOid)) {
    return {
      ok: false,
      error: {
        kind: "unavailable",
        fileKey: file.key,
        side: request.side,
        reason: `no blob on ${request.side} side for file ${file.key}`,
      },
    }
  }

  // At this point blobOid is non-null and non-zero
  const oid = blobOid as string

  // Enforce too-large via git cat-file -s before fetching content, to avoid OOM
  // If size check fails due to missing blob, treat as unavailable
  try {
    const sizeResult = await runner.run(["cat-file", "-s", oid], { readOnly: true, acceptedExitCodes: [0, 128] })
    if (sizeResult.exitCode !== 0) {
      return {
        ok: false,
        error: { kind: "unavailable", fileKey: file.key, side: request.side, reason: `blob not found: ${oid}` },
      }
    }
    const size = Number.parseInt(sizeResult.stdout.trim(), 10)
    if (Number.isFinite(size) && size > maxBytes) {
      return { ok: false, error: { kind: "too-large", fileKey: file.key, side: request.side, maxBytes, blobOid: oid } }
    }
  } catch {
    return {
      ok: false,
      error: { kind: "unavailable", fileKey: file.key, side: request.side, reason: `failed to stat blob ${oid}` },
    }
  }

  // Fetch blob content via git show <blobOid>
  let content: string
  try {
    const result = await runner.run(["show", oid], { readOnly: true })
    if (result.exitCode !== 0) {
      return {
        ok: false,
        error: { kind: "unavailable", fileKey: file.key, side: request.side, reason: result.stderr || `git show failed for ${oid}` },
      }
    }
    content = result.stdout
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      ok: false,
      error: { kind: "unavailable", fileKey: file.key, side: request.side, reason: message },
    }
  }

  // Enforce byte limit after fetch as well (in case cat-file -s was bypassed)
  const byteLength = Buffer.byteLength(content, "utf8")
  if (byteLength > maxBytes) {
    return { ok: false, error: { kind: "too-large", fileKey: file.key, side: request.side, maxBytes, blobOid: oid } }
  }

  const lines = normalizedReviewSourceLines(content)

  // Range enforcement against actual line count
  if (request.endLine > lines.length) {
    // Allow empty file case: if lines.length ===0, any request is out of bounds
    // Return invalid-range to indicate caller requested beyond file
    // However if file is empty and request is 1-0? Already handled invalid-range above
    // For deleted/added empty files, this will be invalid-range
    // Spec says enforce requested range
    return {
      ok: false,
      error: {
        kind: "invalid-range",
        startLine: request.startLine,
        endLine: request.endLine,
        reason: `requested endLine ${request.endLine} exceeds file line count ${lines.length}`,
      },
    }
  }

  // startLine is guaranteed >=1 and <= endLine, and endLine <= lines.length, so startLine also <= lines.length
  if (request.startLine > lines.length) {
    return {
      ok: false,
      error: {
        kind: "invalid-range",
        startLine: request.startLine,
        endLine: request.endLine,
        reason: `requested startLine ${request.startLine} exceeds file line count ${lines.length}`,
      },
    }
  }

  const slice = lines.slice(request.startLine - 1, request.endLine)

  const result: SourceContextResult = {
    reviewId: request.reviewId,
    generationId: request.generationId,
    fileKey: request.fileKey,
    side: request.side,
    startLine: request.startLine,
    lines: slice,
  }

  return { ok: true, result }
}
