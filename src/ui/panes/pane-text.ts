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
    /**
     * Drops the buffer's parsed content *and* the allocations behind it: `arena.reset`,
     * `mem_registry.clear`, a fresh rope. See `paneTextBuffer`'s `setText` for why every write
     * needs it. Optional so a future OpenTUI that stops leaking (or renames it) degrades to the
     * write alone rather than throwing.
     */
    reset?(): void
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
      // Reclaim the previous content's native allocations before writing the new ones.
      //
      // OpenTUI 0.5.11's native text buffer never frees what a write replaced. `UnifiedTextBuffer
      // .setTextInternal` (packages/native/src/text-buffer.zig) hands the parsed segments to
      // `UnifiedRope.setSegments` (packages/native/src/rope.zig), which builds a fresh leaf node per
      // segment from the buffer's arena and then overwrites `self.root` — the previous tree is
      // leaked, and the `clear()` that precedes it only assigns `root = empty_leaf`, dropping the
      // pointer without freeing anything. `reset()` is the one path that calls `arena.reset`,
      // clears the memory registry and re-inits the rope, so a write becomes an allocation *into
      // reused capacity* instead of on top of everything ever written.
      //
      // Measured through this wrapper (2000-line buffer, one `setText` per iteration, forced GC,
      // RSS via process.memoryUsage): 4000 writes retained 5283.6 MB with a flat 5.7 MB JS heap;
      // with `reset()` first the same 4000 writes retain 19.3 MB and stop growing (16.4 MB after
      // 500, 17.0 MB after 1000, 18.5 MB after 2000). In the app, 200 files-panel selection moves
      // wrote 1.8 MB of patch text through the main pane and cost 54.4 MB of RSS; the buffer is the
      // leak, not githunk's own retention (the controller and git layers were measured flat).
      //
      // Upstream: anomalyco/opentui#1493 reports the same signature (native RSS climbing with a
      // flat JS heap) against 0.5.11; drop this call once a release frees replaced content itself.
      internals.textBuffer.reset?.()
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
