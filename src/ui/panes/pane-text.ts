import type { ColorInput, TextRenderable } from "@opentui/core"

/**
 * The one place that reaches into OpenTUI's text internals.
 *
 * Assigning `TextRenderable.content` encodes the value as styled chunks, and OpenTUI 0.5.6 does
 * that in time proportional to *chunks times lines* whenever a `SyntaxStyle` is attached — which
 * `TextBufferRenderable` always does. Even a single-chunk string costs ~8 µs per line that way, so
 * a 4 MB command log or patch takes seconds; the buffer's own `setText` takes ~20 ms for the same
 * bytes. Styling then comes from line-indexed highlights, which can be applied to just the rows a
 * viewport shows.
 *
 * These members are `protected` in OpenTUI's typings, so every access goes through `paneTextBuffer`
 * and callers fall back to `content` when a future OpenTUI reshapes them.
 */

export type PaneHighlight = { readonly start: number; readonly end: number; readonly styleId: number }

export type PaneStyleDefinition = { readonly fg?: ColorInput; readonly bold?: boolean; readonly dim?: boolean }

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
  }
}

/**
 * Registers a callback OpenTUI runs at the top of every render pass, chaining onto whatever was
 * registered before it.
 *
 * Every scroll path — keys, wheel, scrollbar drag, reveal, resize — ends in a render, so this is the
 * single hook a viewport-following painter cannot be bypassed by. `onLifecyclePass` is not in
 * OpenTUI's public typings, which is why the cast lives in this file with the rest of them.
 */
export function onPaneLifecyclePass(text: TextRenderable, callback: () => void): void {
  const host = text as unknown as { onLifecyclePass?: (() => void) | null }
  const previous = host.onLifecyclePass
  host.onLifecyclePass = () => {
    previous?.call(text)
    callback()
  }
}
