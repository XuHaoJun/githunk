import { describe, expect, test } from "bun:test"
import { TextAttributes } from "@opentui/core"
import { buildPaneTabsStrip, paneTabAtOffset, paneTabsPlainTitle, paneTabsTitlePrefix } from "../../src/ui/pane-tabs"

const BRANCHES = { jumpKey: "3", tabs: ["Local Branches", "Remotes", "Tags"] as const }

describe("pane tab strip", () => {
  test("prefix is the jump key plus the horizontal frame rune", () => {
    expect(paneTabsTitlePrefix("3")).toBe("[3]─")
    expect(paneTabsTitlePrefix("")).toBe("")
  })

  test("plain title joins tabs with lazygit's ' - ' separator", () => {
    expect(paneTabsPlainTitle(BRANCHES)).toBe("[3]─Local Branches - Remotes - Tags")
  })

  test("focused strip paints the prefix and the active tab green and bold", () => {
    const strip = buildPaneTabsStrip({ ...BRANCHES, activeIndex: 0, focused: true })
    expect(strip.chunks.map((c) => c.text).join("")).toBe("[3]─Local Branches - Remotes - Tags")
    // drawTitle draws the prefix with the focused view's fgColor — gui.go:1712-1723.
    const prefix = strip.chunks.find((c) => c.text === "[3]─")!
    expect(prefix.fg!.slot).toBe(2)
    expect((prefix.attributes ?? 0) & TextAttributes.BOLD).toBe(TextAttributes.BOLD)
    const active = strip.chunks.find((c) => c.text === "Local Branches")!
    expect(active.fg!.intent).toBe("indexed")
    expect(active.fg!.slot).toBe(2)
    expect((active.attributes ?? 0) & TextAttributes.BOLD).toBe(TextAttributes.BOLD)
    for (const text of ["Remotes", "Tags", " - "]) {
      const chunk = strip.chunks.find((c) => c.text === text)!
      expect(chunk.fg).toBeUndefined()
      expect((chunk.attributes ?? 0) & TextAttributes.BOLD).toBe(0)
    }
  })

  test("a filtering focused pane paints the prefix in the searching border cyan", () => {
    const strip = buildPaneTabsStrip({ ...BRANCHES, activeIndex: 0, focused: true, searching: true })
    const prefix = strip.chunks.find((c) => c.text === "[3]─")!
    expect(prefix.fg!.intent).toBe("indexed")
    expect(prefix.fg!.slot).toBe(6)
    // The tab keeps the view's own SelFgColor: ActiveBorderColor, never the searching colour.
    expect(strip.chunks.find((c) => c.text === "Local Branches")!.fg!.slot).toBe(2)
  })

  test("the active tab follows activeIndex", () => {
    const strip = buildPaneTabsStrip({ ...BRANCHES, activeIndex: 2, focused: true })
    expect(strip.chunks.find((c) => c.text === "Tags")!.fg).toBeDefined()
    expect(strip.chunks.find((c) => c.text === "Local Branches")!.fg).toBeUndefined()
  })

  test("an unfocused pane keeps the active tab green without bold", () => {
    // drawTitle colours the selected tab from the view's own SelFgColor for every view, clearing
    // AttrBold when the view is not current (gui.go:1522-1526); the prefix takes g.FgColor.
    const strip = buildPaneTabsStrip({ ...BRANCHES, activeIndex: 0, focused: false })
    const prefix = strip.chunks.find((c) => c.text === "[3]─")!
    expect(prefix.fg).toBeUndefined()
    const active = strip.chunks.find((c) => c.text === "Local Branches")!
    expect(active.fg!.intent).toBe("indexed")
    expect(active.fg!.slot).toBe(2)
    expect(strip.chunks.every((c) => ((c.attributes ?? 0) & TextAttributes.BOLD) === 0)).toBe(true)
    for (const text of ["Remotes", "Tags", " - "]) expect(strip.chunks.find((c) => c.text === text)!.fg).toBeUndefined()
  })

  test("hit test maps an x offset from the pane's left edge to a tab index", () => {
    // "[3]─" occupies offsets 2..5, so "Local Branches" starts at 6 and ends at 19.
    expect(paneTabAtOffset(BRANCHES, 6)).toBe(0)
    expect(paneTabAtOffset(BRANCHES, 19)).toBe(0)
    // " - " occupies 20..22 — a separator click selects nothing.
    expect(paneTabAtOffset(BRANCHES, 20)).toBeUndefined()
    expect(paneTabAtOffset(BRANCHES, 22)).toBeUndefined()
    expect(paneTabAtOffset(BRANCHES, 23)).toBe(1)
    expect(paneTabAtOffset(BRANCHES, 29)).toBe(1)
    expect(paneTabAtOffset(BRANCHES, 30)).toBeUndefined()
    expect(paneTabAtOffset(BRANCHES, 33)).toBe(2)
    expect(paneTabAtOffset(BRANCHES, 36)).toBe(2)
  })

  test("hit test rejects the prefix and anything past the last tab", () => {
    for (const offset of [-1, 0, 2, 5]) expect(paneTabAtOffset(BRANCHES, offset)).toBeUndefined()
    expect(paneTabAtOffset(BRANCHES, 37)).toBeUndefined()
    expect(paneTabAtOffset(BRANCHES, 200)).toBeUndefined()
  })

  test("a single-tab pane always reports tab 0 and an empty one reports nothing", () => {
    // Mirrors GetClickedTabIndex's `len(v.Tabs) <= 1 -> 0` shortcut.
    expect(paneTabAtOffset({ jumpKey: "4", tabs: ["Commits"] }, 0)).toBe(0)
    expect(paneTabAtOffset({ jumpKey: "4", tabs: [] }, 6)).toBeUndefined()
  })
})
