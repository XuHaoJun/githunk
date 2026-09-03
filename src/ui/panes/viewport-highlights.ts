import type { TextRenderable } from "@opentui/core"
import { onPaneLifecyclePass, type PaneTextBuffer } from "./pane-text"

/**
 * The mechanism ./diff-text and ./command-log-text share: paint line-indexed highlights on the
 * logical lines near a viewport, and repaint incrementally as it scrolls.
 *
 * Both panes install their text whole and unstyled through the buffer (see ./pane-text for why that
 * is the cheap route), which leaves OpenTUI owning wrapping, scrolling and selection over the
 * complete document and leaves only the colours lazy. That is lazygit's property too: its main view
 * never processes more of a diff than it is about to display (pkg/gui/view_helpers.go:22
 * `linesToReadFromCmdTask`).
 *
 * What each painter keeps to itself is everything that differs: its style definitions, how it
 * derives one line's highlights, and how it assembles the text. This module owns only the band
 * arithmetic, the caching, and the lifecycle hook.
 *
 * The unit throughout is the *logical* (pre-wrap) line, because that is what
 * `PaneTextBuffer.addHighlight` addresses — OpenTUI 0.5.6's `TextBufferRenderable` keeps the
 * pre-wrap `textBuffer` the highlight calls reach separate from the wrapped `textBufferView` that
 * produces `lineInfo`. A line painted once is therefore coloured on every visual row it wrapped
 * onto, and a wrapped line above the viewport cannot shift anything.
 */

/**
 * Logical lines painted beyond the viewport on each side. The band is recomputed from the pane's
 * own `scrollY`/`height`/`width`, which a lifecycle pass reads *before* layout runs, so a resize can
 * be one frame late; a screenful of slack keeps that invisible.
 */
const MARGIN_LINES = 32

/**
 * Column bound for "to the end of the line/row"; the native buffer clamps it to the real width.
 * Shared by ./diff-text and ./command-log-text — the two files the highlight extraction above was
 * meant to unify — rather than each defining its own copy of the same magic constant.
 */
export const LINE_END_COLS = 1_000_000

export type ViewportHighlightSpec<Content> = {
  readonly buffer: PaneTextBuffer
  /** Paints one logical line's highlights. A line with nothing to paint is a no-op. */
  readonly paintLine: (line: number, content: Content) => void
  /** Optional logical scroll coordinate; virtual buffers paint from local row zero. */
  readonly scrollY?: (content: Content) => number
}

export type ViewportHighlights<Content> = {
  /**
   * Installs `full` as the buffer's text — only when it differs from what is installed, which is
   * what makes a no-op refresh free — and repaints the band around the viewport.
   */
  install(full: string, content: Content): void
  /**
   * Drops every highlight and stops painting until the next `install`, for a caller handing the pane
   * back to plain content or to a different painter. The replacement text is the caller's to write;
   * this only makes sure these highlights cannot bleed into it.
   */
  release(): void
}
export function createViewportHighlights<Content>(text: TextRenderable, spec: ViewportHighlightSpec<Content>): ViewportHighlights<Content> {
  const { buffer, paintLine, scrollY: logicalScrollY } = spec
  /**
   * The content the next paint describes. Assigned by `install` before it sets `active`, and `paint`
   * returns while `!active`, so it is read only after it has been written — which is why the spec
   * carries no initial value to be the one thing nothing can ever observe.
   */
  let content!: Content
  let installed = ""
  let active = false
  /**
   * Visual row → logical line, from the pane's `lineInfo`. Only wrapping makes the two differ, so it
   * changes with the text or the wrap width — never with the scroll offset, which is why it is
   * cached: materialising it costs ~3 ms on a 75k-line patch, and scrolling asks every row.
   */
  let rowSources: readonly number[] | undefined
  let rowSourcesWidth = -1
  let appliedScrollY = -1
  let appliedHeight = -1
  /** Inclusive logical-line range currently carrying highlights, or undefined when none do. */
  let painted: { readonly from: number; readonly to: number } | undefined

  const paint = (force: boolean): void => {
    if (!active) return
    const height = Math.max(1, Math.floor(text.height))
    const scrollY = Math.max(0, Math.floor(logicalScrollY?.(content) ?? text.scrollY))
    const width = Math.max(1, Math.floor(text.width))
    // The width belongs in this guard. Without it a width-only change — a horizontal splitter drag
    // at unchanged height and scroll offset — returned here before reaching the width check below,
    // leaving both the row-to-line map and the painted band stale until the next scroll. In
    // logical-line units that staleness was bounded: a band-edge line left unpainted, or one extra
    // line painted, never a line wearing its neighbour's colour, because a highlight addresses the
    // logical line and not the visual row. That bound is preserved; the staleness is not.
    if (!force && painted !== undefined && appliedScrollY === scrollY && appliedHeight === height && rowSourcesWidth === width) return

    if (rowSources === undefined || rowSourcesWidth !== width) {
      rowSources = text.lineInfo.lineSources
      rowSourcesWidth = width
    }
    const sources = rowSources
    const lastRow = Math.max(0, Math.min(scrollY + height - 1, sources.length - 1))
    const firstLine = sources[Math.min(scrollY, lastRow)] ?? scrollY
    const lastLine = sources[lastRow] ?? lastRow
    const from = Math.max(0, firstLine - MARGIN_LINES)
    const to = lastLine + MARGIN_LINES

    // Lines already painted stay painted: a highlight costs ~46 µs to add, so scrolling by a row
    // must touch a line, not a screenful. Clearing the whole buffer is free by comparison, so a
    // jump that leaves the painted band behind starts over.
    const previous = painted
    if (previous === undefined || previous.to < from || previous.from > to) {
      buffer.clearAllHighlights()
      for (let line = from; line <= to; line++) paintLine(line, content)
    } else {
      for (let line = previous.from; line < from; line++) buffer.clearRow(line)
      for (let line = to + 1; line <= previous.to; line++) buffer.clearRow(line)
      for (let line = from; line < previous.from; line++) paintLine(line, content)
      for (let line = previous.to + 1; line <= to; line++) paintLine(line, content)
    }
    painted = { from, to }
    appliedScrollY = scrollY
    appliedHeight = height
  }

  onPaneLifecyclePass(text, () => paint(false))

  return {
    install(full: string, next: Content): void {
      content = next
      active = true
      const changed = installed !== full
      if (changed) {
        installed = full
        buffer.setText(full)
        rowSources = undefined
        // setText drops the buffer's highlights with the text it styled.
        painted = undefined
      }
      paint(changed)
    },
    release(): void {
      // Releasing twice must not clear anything the second time. `main-pane.ts:276-277` releases the
      // *other* painter immediately before every install, and `MainPreviewGate` does not dedupe
      // identical content, so a refresh re-resolving the same preview runs that pair again — and
      // both painters write through the same underlying `textBuffer`. Without this guard the stale
      // release wiped the live painter's highlights, which its own no-op re-install (unchanged text,
      // scroll and height) then had nothing to repaint. The painters this replaced were idempotent
      // by accident, by deleting their state entry; this is the same property, stated.
      if (!active) return
      buffer.clearAllHighlights()
      active = false
      // Reset to exactly what a first `install` would find, so re-installing after another painter
      // has written its own text still re-installs ours rather than trusting a stale cache.
      installed = ""
      rowSources = undefined
      rowSourcesWidth = -1
      appliedScrollY = -1
      appliedHeight = -1
      painted = undefined
    },
  }
}
