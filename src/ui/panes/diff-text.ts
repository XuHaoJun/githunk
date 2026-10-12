import { StyledText, dim, fg, type TextChunk, type TextRenderable } from "@opentui/core"
import type { DiffDisplayLine, DiffDisplayLineStyle } from "../../domain/diff/document"
import { ANSI_CYAN, ANSI_GREEN, ANSI_RED } from "../theme"

/**
 * Pushes a rendered diff into a pane's text viewport.
 *
 * OpenTUI 0.6 keeps the renderable tree native and leaves `TextRenderable.textBuffer` undefined, so
 * the line-indexed highlights 0.5 addressed are gone: the diff is encoded as one `StyledText` per
 * install instead. Measured on 0.6.2 that costs ~0.5 µs per line — 2.1 ms for a 2000-line patch,
 * 40 ms for 75000 — and a re-install of unchanged text costs nothing at all, which is what keeps
 * scrolling, re-focusing and range selection off the document's back.
 */

export type DiffTextContent = {
  /** Rendered ahead of the diff (a commit's message and stat); "" for a bare patch. */
  readonly preamble: string
  /** `renderDiff`'s `displayText`: the gutter-prefixed rows, one per document line. */
  readonly body: string
  readonly displayLines: readonly DiffDisplayLine[]
  /** Overrides native scroll for bounded virtual buffers; eager panes use their native scroll. */
  readonly highlightScrollY?: () => number
  /** Optional stat spans precomputed against the full preamble and remapped to local rows. */
  readonly preambleSpans?: ReadonlyMap<number, readonly DiffStatSpan[]>
}

export type InstalledPaneText = {
  /** Exact text written to the pane: the normalized preamble plus the body. */
  readonly text: string
  /** Length of the normalized preamble within `text`. */
  readonly preambleLength: number
}
export type DiffStatSpan = {
  /** UTF-16 offsets used to split the stat row's chunk text. */
  readonly start: number
  readonly end: number
  readonly style: Extract<DiffDisplayLineStyle, "addition" | "deletion">
}

/**
 * Git's `--stat` output contains a compact `+`/`-` graph after each file's bar. LazyGit leaves
 * `git show --color=always --stat -p` in the main view for this path
 * (`pkg/commands/git_commands/commit.go:243-258`), so Git colours those graph symbols green/red.
 * The structured loader keeps `--no-color` for selection-safe offsets; recover only stat indicators
 * here. The separator and contiguous stat rows immediately before Git's summary anchor the section,
 * avoiding matches against commit text.
 * Binary rows colour old/new byte counts red/green; bare `Bin` rows still keep the section contiguous.
 */
export function statSpansForPreamble(preamble: string): ReadonlyMap<number, readonly DiffStatSpan[]> {
  const grouped = new Map<number, DiffStatSpan[]>()
  const rows = preamble.split("\n")
  const summaryRow = rows.findLastIndex((value) => /^\s+\d+ files? changed(?:,.*)?\s*$/.test(value))
  if (summaryRow < 0) return grouped

  let firstStatRow = summaryRow
  while (firstStatRow > 0 && isStatRow(rows[firstStatRow - 1]!)) firstStatRow--
  if (firstStatRow === summaryRow || rows[firstStatRow - 1] !== "---") return grouped
  for (let row = firstStatRow; row < summaryRow; row++) {
    const value = rows[row]!
    const separator = value.lastIndexOf("|")
    if (separator < 0) continue
    const suffix = value.slice(separator + 1)
    const graph = /^(\s+\d+\s+)([+-]+)(?:\.\.\.)?\s*$/.exec(suffix)
    if (graph !== null) {
      const symbols = graph[2]!
      const graphStart = separator + 1 + graph[1]!.length
      let runStart = 0
      for (let index = 1; index <= symbols.length; index++) {
        if (index < symbols.length && symbols[index] === symbols[runStart]) continue
        addStatSpan(grouped, row, graphStart + runStart, graphStart + index, symbols[runStart] === "+" ? "addition" : "deletion")
        runStart = index
      }
      continue
    }

    const binary = /^(\s+Bin\s+)(\d+)(\s+->\s+)(\d+)(\s+bytes\s*)$/.exec(suffix)
    if (binary === null) continue
    const oldStart = separator + 1 + binary[1]!.length
    const oldEnd = oldStart + binary[2]!.length
    const newStart = oldEnd + binary[3]!.length
    const newEnd = newStart + binary[4]!.length
    addStatSpan(grouped, row, oldStart, oldEnd, "deletion")
    addStatSpan(grouped, row, newStart, newEnd, "addition")
  }
  return grouped
}

function isStatRow(value: string): boolean {
  const separator = value.lastIndexOf("|")
  if (separator < 0) return false
  const suffix = value.slice(separator + 1)
  return /^\s+\d+(?:\s+[+-]+(?:\.\.\.)?)?\s*$/.test(suffix) || /^\s+Bin(?:\s+\d+\s+->\s+\d+\s+bytes)?\s*$/.test(suffix)
}

function addStatSpan(grouped: Map<number, readonly DiffStatSpan[]>, row: number, start: number, end: number, style: DiffStatSpan["style"]): void {
  const spans = [...(grouped.get(row) ?? []), { start, end, style }]
  grouped.set(row, spans)
}

function statSpansForRow(value: string, spans: readonly DiffStatSpan[]): TextChunk[] {
  const chunks: TextChunk[] = []
  let cursor = 0
  for (const span of spans) {
    if (span.start > cursor) chunks.push(plainChunk(value.slice(cursor, span.start)))
    chunks.push(styledChunk(span.style, value.slice(span.start, span.end)))
    cursor = span.end
  }
  if (cursor < value.length) chunks.push(plainChunk(value.slice(cursor)))
  return chunks
}

function preambleSpansForRow(value: string, spans: readonly DiffStatSpan[] | undefined): TextChunk[] {
  return spans === undefined ? [plainChunk(value)] : statSpansForRow(value, spans)
}

/** The text each pane was last installed with, so an unchanged install is free. */
const installedTexts = new WeakMap<TextRenderable, string>()

/**
 * The preamble ends at a row boundary so the diff's first row is `countRows(preamble)`. `git show`
 * always puts the patch on its own line; normalising here keeps that an invariant rather than an
 * assumption, because every row-to-style mapping below depends on it.
 */
function joined(content: DiffTextContent): InstalledPaneText & { readonly firstDiffRow: number } {
  const preamble = content.preamble.length === 0 || content.preamble.endsWith("\n") ? content.preamble : `${content.preamble}\n`
  return { text: `${preamble}${content.body}`, preambleLength: preamble.length, firstDiffRow: countRows(preamble) }
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

function countRows(value: string): number {
  let rows = 0
  for (let index = value.indexOf("\n"); index >= 0; index = value.indexOf("\n", index + 1)) rows++
  return rows
}

/**
 * Encodes the whole document as styled chunks. The gutter is dimmed, the body takes its row's style
 * from `displayLines`, and the preamble's stat graph keeps Git's own colours.
 */
function paintAsChunks(text: TextRenderable, content: DiffTextContent, installed: InstalledPaneText & { readonly firstDiffRow: number }): InstalledPaneText {
  const { text: full, firstDiffRow } = installed
  const preambleSpans = content.preambleSpans ?? statSpansForPreamble(content.preamble)
  const rows = full.split("\n")
  const chunks: TextChunk[] = []
  for (let row = 0; row < rows.length; row++) {
    const value = `${rows[row]!}${row === rows.length - 1 ? "" : "\n"}`
    if (value.length === 0) continue
    const display = content.displayLines[row - firstDiffRow]
    if (display === undefined) {
      chunks.push(...preambleSpansForRow(value, preambleSpans.get(row)))
      continue
    }
    const gutter = value.slice(0, display.gutterCols)
    const body = value.slice(display.gutterCols)
    if (gutter.length > 0) chunks.push(dim(gutter))
    if (body.length > 0) chunks.push(styledChunk(display.style, body))
  }
  text.content = new StyledText(chunks)
  return { text: installed.text, preambleLength: installed.preambleLength }
}

/**
 * Installs `content` as the pane's text. Re-installing byte-identical text is a no-op: it neither
 * re-encodes the document nor touches the scroll offset, which is what makes a no-op refresh free.
 */
export function installDiffText(text: TextRenderable, content: DiffTextContent): InstalledPaneText {
  const installed = joined(content)
  if (installedTexts.get(text) === installed.text) {
    return { text: installed.text, preambleLength: installed.preambleLength }
  }
  installedTexts.set(text, installed.text)
  return paintAsChunks(text, content, installed)
}

/**
 * Forgets the installed text, so the next install writes even if it holds the same characters. The
 * caller writes the pane's replacement text itself.
 */
export function releaseDiffText(text: TextRenderable): void {
  installedTexts.delete(text)
}
