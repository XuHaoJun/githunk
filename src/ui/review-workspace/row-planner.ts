import type { ReviewState } from "../../review/core/state"
import type { ReviewFile, ReviewHunk, ReviewFeedback } from "../../review/core/types"
import { cellWidth } from "../cell-width"

export type ReviewTextSpan = Readonly<{ text: string; style: "plain" | "dim" | "addition" | "deletion" | "hunk" | "feedback"; fg?: string }>
export type ReviewRow = Readonly<{
  kind: "file-header" | "hunk-header" | "diff" | "gap" | "feedback" | "binary" | "too-large"
  fileKey: string
  hunkIndex: number | null
  oldLine: number | null
  newLine: number | null
  text: readonly ReviewTextSpan[]
}>

export type ReviewRowPlan = Readonly<{ start: number; totalRows: number; rows: readonly ReviewRow[] }>

export type PlanReviewRowsOptions = Readonly<{
  viewportStart: number
  viewportHeight: number
  width: number
  effectiveMode: "split" | "stack"
  showLineNumbers?: boolean
  wrapLines?: boolean
  overscan?: number
  expandedSourceByGap?: ReadonlyMap<string, readonly string[]>
  highlightByFileKey?: ReadonlyMap<string, import("../../review/git/highlight/highlight-payload").HighlightPayload>
}>

export const DEFAULT_OVERSCAN = 10

// Cache per-file row fragments and heights
type CacheEntry = Readonly<{
  key: string
  rows: readonly ReviewRow[]
  height: number
}>

const fileRowsCache = new Map<string, CacheEntry>()
const fileHeightCache = new Map<string, number>()

// For testing: allow clearing caches and instrumentation
let buildInvocationCount = 0
export function __clearRowPlannerCache(): void {
  fileRowsCache.clear()
  fileHeightCache.clear()
  buildInvocationCount = 0
}
export function __getBuildInvocationCount(): number {
  return buildInvocationCount
}
export function __resetBuildInvocationCount(): void {
  buildInvocationCount = 0
}

function tabExpanded(text: string, tabWidth = 4): string {
  let result = ""
  let col = 0
  for (const ch of text) {
    if (ch === "\t") {
      const spaces = tabWidth - (col % tabWidth)
      result += " ".repeat(spaces)
      col += spaces
    } else {
      result += ch
      // cellWidth handles wide, but we track col with cellWidth for next tab stop
      // Use isWide via cellWidth per grapheme: cellWidth(ch) approximates
      col += cellWidth(ch)
    }
  }
  return result
}

function splitByCellWidth(text: string, maxCells: number): string[] {
  if (maxCells <= 0) return [text]
  const expanded = tabExpanded(text)
  if (cellWidth(expanded) <= maxCells) return [expanded]
  const chunks: string[] = []
  let current = ""
  let curWidth = 0
  for (const ch of expanded) {
    const w = cellWidth(ch)
    if (curWidth + w > maxCells && current.length > 0) {
      chunks.push(current)
      current = ch
      curWidth = w
    } else {
      current += ch
      curWidth += w
    }
  }
  if (current.length > 0) chunks.push(current)
  // Edge: if single wide char exceeds maxCells? It will be its own chunk (>max), but still one row
  return chunks.length > 0 ? chunks : [""]
}

function lineNumberDigitsForState(state: ReviewState): number {
  let max = 1
  for (const f of state.document.files) {
    for (const h of f.hunks) {
      max = Math.max(max, h.oldStart + h.oldCount, h.newStart + h.newCount)
    }
  }
  // Also consider expanded gap lines: not needed for digits, but approximate
  return String(max).length
}

function gutterCols(showLineNumbers: boolean, digits: number): number {
  if (!showLineNumbers) return 0
  // stack: " old new " => digits +1 + digits +1  (two numbers plus space each)
  // we use digits*2+2 for simplicity
  return digits * 2 + 2
}

function gutterColsForMode(showLineNumbers: boolean, digits: number, mode: "split" | "stack"): number {
  if (!showLineNumbers) return 0
  if (mode === "stack") return digits * 2 + 2
  // split has two gutters plus separator accounting already elsewhere
  return digits * 2 + 2 // total gutter, but per column we divide later
}

function perColumnAvailable(width: number, showLineNumbers: boolean, digits: number, mode: "split" | "stack"): number {
  const gutter = gutterColsForMode(showLineNumbers, digits, mode)
  if (mode === "stack") {
    // marker (1) + space (1) + gutter
    const reserved = gutter + 2
    return Math.max(1, width - reserved)
  } else {
    // split: two columns each has its own numbers? Use total gutter divided + separator 3 " │ "
    const reserved = gutter + 3 + 2 // separator + markers
    const perCol = Math.floor((width - reserved) / 2)
    return Math.max(1, perCol)
  }
}

function fileCacheKey(file: ReviewFile, opts: PlanReviewRowsOptions, state: ReviewState, digits: number): string {
  const expanded = state.expandedGaps.filter(g => g.fileKey === file.key && g.expanded).map(g => g.gapId).sort().join(",")
  const feedbacks = state.feedback.filter(f => f.anchor.fileKey === file.key)
  const feedbackRev = feedbacks.map(f => `${f.id}:${f.updatedAt}`).sort().join("|")
  const highlightKey = opts.highlightByFileKey?.get(file.key)
    ? `${opts.highlightByFileKey.get(file.key)!.theme}:${opts.highlightByFileKey.get(file.key)!.additionLines.length}:${opts.highlightByFileKey.get(file.key)!.deletionLines.length}`
    : "nohl"
  return `${file.contentId}|${opts.width}|${opts.effectiveMode}|${!!opts.showLineNumbers}|${!!opts.wrapLines}|${digits}|${expanded}|${feedbackRev}|${highlightKey}`
}

function computeGapBefore(file: ReviewFile, hunkIndex: number): { lineCount: number; oldRange: [number, number]; newRange: [number, number] } | null {
  if (hunkIndex <= 0 || hunkIndex >= file.hunks.length) return null
  const prev = file.hunks[hunkIndex - 1]!
  const cur = file.hunks[hunkIndex]!
  const gapOld = cur.oldStart - (prev.oldStart + prev.oldCount)
  const gapNew = cur.newStart - (prev.newStart + prev.newCount)
  // Use old gap if they agree, otherwise min positive. If either <=0, no gap.
  let lineCount = gapOld
  if (gapOld !== gapNew) {
    // If they differ but both positive, use min to avoid overcount; spec says they must agree when gap omitted lines are equal
    if (gapOld > 0 && gapNew > 0) lineCount = Math.min(gapOld, gapNew)
    else if (gapOld > 0) lineCount = gapOld
    else lineCount = gapNew
  }
  if (lineCount <= 0) return null
  const oldStart = prev.oldStart + prev.oldCount
  const oldEnd = cur.oldStart - 1
  const newStart = prev.newStart + prev.newCount
  const newEnd = cur.newStart - 1
  if (oldStart < 1 || newStart < 1) return null
  return { lineCount, oldRange: [oldStart, oldEnd], newRange: [newStart, newEnd] }
}

function computeTrailingGap(file: ReviewFile): { lineCount: number; oldRange: [number, number]; newRange: [number, number] } | null {
  // Without additionLines/deletionLines totals we cannot know trailing gap length exactly.
  // Use heuristic: if file source is available and we have expandedSource cache, trailing gap not known.
  // For now we treat trailing gap as zero unless tests inject expandedSourceByGap for trailing.
  // We could provide a sentinel: if file hunks exist, we consider trailing gap not rendered unless caller requests expansion via gapId "trailing:lastIndex"
  // But we will not auto-generate trailing gap from patch alone, to avoid false positives.
  return null
}

function reviewGapIdBefore(hunkIndex: number): string {
  return `before:${hunkIndex}`
}
function reviewGapIdTrailing(hunkIndex: number): string {
  return `trailing:${hunkIndex}`
}

function isGapExpanded(state: ReviewState, fileKey: string, gapId: string): boolean {
  return state.expandedGaps.some(g => g.fileKey === fileKey && g.gapId === gapId && g.expanded)
}

function formatFileHeader(file: ReviewFile): ReviewTextSpan[] {
  const name = file.path
  const prev = file.previousPath ? ` ← ${file.previousPath}` : ""
  return [{ text: `${name}${prev}`, style: "plain" }]
}

function formatHunkHeader(hunk: ReviewHunk): ReviewTextSpan[] {
  return [{ text: `@@ -${hunk.oldStart},${hunk.oldCount} +${hunk.newStart},${hunk.newCount} @@`, style: "hunk" }]
}

function formatDiffRowText(
  linePrefix: string,
  content: string,
  oldLine: number | null,
  newLine: number | null,
  digits: number,
  showLineNumbers: boolean,
  kind: "context" | "addition" | "deletion",
): ReviewTextSpan[] {
  const gutter = showLineNumbers
    ? `${oldLine !== null ? String(oldLine).padStart(digits, " ") : " ".repeat(digits)} ${newLine !== null ? String(newLine).padStart(digits, " ") : " ".repeat(digits)} `
    : ""
  const marker = linePrefix
  const markerStyle = kind === "addition" ? "addition" : kind === "deletion" ? "deletion" : "plain"
  const contentStyle = kind === "addition" ? "addition" : kind === "deletion" ? "deletion" : "plain"
  const spans: ReviewTextSpan[] = []
  if (gutter) spans.push({ text: gutter, style: "dim" })
  spans.push({ text: marker, style: markerStyle })
  if (content.length > 0) spans.push({ text: content, style: contentStyle })
  return spans
}

function wrapRowTextForMeasure(content: string, _marker: string, showLineNumbers: boolean, digits: number, mode: "split"|"stack", width: number, wrapLines: boolean): number {
  if (!wrapLines) return 1
  const avail = perColumnAvailable(width, showLineNumbers, digits, mode)
  // For diff rows, content width = marker (1) + content expanded
  const expanded = tabExpanded(content)
  const needed = cellWidth(expanded) + 1 // + marker
  // In split mode, addition/deletion uses one column, context uses both but max same; approximate needed as above
  // If needed <= avail ->1 else ceil
  if (needed <= avail) return 1
  // split estimation using avail per column
  return Math.max(1, Math.ceil(needed / avail))
}

function buildRowsForFile(
  file: ReviewFile,
  state: ReviewState,
  opts: PlanReviewRowsOptions,
  digits: number,
): readonly ReviewRow[] {
  buildInvocationCount++
  const rows: ReviewRow[] = []
  const showLineNumbers = !!opts.showLineNumbers
  const wrapLines = !!opts.wrapLines
  const mode = opts.effectiveMode
  const width = opts.width
  // File header always
  rows.push({
    kind: "file-header",
    fileKey: file.key,
    hunkIndex: null,
    oldLine: null,
    newLine: null,
    text: formatFileHeader(file),
  })

  // Binary / too-large handling
  if (file.source === "binary" || file.kind === "binary") {
    rows.push({
      kind: "binary",
      fileKey: file.key,
      hunkIndex: null,
      oldLine: null,
      newLine: null,
      text: [{ text: "Binary file — not displayed. File-level feedback and Viewed still available.", style: "dim" }],
    })
    // File-level feedback for binary still inserted after binary row
    const fileFeedbacks = state.feedback.filter(f => f.anchor.fileKey === file.key)
    for (const fb of fileFeedbacks) {
      rows.push({
        kind: "feedback",
        fileKey: file.key,
        hunkIndex: null,
        oldLine: null,
        newLine: null,
        text: [{ text: `◆ ${fb.body.slice(0, 80)}`, style: "feedback" }],
      })
    }
    return rows
  }
  if (file.source === "too-large") {
    rows.push({
      kind: "too-large",
      fileKey: file.key,
      hunkIndex: null,
      oldLine: null,
      newLine: null,
      text: [{ text: "File too large — diff not displayed. File-level feedback and Viewed still available.", style: "dim" }],
    })
    const fileFeedbacks = state.feedback.filter(f => f.anchor.fileKey === file.key)
    for (const fb of fileFeedbacks) {
      rows.push({
        kind: "feedback",
        fileKey: file.key,
        hunkIndex: null,
        oldLine: null,
        newLine: null,
        text: [{ text: `◆ ${fb.body.slice(0, 80)}`, style: "feedback" }],
      })
    }
    return rows
  }

  // Map feedback by hunk and line for quick lookup
  const feedbackByHunkLine = new Map<string, ReviewFeedback[]>()
  for (const fb of state.feedback) {
    if (fb.anchor.fileKey !== file.key) continue
    if (fb.anchor.kind === "file") {
      const key = `file:${file.key}`
      const arr = feedbackByHunkLine.get(key) ?? []
      arr.push(fb)
      feedbackByHunkLine.set(key, arr)
    } else if (fb.anchor.kind === "range") {
      const anchor = fb.anchor
      const key = `range:${anchor.ownerHunkIndex}:${anchor.startLine}-${anchor.endLine}:${anchor.side}`
      const arr = feedbackByHunkLine.get(key) ?? []
      arr.push(fb)
      feedbackByHunkLine.set(key, arr)
    }
  }
  // File-level feedback insertion after file header (for file anchors)
  const fileLevelFeedbacks = feedbackByHunkLine.get(`file:${file.key}`) ?? []
  for (const fb of fileLevelFeedbacks) {
    // feedback body may wrap
    const body = fb.body
    const spans = wrapLines ? splitByCellWidth(body, perColumnAvailable(width, showLineNumbers, digits, mode)).flatMap((chunk, idx) => idx===0 ? [{ text: `◆ ${chunk}`, style: "feedback" as const }] : [{ text: `  ${chunk}`, style: "feedback" as const }]) : [{ text: `◆ ${body}`, style: "feedback" as const }]
    // If multiple chunks, we push multiple feedback rows? Spec says feedback insertion row ordering — one row per feedback but wrapped continuations are extra rows?
    // For simplicity, if wraps, emit multiple rows with same feedback? But brief says feedback insertion and wrapping tested separately. We'll emit one row per chunk with same kind feedback (continuations)
    const chunks = wrapLines ? splitByCellWidth(body, perColumnAvailable(width, showLineNumbers, digits, mode)) : [body]
    for (let ci = 0; ci < chunks.length; ci++) {
      rows.push({
        kind: "feedback",
        fileKey: file.key,
        hunkIndex: null,
        oldLine: null,
        newLine: null,
        text: [{ text: `${ci===0 ? "◆ " : "  "}${chunks[ci]}`, style: "feedback" }],
      })
    }
  }

  if (file.hunks.length === 0) {
    rows.push({
      kind: "gap",
      fileKey: file.key,
      hunkIndex: null,
      oldLine: null,
      newLine: null,
      text: [{ text: "No hunks — file mode change or empty diff.", style: "dim" }],
    })
    return rows
  }

  const highlight = opts.highlightByFileKey?.get(file.key)
  let highlightAdditionIdx = 0
  let highlightDeletionIdx = 0

  for (let hunkIdx = 0; hunkIdx < file.hunks.length; hunkIdx++) {
    const hunk = file.hunks[hunkIdx]!
    // Gap before this hunk
    const gapBefore = hunkIdx > 0 ? computeGapBefore(file, hunkIdx) : null
    if (gapBefore) {
      const gapId = reviewGapIdBefore(hunkIdx)
      const expanded = isGapExpanded(state, file.key, gapId)
      if (!expanded) {
        const count = gapBefore.lineCount
        rows.push({
          kind: "gap",
          fileKey: file.key,
          hunkIndex: hunkIdx,
          oldLine: null,
          newLine: null,
          text: [{ text: `▶ ${count} hidden ${count===1?"line":"lines"} — press z or click to expand`, style: "dim" }],
        })
      } else {
        // Expanded: emit rows for each hidden line using cached source if available, else synthetic
        const cacheKey = `${file.key}:${gapId}`
        const cachedLines = opts.expandedSourceByGap?.get(cacheKey)
        const oldRange = gapBefore.oldRange
        const newRange = gapBefore.newRange
        const side = file.kind === "deleted" ? "old" as const : "new" as const
        const range = side === "old" ? oldRange : newRange
        const lineCount = gapBefore.lineCount
        let linesToRender: readonly string[]
        if (cachedLines) {
          linesToRender = cachedLines
        } else {
          // Synthetic: generate placeholders for each line in gap range
          linesToRender = Array.from({ length: lineCount }, (_, i) => `unchanged line ${range[0]+i} synthetic`)
        }
        // For each hidden line, emit diff-like context row with both old/new numbers
        let curOld = oldRange[0]
        let curNew = newRange[0]
        for (const l of linesToRender) {
          const avail = perColumnAvailable(width, showLineNumbers, digits, mode)
          const content = l
          const gutter = showLineNumbers ? `${String(curOld).padStart(digits," ")} ${String(curNew).padStart(digits," ")} ` : ""
          const baseText = `${gutter} ${content}` // marker space
          // Determine wrap chunks
          if (wrapLines) {
            const chunks = splitByCellWidth(content, avail - 1) // -1 for marker
            for (let ci=0; ci<chunks.length; ci++) {
              const isFirst = ci===0
              const textSpans: ReviewTextSpan[] = []
              if (showLineNumbers && isFirst) textSpans.push({ text: `${String(curOld).padStart(digits," ")} ${String(curNew).padStart(digits," ")} `, style: "dim" })
              else if (showLineNumbers && !isFirst) textSpans.push({ text: " ".repeat(digits*2+2), style: "dim" })
              textSpans.push({ text: " ", style: "plain" })
              textSpans.push({ text: chunks[ci]!, style: "plain" })
              rows.push({
                kind: "diff",
                fileKey: file.key,
                hunkIndex: hunkIdx,
                oldLine: curOld,
                newLine: curNew,
                text: textSpans,
              })
            }
          } else {
            const textSpans: ReviewTextSpan[] = []
            if (showLineNumbers) textSpans.push({ text: `${String(curOld).padStart(digits," ")} ${String(curNew).padStart(digits," ")} `, style: "dim" })
            textSpans.push({ text: " ", style: "plain" })
            textSpans.push({ text: content, style: "plain" })
            rows.push({
              kind: "diff",
              fileKey: file.key,
              hunkIndex: hunkIdx,
              oldLine: curOld,
              newLine: curNew,
              text: textSpans,
            })
          }
          curOld++; curNew++
        }
      }
    }

    // Hunk header
    rows.push({
      kind: "hunk-header",
      fileKey: file.key,
      hunkIndex: hunkIdx,
      oldLine: null,
      newLine: null,
      text: formatHunkHeader(hunk),
    })

    // Diff lines
    let oldLine = hunk.oldStart
    let newLine = hunk.newStart
    for (let li = 0; li < hunk.lines.length; li++) {
      const raw = hunk.lines[li]!
      // Handle "\ No newline" sentinel if present as raw starting with "\"
      if (raw.startsWith("\\")) {
        rows.push({
          kind: "diff",
          fileKey: file.key,
          hunkIndex: hunkIdx,
          oldLine: null,
          newLine: null,
          text: [{ text: "↵ No newline at end of file", style: "dim" }],
        })
        continue
      }
      const prefix = raw[0] as string
      const contentRaw = raw.slice(1)
      const content = tabExpanded(contentRaw)
      let kind: "context" | "addition" | "deletion"
      let curOld: number | null = null
      let curNew: number | null = null
      if (prefix === " ") { kind = "context"; curOld = oldLine; curNew = newLine }
      else if (prefix === "+") { kind = "addition"; curNew = newLine }
      else if (prefix === "-") { kind = "deletion"; curOld = oldLine }
      else { kind = "context"; curOld = oldLine; curNew = newLine }

      // Check if next line is marker for no-final-newline after this diff line?
      const nextRaw = hunk.lines[li+1]
      const hasNoNewlineMarkerAfter = nextRaw !== undefined && nextRaw.startsWith("\\")

      // Resolve highlight tokens for this line (windowed, per-file sequential indexes)
      let highlightedSpans: readonly ReviewTextSpan[] | null = null
      if (highlight && !wrapLines) {
        let tokens: readonly { readonly text: string; readonly fg?: string }[] | null = null
        if (kind === "addition") {
          tokens = highlight.additionLines[highlightAdditionIdx] ?? null
          highlightAdditionIdx++
        } else if (kind === "deletion") {
          tokens = highlight.deletionLines[highlightDeletionIdx] ?? null
          highlightDeletionIdx++
        } else {
          const add = highlight.additionLines[highlightAdditionIdx] ?? null
          const del = highlight.deletionLines[highlightDeletionIdx] ?? null
          tokens = add ?? del
          highlightAdditionIdx++
          highlightDeletionIdx++
        }
        if (tokens !== null) {
          const spans: ReviewTextSpan[] = []
          if (showLineNumbers) {
            const oldStr = curOld === null ? " ".repeat(digits) : String(curOld).padStart(digits, " ")
            const newStr = curNew === null ? " ".repeat(digits) : String(curNew).padStart(digits, " ")
            spans.push({ text: `${oldStr} ${newStr} `, style: "dim" })
          }
          const markerStyle = kind === "addition" ? "addition" : kind === "deletion" ? "deletion" : "plain"
          spans.push({ text: prefix === " " ? " " : prefix, style: markerStyle })
          if (tokens.length === 0) {
            highlightedSpans = spans
          } else {
            for (const tok of tokens) {
              const t = tabExpanded(tok.text)
              spans.push({ text: t, style: kind === "addition" ? "addition" : kind === "deletion" ? "deletion" : "plain", ...(tok.fg ? { fg: tok.fg } : {}) })
            }
            highlightedSpans = spans
          }
        }
      }

      // Build base spans for one logical row, but possibly split into wrapped continuations
      const baseSpans = formatDiffRowText(prefix, content, curOld, curNew, digits, showLineNumbers, kind)
      // Wrap handling: produce multiple ReviewRows if needed
      if (wrapLines) {
        const avail = perColumnAvailable(width, showLineNumbers, digits, mode)
        const chunks = splitByCellWidth(content, Math.max(1, avail - 2))
        if (chunks.length <= 1) {
          rows.push({
            kind: "diff",
            fileKey: file.key,
            hunkIndex: hunkIdx,
            oldLine: curOld,
            newLine: curNew,
            text: highlightedSpans ?? baseSpans,
          })
        } else {
          for (let ci = 0; ci < chunks.length; ci++) {
            const chunk = chunks[ci]!
            const isFirst = ci===0
            let text: readonly ReviewTextSpan[]
            if (isFirst) {
              text = highlightedSpans ?? formatDiffRowText(prefix, chunk, curOld, curNew, digits, showLineNumbers, kind)
            } else {
              const indent = showLineNumbers ? " ".repeat(digits*2+2) : ""
              const contSpans: ReviewTextSpan[] = []
              if (indent) contSpans.push({ text: indent, style: "dim" })
              contSpans.push({ text: " ", style: "plain" })
              contSpans.push({ text: chunk, style: kind==="addition" ? "addition" : kind==="deletion" ? "deletion" : "plain" })
              text = contSpans
            }
            rows.push({
              kind: "diff",
              fileKey: file.key,
              hunkIndex: hunkIdx,
              oldLine: curOld,
              newLine: curNew,
              text,
            })
          }
        }
      } else {
        rows.push({
          kind: "diff",
          fileKey: file.key,
          hunkIndex: hunkIdx,
          oldLine: curOld,
          newLine: curNew,
          text: highlightedSpans ?? baseSpans,
        })
      }

      // If file-level no-newline marker was discarded in parsing, we synthesize detection:
      // If this is last line of last hunk and content doesn't end with newline? For placeholder, we skip.
      // Insert marker row if next raw is no-newline sentinel already handled above as separate row.
      // Also if raw line indicates truncation due to missing newline, we produce marker row now when sentinel present.
      // The sentinel case already pushes marker row next iteration, so nothing extra.

      // Feedback insertion after this diff line: find feedbacks anchored to this exact line/side/hunk
      // For range anchors: insertion after endLine inclusive
      // Collect feedbacks where ownerHunkIndex === hunkIdx and startLine <= curLine <= endLine, and we insert after endLine row
      // So we need to check if curOld/new matches endLine.
      const feedbacksToInsert: ReviewFeedback[] = []
      for (const fb of state.feedback) {
        if (fb.anchor.fileKey !== file.key) continue
        if (fb.anchor.kind !== "range") continue
        const a = fb.anchor
        if (a.ownerHunkIndex !== hunkIdx) continue
        // Determine which line number corresponds to this row's side
        // For context rows, both sides same; we treat both
        // For addition, only newLine; deletion only oldLine
        let lineForSide: number | null = null
        let side: "old" | "new" | null = null
        if (kind === "context") {
          // For context, anchor could be on either side. We consider insertion after whichever side matches endLine.
          // We'll match if either old or new equals endLine
          if (a.side === "old" && curOld === a.endLine) { lineForSide = curOld; side = "old" }
          else if (a.side === "new" && curNew === a.endLine) { lineForSide = curNew; side = "new" }
          // Also if not matched on first try, check opposite? For context lines both sides present, either could be anchor side.
        } else if (kind === "addition" && a.side === "new" && curNew === a.endLine) { lineForSide = curNew; side = "new" }
        else if (kind === "deletion" && a.side === "old" && curOld === a.endLine) { lineForSide = curOld; side = "old" }
        if (lineForSide !== null && side === a.side) {
          feedbacksToInsert.push(fb)
        }
      }
      for (const fb of feedbacksToInsert) {
        const body = fb.body
        if (wrapLines) {
          const avail = perColumnAvailable(width, showLineNumbers, digits, mode)
          const chunks = splitByCellWidth(body, avail)
          for (let ci=0; ci<chunks.length; ci++) {
            rows.push({
              kind: "feedback",
              fileKey: file.key,
              hunkIndex: hunkIdx,
              oldLine: null,
              newLine: null,
              text: [{ text: `${ci===0?"◆ ":"  "}${chunks[ci]}`, style: "feedback" }],
            })
          }
        } else {
          rows.push({
            kind: "feedback",
            fileKey: file.key,
            hunkIndex: hunkIdx,
            oldLine: null,
            newLine: null,
            text: [{ text: `◆ ${body}`, style: "feedback" }],
          })
        }
      }

      // Advance counters for next line's numbers (only if this line contributed to that side)
      if (prefix === " " || prefix === "-") oldLine++
      if (prefix === " " || prefix === "+") newLine++

      // If marker sentinel follows, the sentinel row was already queued via next iteration's handling?
      // No, we handled sentinel as separate row; the sentinel line itself does not advance line numbers.
    }

    // Trailing gap after last hunk
    if (hunkIdx === file.hunks.length - 1) {
      const trailing = computeTrailingGap(file)
      // Instead we handle synthetic trailing gap via expandedSourceByGap for trailing
      const gapId = reviewGapIdTrailing(hunkIdx)
      if (trailing) {
        // not used currently
      } else if (opts.expandedSourceByGap?.has(`${file.key}:${gapId}`)) {
        const cachedLines = opts.expandedSourceByGap.get(`${file.key}:${gapId}`)!
        // Emit expanded lines similarly to before gap but trailing
        const rangeStart = hunk.newStart + hunk.newCount // approximate
        let curNew = rangeStart
        let curOld = hunk.oldStart + hunk.oldCount
        for (const l of cachedLines) {
          const avail = perColumnAvailable(width, showLineNumbers, digits, mode)
          const content = l
          if (wrapLines) {
            const chunks = splitByCellWidth(content, avail - 1)
            for (let ci=0; ci<chunks.length; ci++) {
              const isFirst = ci===0
              const textSpans: ReviewTextSpan[] = []
              if (showLineNumbers && isFirst) textSpans.push({ text: `${String(curOld).padStart(digits," ")} ${String(curNew).padStart(digits," ")} `, style: "dim" })
              else if (showLineNumbers) textSpans.push({ text: " ".repeat(digits*2+2), style: "dim" })
              textSpans.push({ text: " ", style: "plain" })
              textSpans.push({ text: chunks[ci]!, style: "plain" })
              rows.push({ kind: "diff", fileKey: file.key, hunkIndex: hunkIdx, oldLine: curOld, newLine: curNew, text: textSpans })
            }
          } else {
            const textSpans: ReviewTextSpan[] = []
            if (showLineNumbers) textSpans.push({ text: `${String(curOld).padStart(digits," ")} ${String(curNew).padStart(digits," ")} `, style: "dim" })
            textSpans.push({ text: " ", style: "plain" })
            textSpans.push({ text: content, style: "plain" })
            rows.push({ kind: "diff", fileKey: file.key, hunkIndex: hunkIdx, oldLine: curOld, newLine: curNew, text: textSpans })
          }
          curOld++; curNew++
        }
      }
    }
  }

  // After all hunks, feedbacks that anchor to file but already inserted; others already inserted inline.
  // Range feedbacks with fileKey but ownerHunkIndex beyond existing? Already handled inline.

  return rows
}

function measureFileHeight(
  file: ReviewFile,
  state: ReviewState,
  opts: PlanReviewRowsOptions,
  digits: number,
): number {
  const showLineNumbers = !!opts.showLineNumbers
  const wrapLines = !!opts.wrapLines
  const mode = opts.effectiveMode
  const width = opts.width
  // Cheap measurement without allocating spans
  if (file.source === "binary" || file.kind === "binary") {
    // header + binary row + file feedback rows (count)
    const fbCount = state.feedback.filter(f => f.anchor.fileKey===file.key && f.anchor.kind==="file").length
    let fbRows = 0
    if (wrapLines) {
      for (const fb of state.feedback.filter(f=>f.anchor.fileKey===file.key && f.anchor.kind==="file")) {
        const avail = perColumnAvailable(width, showLineNumbers, digits, mode)
        fbRows += Math.max(1, Math.ceil(cellWidth(tabExpanded(fb.body)) / avail))
      }
    } else {
      fbRows = fbCount
    }
    return 1 + 1 + fbRows
  }
  if (file.source === "too-large") {
    const fbCount = state.feedback.filter(f => f.anchor.fileKey===file.key && f.anchor.kind==="file").length
    let fbRows = 0
    if (wrapLines) {
      for (const fb of state.feedback.filter(f=>f.anchor.fileKey===file.key && f.anchor.kind==="file")) {
        const avail = perColumnAvailable(width, showLineNumbers, digits, mode)
        fbRows += Math.max(1, Math.ceil(cellWidth(tabExpanded(fb.body)) / avail))
      }
    } else fbRows = fbCount
    return 1 + 1 + fbRows
  }
  // header + file-level feedback
  let height = 1
  const fileLevelFbs = state.feedback.filter(f => f.anchor.fileKey===file.key && f.anchor.kind==="file")
  if (wrapLines) {
    for (const fb of fileLevelFbs) {
      const avail = perColumnAvailable(width, showLineNumbers, digits, mode)
      height += Math.max(1, Math.ceil(cellWidth(tabExpanded(fb.body)) / avail))
    }
  } else {
    height += fileLevelFbs.length
  }
  if (file.hunks.length === 0) {
    height += 1 // no-hunks gap placeholder
    return height
  }
  for (let hIdx=0; hIdx<file.hunks.length; hIdx++) {
    const hunk = file.hunks[hIdx]!
    // gap before
    if (hIdx>0) {
      const gap = computeGapBefore(file, hIdx)
      if (gap) {
        const gapId = reviewGapIdBefore(hIdx)
        const expanded = isGapExpanded(state, file.key, gapId)
        if (!expanded) {
          height += 1
        } else {
          const cacheKey = `${file.key}:${gapId}`
          const cached = opts.expandedSourceByGap?.get(cacheKey)
          const count = cached ? cached.length : gap.lineCount
          if (wrapLines) {
            const avail = perColumnAvailable(width, showLineNumbers, digits, mode)
            for (let i=0;i<count;i++) {
              const line = cached ? cached[i]! : `unchanged line`
              const expandedContent = tabExpanded(line)
              const needed = cellWidth(expandedContent)+1
              height += Math.max(1, Math.ceil(needed / avail))
            }
          } else {
            height += count
          }
        }
      }
    }
    // hunk header
    height += 1
    // diff lines
    let oldLine = hunk.oldStart
    let newLine = hunk.newStart
    for (const raw of hunk.lines) {
      if (raw.startsWith("\\")) {
        height += 1
        continue
      }
      const prefix = raw[0] as string
      const contentRaw = raw.slice(1)
      const content = tabExpanded(contentRaw)
      let kind: "context"|"addition"|"deletion" = "context"
      if (prefix===" ") kind="context"
      else if (prefix==="+") kind="addition"
      else if (prefix==="-") kind="deletion"
      const avail = perColumnAvailable(width, showLineNumbers, digits, mode)
      let lineHeight = 1
      if (wrapLines) {
        const needed = cellWidth(content)+1
        if (needed > avail) lineHeight = Math.ceil(needed / avail)
        // also need to account for per-column split specifics: for context both sides same, but approximate as above
      }
      height += lineHeight
      // feedback rows after this line
      // For each feedback where endLine matches this line, add its height
      for (const fb of state.feedback) {
        if (fb.anchor.fileKey !== file.key) continue
        if (fb.anchor.kind !== "range") continue
        const a = fb.anchor
        if (a.ownerHunkIndex !== hIdx) continue
        let matches = false
        if (kind==="context") {
          if (a.side==="old" && oldLine===a.endLine) matches=true
          if (a.side==="new" && newLine===a.endLine) matches=true
        } else if (kind==="addition" && a.side==="new" && newLine===a.endLine) matches=true
        else if (kind==="deletion" && a.side==="old" && oldLine===a.endLine) matches=true
        if (matches) {
          const body = tabExpanded(fb.body)
          if (wrapLines) {
            const fbAvail = perColumnAvailable(width, showLineNumbers, digits, mode)
            height += Math.max(1, Math.ceil(cellWidth(body)/fbAvail))
          } else height+=1
        }
      }
      if (prefix===" " || prefix==="-") oldLine++
      if (prefix===" " || prefix==="+") newLine++
    }
  }
  // trailing expanded gap not measured unless cached present
  const lastIdx = file.hunks.length-1
  const trailingKey = `${file.key}:${reviewGapIdTrailing(lastIdx)}`
  if (opts.expandedSourceByGap?.has(trailingKey)) {
    const cached = opts.expandedSourceByGap.get(trailingKey)!
    if (wrapLines) {
      const avail = perColumnAvailable(width, showLineNumbers, digits, mode)
      for (const l of cached) height += Math.max(1, Math.ceil(cellWidth(tabExpanded(l))/avail))
    } else height+=cached.length
  }
  return height
}

export function reviewFileStartOffset(
  state: ReviewState,
  options: PlanReviewRowsOptions,
  fileKey: string,
): number | null {
  const width = Math.max(1, Math.floor(options.width))
  const showLineNumbers = !!options.showLineNumbers
  const wrapLines = !!options.wrapLines
  const normalizedOptions = {
    ...options,
    width,
    showLineNumbers,
    wrapLines,
  }
  const digits = lineNumberDigitsForState(state)
  let offset = 0
  for (const file of state.document.files) {
    if (file.key === fileKey) return offset
    const key = fileCacheKey(file, normalizedOptions, state, digits)
    let height = fileHeightCache.get(key)
    if (height === undefined) {
      height = measureFileHeight(file, state, normalizedOptions, digits)
      fileHeightCache.set(key, height)
    }
    offset += height
  }
  return null
}

export function planReviewRows(state: ReviewState, opts: PlanReviewRowsOptions): ReviewRowPlan {
  const viewportStart = Math.max(0, Math.floor(opts.viewportStart))
  const viewportHeight = Math.max(0, Math.floor(opts.viewportHeight))
  const width = Math.max(1, Math.floor(opts.width))
  const overscan = opts.overscan ?? DEFAULT_OVERSCAN
  const showLineNumbers = !!opts.showLineNumbers
  const wrapLines = !!opts.wrapLines
  const effectiveMode = opts.effectiveMode

  const digits = lineNumberDigitsForState(state)
  // Compute heights for all files (using cheap measure)
  const heights: number[] = []
  const offsets: number[] = [0]
  let totalRows = 0
  for (const file of state.document.files) {
    const key = fileCacheKey(file, { ...opts, width, effectiveMode, showLineNumbers, wrapLines, overscan }, state, digits)
    let h = fileHeightCache.get(key)
    if (h === undefined) {
      h = measureFileHeight(file, state, { ...opts, width, effectiveMode, showLineNumbers, wrapLines, overscan }, digits)
      fileHeightCache.set(key, h)
    }
    heights.push(h)
    totalRows += h
    offsets.push(totalRows)
  }

  // Windowed range with overscan
  const windowStart = Math.max(0, viewportStart - overscan)
  const windowEnd = Math.min(totalRows, viewportStart + viewportHeight + overscan)
  const windowSize = Math.max(0, windowEnd - windowStart)

  // Find first and last file index intersecting window
  if (state.document.files.length === 0 || windowSize===0) {
    return { start: windowStart, totalRows, rows: [] }
  }

  // Binary search helper
  function findFileIdx(row: number): number {
    let lo=0, hi=offsets.length-1
    while (lo<hi) {
      const mid = Math.floor((lo+hi)/2)
      if (offsets[mid]! <= row && row < offsets[mid+1]!) return mid
      if (row < offsets[mid]!) hi=mid-1
      else lo=mid+1
    }
    return Math.min(state.document.files.length-1, lo)
  }
  const firstFileIdx = findFileIdx(windowStart)
  const lastFileIdx = findFileIdx(windowEnd-1)

  const rows: ReviewRow[] = []
  let emitted = 0
  // Build rows only for files in window range
  for (let fileIdx=firstFileIdx; fileIdx<=lastFileIdx; fileIdx++) {
    const file = state.document.files[fileIdx]!
    const fileStart = offsets[fileIdx]!
    // Get or build full file rows (cached)
    const cacheKey = fileCacheKey(file, { ...opts, width, effectiveMode, showLineNumbers, wrapLines, overscan }, state, digits)
    let entry = fileRowsCache.get(cacheKey)
    if (!entry) {
      const built = buildRowsForFile(file, state, { ...opts, width, effectiveMode, showLineNumbers, wrapLines, overscan }, digits)
      entry = { key: cacheKey, rows: built, height: built.length }
      fileRowsCache.set(cacheKey, entry)
      // Ensure heightCache consistency: if height mismatch, update (should match measure)
      fileHeightCache.set(cacheKey, built.length)
    }
    const fileRows = entry.rows
    // Slice intersecting window
    const fileWindowStart = Math.max(0, windowStart - fileStart)
    const fileWindowEnd = Math.min(fileRows.length, windowEnd - fileStart)
    for (let i=fileWindowStart; i<fileWindowEnd; i++) {
      rows.push(fileRows[i]!)
      emitted++
      if (emitted >= windowSize) break
    }
    if (emitted >= windowSize) break
  }

  return { start: windowStart, totalRows, rows }
}

export function sourceAddressAtViewportRow(plan: ReviewRowPlan, viewportRow: number): { fileKey: string; hunkIndex: number | null; oldLine: number | null; newLine: number | null } | null {
  // viewportRow is global row index (0..totalRows-1)
  // Find within plan.rows
  const idx = viewportRow - plan.start
  if (idx <0 || idx >= plan.rows.length) return null
  const row = plan.rows[idx]!
  // Only diff rows with source lines count? But we return whatever address; caller checks non-null
  return { fileKey: row.fileKey, hunkIndex: row.hunkIndex, oldLine: row.oldLine, newLine: row.newLine }
}

export function sourceAddressForRow(row: ReviewRow): { fileKey: string; hunkIndex: number | null; oldLine: number | null; newLine: number | null } | null {
  if (row.kind !== "diff") return null
  if (row.oldLine===null && row.newLine===null) return null
  return { fileKey: row.fileKey, hunkIndex: row.hunkIndex, oldLine: row.oldLine, newLine: row.newLine }
}

export type ReviewRangeResult =
  | { ok: true; anchor: { fileKey: string; side: "old"|"new"; startLine: number; endLine: number; ownerHunkIndex: number } }
  | { ok: false; reason: string }

export function resolveRangeFromViewportSelection(plan: ReviewRowPlan, startViewportRow: number, endViewportRow: number): ReviewRangeResult {
  const startIdx = startViewportRow - plan.start
  const endIdx = endViewportRow - plan.start
  if (startIdx <0 || startIdx>=plan.rows.length || endIdx<0 || endIdx>=plan.rows.length) {
    return { ok:false, reason: "selection outside visible window" }
  }
  const startRow = plan.rows[startIdx]!
  const endRow = plan.rows[endIdx]!
  // Reject if either row is not diff or lacks source lines
  if (startRow.kind !== "diff" || endRow.kind !== "diff") {
    return { ok:false, reason: "range can only include diff lines" }
  }
  if ((startRow.oldLine===null && startRow.newLine===null) || (endRow.oldLine===null && endRow.newLine===null)) {
    return { ok:false, reason: "diff rows must have a source line" }
  }
  // Cross-file rejection
  if (startRow.fileKey !== endRow.fileKey) {
    return { ok:false, reason: "cross-file ranges are not supported" }
  }
  // Cross-side rejection: infer sides
  const inferSide = (r: ReviewRow): "old"|"new"|"both"|null => {
    if (r.oldLine!==null && r.newLine!==null) return "both"
    if (r.oldLine!==null) return "old"
    if (r.newLine!==null) return "new"
    return null
  }
  const startSide = inferSide(startRow)
  const endSide = inferSide(endRow)
  if (startSide!==endSide) {
    // For context rows both, they are considered compatible with either side?
    // If one is both and other is old/new, allow but need to normalize to same side.
    // If both are both, okay. If both are distinct single sides, reject.
    const isBoth = (s: string|null) => s==="both"
    if (!isBoth(startSide) && !isBoth(endSide) && startSide!==endSide) {
      return { ok:false, reason: "cross-side ranges are not supported — use a single side" }
    }
  }
  // Resolve actual side: prefer old if both rows contain old, else new
  let side: "old"|"new"
  if (startSide==="both" && endSide==="both") side = "new" // default to new for context, per convention suggestion must be new
  else if (startSide==="both") side = endSide as "old"|"new"
  else if (endSide==="both") side = startSide as "old"|"new"
  else side = startSide as "old"|"new"

  // Map rows to source lines, deduplicating wrapped continuations (same source line)
  // Gather source lines in plan slice between start and end inclusive, but deduplicate consecutive same line
  const low = Math.min(startIdx, endIdx)
  const high = Math.max(startIdx, endIdx)
  const lines: number[] = []
  const seen = new Set<string>()
  for (let i=low; i<=high; i++) {
    const r = plan.rows[i]!
    if (r.kind!=="diff") continue
    // Skip gap/header etc already filtered? But our range includes only diff rows between; if gaps inside range, they would be ignored but we already reject cross-file etc? We should just consider diff rows
    const line = side==="old" ? r.oldLine : r.newLine
    if (line===null) continue
    const key = `${r.fileKey}:${r.hunkIndex}:${side}:${line}`
    if (seen.has(key)) continue
    seen.add(key)
    lines.push(line)
  }
  if (lines.length===0) return { ok:false, reason: "no selectable source lines in range" }
  const uniqSorted = [...new Set(lines)].sort((a,b)=>a-b)
  const startLine = uniqSorted[0]!
  const endLine = uniqSorted[uniqSorted.length-1]!
  // For inclusive range, ensure contiguous? Not required.
  const ownerHunkIndex = startRow.hunkIndex ?? endRow.hunkIndex ?? 0
  return { ok:true, anchor: { fileKey: startRow.fileKey, side, startLine, endLine, ownerHunkIndex: ownerHunkIndex as number } }
}

export function reviewGapId(position: "before"|"trailing", hunkIndex: number): string {
  return `${position}:${hunkIndex}`
}
export function parseReviewGapId(gapId: string): { position: "before"|"trailing"; hunkIndex: number } | undefined {
  const m = /^(before|trailing):(\d+)$/.exec(gapId)
  if (!m) return undefined
  const hunkIndex = Number(m[2])
  if (!Number.isSafeInteger(hunkIndex)) return undefined
  return { position: m[1] as "before"|"trailing", hunkIndex }
}
