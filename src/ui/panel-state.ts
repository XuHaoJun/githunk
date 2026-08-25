import type { ListState } from "./list-view"

export type PanelState<TTab extends string, TChild> = {
  readonly tabs: readonly TTab[]
  readonly activeTab: TTab
  readonly views: Readonly<Record<TTab, ListState>>
  readonly child?: { readonly parentTab: TTab; readonly value: TChild; readonly view: ListState }
}

export function createPanelState<TTab extends string, TChild = never>(
  tabs: readonly TTab[],
  activeTab: TTab,
  views: Readonly<Record<TTab, ListState>>,
): PanelState<TTab, TChild> {
  return {
    tabs: [...tabs],
    activeTab,
    views: { ...views },
  }
}

export function updatePanelView<TTab extends string, TChild>(
  state: PanelState<TTab, TChild>,
  tab: TTab,
  view: ListState,
): PanelState<TTab, TChild> {
  return {
    ...state,
    views: { ...state.views, [tab]: view },
  }
}

export function cyclePanelTab<TTab extends string, TChild>(
  state: PanelState<TTab, TChild>,
  direction: "next" | "previous",
): PanelState<TTab, TChild> {
  // Bracket navigation first leaves transient child if present
  let effectiveState: PanelState<TTab, TChild> = state
  if (state.child !== undefined) {
    const { child: _discarded, ...rest } = state
    effectiveState = rest as PanelState<TTab, TChild>
  }
  const idx = effectiveState.tabs.indexOf(effectiveState.activeTab)
  if (idx === -1) return effectiveState
  const len = effectiveState.tabs.length
  if (len === 0) return effectiveState
  const delta = direction === "next" ? 1 : -1
  const nextIdx = (idx + delta + len) % len
  const nextTab = effectiveState.tabs[nextIdx]!
  return {
    ...effectiveState,
    activeTab: nextTab,
  }
}

export function enterPanelChild<TTab extends string, TChild>(
  state: PanelState<TTab, TChild>,
  child: TChild,
  view: ListState,
): PanelState<TTab, TChild> {
  return {
    ...state,
    child: { parentTab: state.activeTab, value: child, view },
  }
}

export function leavePanelChild<TTab extends string, TChild>(
  state: PanelState<TTab, TChild>,
): PanelState<TTab, TChild> {
  if (state.child === undefined) return state
  const { child: _discarded, ...rest } = state
  return rest as PanelState<TTab, TChild>
}
