import { BoxRenderable, StyledText, bold, fg, type OptimizedBuffer, type TextChunk } from "@opentui/core"
import { TAB_ACTIVE_BOLD, TAB_ACTIVE_FG, TAB_SEPARATOR, TITLE_PREFIX_FRAME_RUNE } from "./theme"

/**
 * The tab strip lazygit draws on a pane's top border row — `[3]─Local Branches - Remotes - Tags`,
 * the active tab green+bold while the pane is focused. Ported from pkg/gocui/gui.go `drawTitle`
 * (the renderer), pkg/gocui/view.go `GetClickedTabIndex` (the hit test) and pkg/gui/views.go:214
 * `keyToTitlePrefix` (the `[key]` prefix).
 *
 * Everything except `PaneTabsBoxRenderable` is pure, so panels can unit-test their strip without
 * a renderer.
 */

export type PaneTabsInput = {
  /** The panel's jump label, e.g. `"3"`; an empty string renders no prefix at all. */
  readonly jumpKey: string
  readonly tabs: readonly string[]
  readonly activeIndex: number
  /** `drawTitle` only highlights the active tab while `g.IsFocused()`. */
  readonly focused: boolean
}

/** The subset the hit test needs: the geometry of the strip, not its colours. */
export type PaneTabsGeometry = Pick<PaneTabsInput, "jumpKey" | "tabs">

/** Where the strip starts, relative to the pane's left edge: `x := v.x0 + 2` (gui.go:1440). */
export const PANE_TABS_START_OFFSET = 2

function jumpKeyPrefix(jumpKey: string): string {
  // views.go:214 keyToTitlePrefix — an empty binding means no prefix.
  return jumpKey.length === 0 ? "" : `[${jumpKey}]`
}

/** The rendered prefix: the jump label plus the view's first frame rune (gui.go:1409-1415). */
export function paneTabsTitlePrefix(jumpKey: string): string {
  const prefix = jumpKeyPrefix(jumpKey)
  return prefix.length === 0 ? "" : `${prefix}${TITLE_PREFIX_FRAME_RUNE}`
}

/** The strip as plain text — what `strings.Join(tabs, separator)` produces, prefix included. */
export function paneTabsPlainTitle(input: PaneTabsGeometry): string {
  return `${paneTabsTitlePrefix(input.jumpKey)}${input.tabs.join(TAB_SEPARATOR)}`
}

function plainChunk(text: string): TextChunk {
  return { __isChunk: true as const, text } as unknown as TextChunk
}

/**
 * The strip as a `StyledText`: one chunk per prefix, tab and separator. The active tab carries
 * `SelFgColor` (green+bold) only when the pane is focused; every other chunk is left without an
 * explicit colour so it inherits the pane's title colour, mirroring how `drawTitle` falls back
 * to the view's own fg for the de-highlighted tabs.
 */
export function buildPaneTabsStrip(input: PaneTabsInput): StyledText {
  const chunks: TextChunk[] = []
  const prefix = paneTabsTitlePrefix(input.jumpKey)
  if (prefix.length > 0) chunks.push(plainChunk(prefix))
  for (let i = 0; i < input.tabs.length; i++) {
    if (i > 0) chunks.push(plainChunk(TAB_SEPARATOR))
    const text = input.tabs[i]!
    const active = input.focused && i === input.activeIndex
    if (!active) {
      chunks.push(plainChunk(text))
      continue
    }
    const coloured = fg(TAB_ACTIVE_FG)(text) as unknown as TextChunk
    chunks.push(TAB_ACTIVE_BOLD ? (bold(coloured) as unknown as TextChunk) : coloured)
  }
  return new StyledText(chunks)
}

function visualWidth(text: string): number {
  return [...text].length
}

/**
 * Which tab an x offset (relative to the pane's left edge) landed on, or `undefined` for the
 * prefix, a separator, or past the last tab. Straight port of `View.GetClickedTabIndex`
 * (pkg/gocui/view.go:1885), including its `len(v.Tabs) <= 1 -> 0` shortcut — with the one
 * refinement that a pane with *no* tabs reports nothing rather than tab 0.
 */
export function paneTabAtOffset(input: PaneTabsGeometry, offsetX: number): number | undefined {
  if (input.tabs.length === 0) return undefined
  if (input.tabs.length === 1) return 0
  const prefix = jumpKeyPrefix(input.jumpKey)
  // gocui counts the prefix without its frame rune, then adds one for the rune and one for the
  // leading border column.
  let charX = prefix.length + 1
  if (prefix.length > 0) charX += 1
  if (offsetX <= charX) return undefined
  for (let i = 0; i < input.tabs.length; i++) {
    charX += visualWidth(input.tabs[i]!)
    if (offsetX <= charX) return i
    charX += visualWidth(TAB_SEPARATOR)
    if (offsetX <= charX) return undefined
  }
  return undefined
}

/**
 * A pane box that paints a styled tab strip over its own top border row.
 *
 * A `TextRenderable` child cannot do this: `BoxRenderable.getScissorRect()` insets the child
 * clip rect by the border, so a child at `top: -1` (the border row) is clipped away entirely —
 * only rows *inside* the border are reachable, which is why the scrollbar in `panes/common.ts`
 * sits at `top: 1`. And `BoxRenderable.title` is typed `string`, so it cannot carry per-tab
 * colours. Overriding `renderSelf` and drawing the chunks straight into the frame buffer is the
 * same thing gocui's `drawTitle` does (one `SetRune` per cell on `v.y0`), and it is the only way
 * to get lazygit's colours onto that row. The box's plain-string `title` is kept in sync as the
 * same text, so the strip is legible even before this overdraw runs.
 */
export class PaneTabsBoxRenderable extends BoxRenderable {
  private strip: StyledText | undefined

  /** Replaces the painted strip; `undefined` restores the plain `title` behaviour. */
  setTabStrip(strip: StyledText | undefined): void {
    this.strip = strip
    this.requestRender()
  }

  protected override renderSelf(buffer: OptimizedBuffer): void {
    super.renderSelf(buffer)
    const strip = this.strip
    if (strip === undefined || strip.chunks.length === 0) return
    if (!this.borderSides.top) return
    const baseFg = this._titleColor ?? this._borderColor
    const y = this._screenY
    // gui.go:1447 stops at `x > v.x1-2`, where x1 is the right border column.
    const lastX = this._screenX + this.width - 3
    let x = this._screenX + PANE_TABS_START_OFFSET
    for (const chunk of strip.chunks) {
      if (x > lastX) return
      const chars = [...chunk.text]
      const room = lastX - x + 1
      const text = chars.length > room ? chars.slice(0, room).join("") : chunk.text
      if (text.length === 0) continue
      buffer.drawText(text, x, y, chunk.fg ?? baseFg, chunk.bg, chunk.attributes ?? 0)
      x += visualWidth(text)
    }
  }
}
