import { BoxRenderable, ScrollBarRenderable, TextRenderable, type CliRenderer, type StyledText } from "@opentui/core"
import type { FocusId } from "../focus"

export type PaneHandle = {
  readonly id: FocusId
  readonly box: BoxRenderable
  readonly text: TextRenderable
  update(content: string | StyledText): void
  setFocused(focused: boolean): void
}

/**
 * Minimal-movement `scrollY` that brings the line range `[firstVisibleLine, lastVisibleLine]`
 * into a `viewportLines`-tall viewport currently scrolled to `currentScrollY`. A selection
 * already (even partially) on screen keeps the current scroll; one above the viewport scrolls
 * up just far enough to show its last row at the viewport bottom, and one below scrolls down
 * to the same bottom-anchored position. The result is clamped at zero; the upper bound needs
 * no clamping here because every caller assigns through TextRenderable's own clamping
 * `scrollY` setter.
 */
export function scrollYToReveal(
  firstVisibleLine: number,
  lastVisibleLine: number,
  viewportLines: number,
  currentScrollY: number,
): number {
  const viewport = Math.max(1, Math.floor(viewportLines))
  const first = Math.max(0, Math.floor(firstVisibleLine))
  const last = Math.max(first, Math.floor(lastVisibleLine))
  const current = Math.max(0, Math.floor(currentScrollY))
  if (first >= current && first <= current + viewport - 1) return current
  if (last >= current && last <= current + viewport - 1) return current
  return Math.max(0, last - viewport + 1)
}

/**
 * Attaches the shared vertical scrollbar for a bordered pane: one column wide, hugging the
 * right border ring without covering it. The bar auto-hides whenever the content fits
 * (ScrollBarRenderable hides itself while `scrollSize <= viewportSize`), so short panes show
 * nothing. Added after `text`, so it paints above it, scissored by the box's overflow:hidden.
 */
export function attachVerticalScrollbar(box: BoxRenderable, text: TextRenderable, id: string): ScrollBarRenderable {
  const bar = new ScrollBarRenderable(text.ctx, {
    id: `${id}-scrollbar`,
    orientation: "vertical",
    showArrows: false,
    position: "absolute",
    top: 1,
    bottom: 1,
    right: 0,
    width: 1,
  })
  // Yoga lays out asynchronously: reading text.height straight after constructing or
  // resizing is unreliable, but the size-change hooks fire once real dimensions exist.
  // Content growth (which changes scrollHeight without resizing anything) is synced by
  // the pane's update path instead.
  const sync = (): void => syncVerticalScrollbar(bar, text)
  box.onSizeChange = sync
  text.onSizeChange = sync
  box.add(bar)
  return bar
}

/** Mirrors the text viewport's content/window/offset triple into the scrollbar. */
export function syncVerticalScrollbar(bar: ScrollBarRenderable, text: TextRenderable): void {
  bar.scrollSize = text.scrollHeight
  bar.viewportSize = Math.max(0, Math.floor(text.height))
  bar.scrollPosition = text.scrollY
}

export function createPane(
  renderer: CliRenderer,
  id: FocusId,
  title: string,
  content: string,
  selectable = false,
): PaneHandle {
  const box = new BoxRenderable(renderer, {
    id: `${id}-pane`,
    border: true,
    borderColor: "#555555",
    focusedBorderColor: "#ffffff",
    title,
    position: "absolute",
    width: "100%",
    height: "100%",
    overflow: "hidden",
  })
  const text = new TextRenderable(renderer, {
    id: `${id}-text`,
    content,
    selectable,
    wrapMode: "none",
    width: "100%",
    height: "100%",
  })
  box.add(text)
  const bar = attachVerticalScrollbar(box, text, id)
  return {
    id,
    box,
    text,
    update(nextContent: string | StyledText) {
      text.content = nextContent
      // Valid immediately after a content change (no layout involved); the viewport side is
      // kept fresh by the onSizeChange hooks in attachVerticalScrollbar.
      syncVerticalScrollbar(bar, text)
    },
    setFocused(focused: boolean) {
      box.borderColor = focused ? "#ffffff" : "#555555"
      box.titleColor = focused ? "#ffffff" : "#aaaaaa"
      box.requestRender()
    },
  }
}
