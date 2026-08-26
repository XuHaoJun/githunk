import { BoxRenderable, ScrollBarRenderable, TextRenderable, type CliRenderer, type StyledText } from "@opentui/core"
import type { FocusId } from "../focus"
import { PaneTabsBoxRenderable, buildPaneTabsStrip, paneTabsPlainTitle } from "../pane-tabs"
import { ANSI_GREEN, DEFAULT_FOREGROUND } from "../theme"
/** Static half of a tabbed pane: the panel's jump label and its tab labels. */
export type PaneTabsConfig = {
  readonly jumpKey: string
  readonly tabs: readonly string[]
  /** Which tab is active on first paint; defaults to the first. */
  readonly activeIndex?: number
}

/** Dynamic half, pushed on every tab cycle and focus change. */
export type PaneTabsUpdate = {
  /** Relabels the strip; omit to keep the current labels. */
  readonly tabs?: readonly string[]
  readonly activeIndex: number
  readonly focused: boolean
}

export type CreatePaneOptions = {
  /** Attaches the shared lazygit tab strip to the pane's top border row. */
  readonly tabs?: PaneTabsConfig
}

export type PaneHandle = {
  readonly id: FocusId
  readonly box: BoxRenderable
  readonly text: TextRenderable
  update(content: string | StyledText): void
  setFocused(focused: boolean): void
  /**
   * Repaints the pane's tab strip. Present only on panes created with `options.tabs`, so a
   * pane without tabs cannot silently swallow the call.
   */
  setTabs?(update: PaneTabsUpdate): void
  /**
   * Replaces the strip with a plain dynamic title, undoing the last `setTabs`. lazygit's own
   * drill-down views work this way: commit files is a separate view with a
   * `DynamicTitleBuilder` and no `Tabs` at all (pkg/gui/context/commit_files_context.go:48), so
   * gocui's `drawTitle` renders its bare title and no tab strip. Present only on tabbed panes.
   */
  setPlainTitle?(title: string): void
  /**
   * Re-mirrors the text viewport into the pane's scrollbar. Internal plumbing for scroll
   * paths that mutate `text.scrollY` without a content update (reveal and page scrolls);
   * OpenTUI 0.5.6 emits no scroll-change event, so every mutation must sync explicitly.
   */
  syncScrollbar(): void
  scrollBy(delta: number): void
  scrollTo(position: number): void
  maxScrollY(): number
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

/** Bars by their pane's text renderable; `paneScrollbar` is the test/debug read side. */
const scrollbars = new WeakMap<TextRenderable, ScrollBarRenderable>()

/** The vertical scrollbar attached to a pane's text, if any. Test and debug accessor. */
export function paneScrollbar(text: TextRenderable): ScrollBarRenderable | undefined {
  return scrollbars.get(text)
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
    onChange: (position) => {
      text.scrollY = Math.max(0, Math.min(text.maxScrollY, position))
      syncVerticalScrollbar(bar, text)
      box.requestRender()
    },
  })
  // Yoga lays out asynchronously: reading text.height straight after constructing or
  // resizing is unreliable, but the size-change hooks fire once real dimensions exist.
  // Content growth (which changes scrollHeight without resizing anything) is synced by
  // the pane's update path instead.
  const sync = (): void => syncVerticalScrollbar(bar, text)
  box.onSizeChange = sync
  text.onSizeChange = sync
  // Keep slider's built-in pointer handlers: they drive onChange and thumb/track interaction.
  // Arrow handlers are irrelevant (arrows invisible) and stay disabled.
  bar.startArrow.onMouseDown = undefined
  bar.startArrow.onMouseUp = undefined
  bar.endArrow.onMouseDown = undefined
  bar.endArrow.onMouseUp = undefined
  scrollbars.set(text, bar)
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
  options: CreatePaneOptions = {},
): PaneHandle {
  const tabsConfig = options.tabs
  // Tabbed panes need a box that can overdraw its own border row with per-tab colours; the
  // rest keep the plain BoxRenderable, so nothing about them changes.
  const BoxClass = tabsConfig === undefined ? BoxRenderable : PaneTabsBoxRenderable
  const box = new BoxClass(renderer, {
    id: `${id}-pane`,
    border: true,
    borderColor: DEFAULT_FOREGROUND,
    focusedBorderColor: ANSI_GREEN,
    titleColor: DEFAULT_FOREGROUND,
    title,
    position: "absolute",
    width: "100%",
    height: "100%",
    overflow: "hidden",
  })
  const text = new TextRenderable(renderer, {
    id: `${id}-text`,
    content,
    fg: DEFAULT_FOREGROUND,
    selectable,
    wrapMode: "none",
    width: "100%",
    height: "100%",
  })
  box.add(text)
  const originalTextMouseEvent = (text as unknown as { onMouseEvent?: (event: MouseEvent) => void }).onMouseEvent?.bind(text)
  ;(text as unknown as { onMouseEvent: (event: MouseEvent) => void }).onMouseEvent = (event: MouseEvent) => {
    if ((event as unknown as { type: string }).type === "scroll") {
      event.preventDefault()
      return
    }
    originalTextMouseEvent?.(event)
  }
  const bar = attachVerticalScrollbar(box, text, id)
  let tabState: PaneTabsUpdate | undefined
  const paintTabs = (update: PaneTabsUpdate): void => {
    if (tabsConfig === undefined || !(box instanceof PaneTabsBoxRenderable)) return
    const tabs = update.tabs ?? tabState?.tabs ?? tabsConfig.tabs
    tabState = { ...update, tabs }
    const input = { jumpKey: tabsConfig.jumpKey, tabs, activeIndex: update.activeIndex, focused: update.focused }
    // The plain title carries the same text in lazygit's exact format, so the strip stays
    // readable (just uncoloured) wherever the overdraw does not reach.
    box.title = paneTabsPlainTitle(input)
    box.setTabStrip(buildPaneTabsStrip(input))
    box.requestRender()
  }
  if (tabsConfig !== undefined) {
    paintTabs({ tabs: tabsConfig.tabs, activeIndex: tabsConfig.activeIndex ?? 0, focused: false })
  }
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
      box.borderColor = focused ? ANSI_GREEN : DEFAULT_FOREGROUND
      box.titleColor = focused && tabsConfig === undefined ? ANSI_GREEN : DEFAULT_FOREGROUND
      box.requestRender()
    },
    ...(tabsConfig === undefined ? {} : {
      setTabs(update: PaneTabsUpdate) {
        paintTabs(update)
      },
      setPlainTitle(title: string) {
        if (!(box instanceof PaneTabsBoxRenderable)) return
        // Drop the remembered strip too, so the next setTabs repaints from the config's labels
        // rather than resurrecting whatever was active before the drill-down.
        tabState = undefined
        box.title = title
        box.setTabStrip(undefined)
        box.requestRender()
      },
    }),
    syncScrollbar() {
      syncVerticalScrollbar(bar, text)
    },
    scrollBy(delta: number) {
      text.scrollY = Math.max(0, Math.min(text.maxScrollY, text.scrollY + delta))
      syncVerticalScrollbar(bar, text)
      box.requestRender()
    },
    scrollTo(position: number) {
      text.scrollY = Math.max(0, Math.min(text.maxScrollY, position))
      syncVerticalScrollbar(bar, text)
      box.requestRender()
    },
    maxScrollY() {
      return text.maxScrollY
    },
  }
}
