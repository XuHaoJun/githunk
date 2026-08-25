import { describe, expect, test } from "bun:test"
import { createPanelState, cyclePanelTab, enterPanelChild, leavePanelChild, updatePanelView } from "../../src/ui/panel-state"
import type { PanelState } from "../../src/ui/panel-state"
import { createListState, selectListRow } from "../../src/ui/list-view"

const panelRows = [
  { id: "a", columns: [{ text: "alpha", priority: 0 }] },
  { id: "b", columns: [{ text: "beta", priority: 0 }] },
] as const

describe("panel state", () => {
  test("cycles tabs with wraparound and preserves per-tab selection and scroll", () => {
    const views = { branches: createListState(panelRows), remotes: createListState(panelRows), tags: createListState(panelRows) }
    let panel = createPanelState(["branches", "remotes", "tags"] as const, "branches", views)
    panel = updatePanelView(panel, "branches", { ...selectListRow(panel.views.branches, "b"), scrollY: 2 })
    panel = cyclePanelTab(panel, "previous")
    expect(panel.activeTab).toBe("tags")
    panel = cyclePanelTab(panel, "next")
    expect(panel.activeTab).toBe("branches")
    expect(panel.views.branches).toMatchObject({ selectedId: "b", scrollY: 2 })
  })

  test("bracket navigation leaves a transient child before changing parent tab", () => {
    let panel: PanelState<"branches" | "remotes" | "tags", { kind: string; remote: string }> = createPanelState(
      ["branches", "remotes", "tags"] as const,
      "remotes",
      { branches: createListState([]), remotes: createListState([]), tags: createListState([]) },
    )
    panel = enterPanelChild(panel, { kind: "remote-branches", remote: "origin" }, createListState([]))
    panel = cyclePanelTab(panel, "next")
    expect(panel.activeTab).toBe("tags")
    expect(panel.child).toBeUndefined()
  })

  test("escape restores the parent tab without changing it", () => {
    let panel: PanelState<"branches" | "remotes" | "tags", { kind: string; remote: string }> = createPanelState(
      ["branches", "remotes", "tags"] as const,
      "remotes",
      { branches: createListState([]), remotes: createListState([]), tags: createListState([]) },
    )
    panel = leavePanelChild(enterPanelChild(panel, { kind: "remote-branches", remote: "origin" }, createListState([])))
    expect(panel.activeTab).toBe("remotes")
  })
})
