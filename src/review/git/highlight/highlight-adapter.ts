import {
  getHighlighterOptions,
  getSharedHighlighter,
  renderDiffWithHighlighter,
  parsePatchFiles,
  getFiletypeFromFileName,
} from "@pierre/diffs"
import { pierreThemeForAppearance } from "../../../ui/review-workspace/syntax-theme"
import { sanitizePatch } from "../patch-adapter"
import { hastLinesToTokens } from "./highlight-hast"
import { MAX_HIGHLIGHTED_DIFF_LINES, type HighlightPayload } from "./highlight-payload"

function pierreThemeFor(appearance: "dark" | "light"): string {
  return pierreThemeForAppearance(appearance)
}

function isBinaryPatch(patch: string): boolean {
  return patch.includes("GIT binary patch") || patch.includes("Binary files ")
}

export async function loadHighlightForPatch(
  patchText: string,
  fileKey: string,
  appearance: "dark" | "light" = "dark",
): Promise<HighlightPayload | null> {
  if (!patchText || patchText.trim().length === 0) return null
  if (isBinaryPatch(patchText)) return null

  const sanitized = sanitizePatch(patchText)
  const sanitizedText = sanitized.text
  if (!sanitizedText.trim()) return null

  let parsed: ReturnType<typeof parsePatchFiles>
  try {
    parsed = parsePatchFiles(sanitizedText, "patch", true)
  } catch {
    return null
  }
  const allFiles = parsed.flatMap((entry) => entry.files)
  if (allFiles.length === 0) return null

  // Find file matching fileKey (name or prevName)
  let targetMeta: (typeof allFiles)[number] | undefined
  for (const f of allFiles) {
    // Pierre metadata name is like "b/foo.ts" after sanitization? normalize
    const name = (f.name ?? "").replace(/^[ab]\//, "")
    const prev = (f.prevName ?? "").replace(/^[ab]\//, "")
    if (name === fileKey || prev === fileKey) {
      targetMeta = f
      break
    }
  }
  // If single file patch, use first
  if (!targetMeta && allFiles.length === 1) targetMeta = allFiles[0]
  if (!targetMeta) return null

  const deletionCount = (targetMeta as unknown as { deletionLines?: unknown[] }).deletionLines?.length ?? 0
  const additionCount = (targetMeta as unknown as { additionLines?: unknown[] }).additionLines?.length ?? 0
  if (deletionCount + additionCount > MAX_HIGHLIGHTED_DIFF_LINES) return null
  // also check hunk lines? If counts not present, fallback to hunks total?
  // We'll trust metadata counts; if missing, allow

  const language = (() => {
    try {
      return getFiletypeFromFileName(targetMeta.name) as string | undefined
    } catch {
      return undefined
    }
  })()

  const themeName = pierreThemeFor(appearance)
  // Prepare highlighter options
  let highlighter
  try {
    const opts = getHighlighterOptions(language as unknown as never, { theme: themeName as never })
    highlighter = await getSharedHighlighter(opts)
  } catch {
    return null
  }

  const renderOptions = {
    theme: themeName as never,
    useTokenTransformer: false as const,
    tokenizeMaxLineLength: 1_000,
    lineDiffType: "word-alt" as const,
    maxLineDiffLength: 10_000,
  } as const

  try {
    const result = renderDiffWithHighlighter(targetMeta as unknown as never, highlighter, renderOptions as never)
    const code = result.code as unknown as { deletionLines: unknown[]; additionLines: unknown[] }
    const deletionLinesHast = (code.deletionLines ?? []) as unknown as Array<import("./highlight-hast").HastNode | undefined>
    const additionLinesHast = (code.additionLines ?? []) as unknown as Array<import("./highlight-hast").HastNode | undefined>

    const deletionTokens = hastLinesToTokens(deletionLinesHast, appearance)
    const additionTokens = hastLinesToTokens(additionLinesHast, appearance)

    if (language) {
      return {
        fileKey,
        language,
        deletionLines: deletionTokens,
        additionLines: additionTokens,
        theme: appearance,
      }
    }
    return {
      fileKey,
      deletionLines: deletionTokens,
      additionLines: additionTokens,
      theme: appearance,
    }
  } catch {
    return null
  }
}

// Also export for testing language detection
export function resolvePierreLanguage(fileName: string): string | undefined {
  try {
    return getFiletypeFromFileName(fileName) as string | undefined
  } catch {
    return undefined
  }
}
