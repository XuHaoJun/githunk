import type { ColorInput, TextRenderable } from "@opentui/core"

/**
 * The one place that reaches into OpenTUI's text internals.
 *
 * Assigning `TextRenderable.content` encodes the value as styled chunks, and OpenTUI does that in
 * time proportional to *chunks times lines* whenever a `SyntaxStyle` is attached — which
 * `TextBufferRenderable` always does. Measured on 0.5.14, a 2000-line (136 KB) single-chunk write
 * costs ~14 µs per line through `content` (28 ms) but ~0.6 ms through the buffer's own `setText`,
 * so a 4 MB command log or patch takes seconds the slow way. Styling then comes from line-indexed
 * highlights, which can be applied to just the rows a viewport shows.
 *
 * These members are `protected` in OpenTUI's typings, so every access goes through `paneTextBuffer`
 * and callers fall back to `content` when a future OpenTUI reshapes them.
 */

export type PaneHighlight = { readonly start: number; readonly end: number; readonly styleId: number }

export type PaneStyleDefinition = { readonly fg?: ColorInput; readonly bg?: ColorInput; readonly bold?: boolean; readonly dim?: boolean }

export type PaneTextBuffer = {
  /** Replaces the whole buffer. Drops any highlights, and does not touch the scroll offset. */
  setText(value: string): void
  /**
   * Styles `[start, end)` *columns* of one row; `end` past the row's width is clamped. Costs ~46 µs
   * per call whatever the buffer holds, so callers paint rows once and keep them.
   */
  addHighlight(row: number, highlight: PaneHighlight): void
  clearRow(row: number): void
  clearAllHighlights(): void
  /** Interns a style and returns the id `addHighlight` refers to. */
  registerStyle(name: string, definition: PaneStyleDefinition): number
  /**
   * Re-reads buffer state into the rendered view. Required after `addHighlight`/
   * `clearRow`/`clearAllHighlights` performed outside a render pass (paints that
   * run inside `onPaneLifecyclePass` need none); `setText` already refreshes.
   */
  refresh(): void
}

type Internals = {
  readonly textBuffer: {
    setText(value: string): void
    addHighlight(row: number, highlight: PaneHighlight): void
    clearLineHighlights(row: number): void
    clearAllHighlights(): void
  }
  readonly _textBufferSyntaxStyle: { registerStyle(name: string, definition: PaneStyleDefinition): number }
  updateTextInfo(): void
  /**
   * OpenTUI clears a text buffer it believes it owns (`updateTextFromNodes`) unless a manual
   * styled text was assigned. Writing through `setText` never sets that flag, so it is set here —
   * otherwise a later fg/bg change on the renderable would wipe the buffer.
   */
  _hasManualStyledText?: boolean
}

function internalsOf(text: TextRenderable): Internals | undefined {
  const candidate = text as unknown as Partial<Internals>
  const buffer = candidate.textBuffer
  const style = candidate._textBufferSyntaxStyle
  if (buffer === undefined || style === undefined) return undefined
  if (typeof buffer.setText !== "function" || typeof buffer.addHighlight !== "function" || typeof buffer.clearAllHighlights !== "function") return undefined
  if (typeof buffer.clearLineHighlights !== "function") return undefined
  if (typeof style.registerStyle !== "function" || typeof candidate.updateTextInfo !== "function") return undefined
  return candidate as Internals
}

export function paneTextBuffer(text: TextRenderable): PaneTextBuffer | undefined {
  const internals = internalsOf(text)
  if (internals === undefined) return undefined
  internals._hasManualStyledText = true
  return {
    setText(value: string): void {
      // No reclaim step: OpenTUI 0.5.13's "native: release replaced text buffer ropes" (#1544)
      // frees what a write replaces. Before it, 0.5.11 leaked the previous rope per write — native
      // RSS climbed with a flat JS heap (anomalyco/opentui#1493) — and this called the buffer's
      // native `reset()` first to reclaim the arena. Re-measured on 0.5.14: 5000 rewrites of a
      // 2000-line buffer retain ~1 MB, so the write alone stays bounded.
      internals.textBuffer.setText(value)
      internals.updateTextInfo()
    },
    addHighlight(row: number, highlight: PaneHighlight): void {
      internals.textBuffer.addHighlight(row, highlight)
    },
    clearRow(row: number): void {
      internals.textBuffer.clearLineHighlights(row)
    },
    clearAllHighlights(): void {
      internals.textBuffer.clearAllHighlights()
    },
    registerStyle(name: string, definition: PaneStyleDefinition): number {
      return internals._textBufferSyntaxStyle.registerStyle(name, definition)
    },
    refresh(): void {
      internals.updateTextInfo()
    }
  }
}

/**
 * Registers a callback OpenTUI runs at the top of every render pass, chaining onto whatever was
 * registered before it.
 *
 * Every scroll path — keys, wheel, scrollbar drag, reveal, resize — ends in a render, so this is the
 * single hook a viewport-following painter cannot be bypassed by. `onLifecyclePass` is public
 * (`Renderable.d.ts`), so this needs no cast.
 */
export function onPaneLifecyclePass(text: TextRenderable, callback: () => void): void {
  const previous = text.onLifecyclePass
  text.onLifecyclePass = () => {
    previous?.call(text)
    callback()
  }
}
