import { StyledText, dim, fg, type TextChunk, type TextRenderable } from "@opentui/core"
import type { DiffDisplayLine, DiffDisplayLineStyle } from "../../domain/diff/document"
import { ANSI_CYAN, ANSI_GREEN, ANSI_RED } from "../theme"
import { paneTextBuffer, type PaneStyleDefinition, type PaneTextBuffer } from "./pane-text"
import { createViewportHighlights, LINE_END_COLS, type ViewportHighlights } from "./viewport-highlights"

/**
 * Pushes a rendered diff into a pane's text viewport, colouring only the rows the viewport shows.
 *
 * The text itself goes in unstyled and whole and only the rows near the viewport carry colour;
 * ./viewport-highlights owns that mechanism and explains the bargain. This file owns what is the
 * diff's own: the styles, the row-to-style mapping, and the chunk fallback.
 */

/** Registered once per pane. The definitions mirror what the chunk fallback below paints. */
const STYLE_DEFINITIONS: Readonly<Record<"gutter" | Exclude<DiffDisplayLineStyle, "plain">, PaneStyleDefinition>> = {
  gutter: { dim: true },
  addition: { fg: ANSI_GREEN },
  deletion: { fg: ANSI_RED },
  "hunk-header": { fg: ANSI_CYAN },
  metadata: { dim: true },
}

export type DiffTextContent = {
  /** Rendered ahead of the diff (a commit's message and stat); "" for a bare patch. */
  readonly preamble: string
  /** `renderDiff`'s `displayText`: the gutter-prefixed rows, one per document line. */
  readonly body: string
  readonly displayLines: readonly DiffDisplayLine[]
}

/** What one paint needs: the rows' styles, and where in the pane the first of them sits. */
type DiffPaint = {
  readonly displayLines: readonly DiffDisplayLine[]
  readonly firstDiffRow: number
}

const painters = new WeakMap<TextRenderable, ViewportHighlights<DiffPaint>>()

function registerStyles(buffer: PaneTextBuffer): Readonly<Record<string, number>> {
  const ids: Record<string, number> = {}
  for (const [name, definition] of Object.entries(STYLE_DEFINITIONS)) {
    ids[name] = buffer.registerStyle(`githunk.diff.${name}`, definition)
  }
  return ids
}

function countRows(value: string): number {
  let rows = 0
  for (let index = value.indexOf("\n"); index >= 0; index = value.indexOf("\n", index + 1)) rows++
  return rows
}

/**
 * The preamble ends at a row boundary so the diff's first row is `countRows(preamble)`. `git show`
 * always puts the patch on its own line; normalising here keeps that an invariant rather than an
 * assumption, because every row-to-style mapping below depends on it.
 */
function joined(content: DiffTextContent): { readonly text: string; readonly firstDiffRow: number } {
  const preamble = content.preamble.length === 0 || content.preamble.endsWith("\n") ? content.preamble : `${content.preamble}\n`
  return { text: `${preamble}${content.body}`, firstDiffRow: countRows(preamble) }
}

function plainChunk(value: string): TextChunk {
  return { __isChunk: true, text: value } as TextChunk
}

function styledChunk(style: DiffDisplayLineStyle, value: string): TextChunk {
  if (style === "addition") return fg(ANSI_GREEN)(value)
  if (style === "deletion") return fg(ANSI_RED)(value)
  if (style === "hunk-header") return fg(ANSI_CYAN)(value)
  if (style === "metadata") return dim(value)
  return plainChunk(value)
}

/**
 * Whole-document chunk rendering: correct, and what this module exists to avoid. Reached only if a
 * future OpenTUI stops exposing the buffer, so the pane degrades in speed rather than colour.
 */
function paintAsChunks(text: TextRenderable, content: DiffTextContent): void {
  const { text: full, firstDiffRow } = joined(content)
  const rows = full.split("\n")
  const chunks: TextChunk[] = []
  for (let row = 0; row < rows.length; row++) {
    const value = `${rows[row]!}${row === rows.length - 1 ? "" : "\n"}`
    if (value.length === 0) continue
    const display = content.displayLines[row - firstDiffRow]
    if (display === undefined) {
      chunks.push(plainChunk(value))
      continue
    }
    const gutter = value.slice(0, display.gutterCols)
    const body = value.slice(display.gutterCols)
    if (gutter.length > 0) chunks.push(dim(gutter))
    if (body.length > 0) chunks.push(styledChunk(display.style, body))
  }
  text.content = new StyledText(chunks)
}

/**
 * Installs `content` as the pane's text. Re-installing the same text is a no-op beyond refreshing
 * the paint description, which is what makes re-focusing a panel free.
 */
export function installDiffText(text: TextRenderable, content: DiffTextContent): void {
  const buffer = paneTextBuffer(text)
  if (buffer === undefined) {
    paintAsChunks(text, content)
    return
  }
  const { text: full, firstDiffRow } = joined(content)
  const paint: DiffPaint = { displayLines: content.displayLines, firstDiffRow }
  let painter = painters.get(text)
  if (painter === undefined) {
    const styleIds = registerStyles(buffer)
    painter = createViewportHighlights<DiffPaint>(text, {
      buffer,
      paintLine: (row: number, current: DiffPaint): void => {
        const display = current.displayLines[row - current.firstDiffRow]
        if (display === undefined) return
        if (display.gutterCols > 0) buffer.addHighlight(row, { start: 0, end: display.gutterCols, styleId: styleIds.gutter! })
        if (display.style !== "plain") buffer.addHighlight(row, { start: display.gutterCols, end: LINE_END_COLS, styleId: styleIds[display.style]! })
      },
    })
    painters.set(text, painter)
  }
  painter.install(full, paint)
}

/**
 * Hands the pane back to plain `update()` content. The caller writes the replacement text itself;
 * this only drops the diff's highlights so they cannot bleed into it.
 */
export function releaseDiffText(text: TextRenderable): void {
  painters.get(text)?.release()
}
