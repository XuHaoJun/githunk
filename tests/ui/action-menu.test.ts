import { describe, expect, test } from "bun:test"
import { createTestRenderer } from "@opentui/core/testing"
import type { TextRenderable } from "@opentui/core"
import { createActionMenu, renderActionMenuLines, type ActionMenuItem } from "../../src/ui/action-menu"

const noop = (): void => {}

const items: readonly ActionMenuItem[] = [
  { key: "t", label: "Toggle show/hide command log", onPress: noop },
  { key: "f", label: "Focus command log", onPress: noop },
]

/**
 * lazygit's menus list each item's own accelerator beside its label
 * (pkg/gui/extras_panel.go:12-38 builds the command log one). The cursor marker follows githunk's
 * existing list panes rather than gocui's inverse-video selection, which OpenTUI would style
 * differently anyway.
 */
describe("renderActionMenuLines", () => {
  test("renders one line per item with its key", () => {
    expect(renderActionMenuLines(items, 0)).toEqual([
      "> t  Toggle show/hide command log",
      "  f  Focus command log",
    ])
  })

  test("moves the cursor marker to the selected item", () => {
    expect(renderActionMenuLines(items, 1)).toEqual([
      "  t  Toggle show/hide command log",
      "> f  Focus command log",
    ])
  })

  test("pads the key column to the widest key", () => {
    const wide: readonly ActionMenuItem[] = [
      { key: "t", label: "Short", onPress: noop },
      { key: "esc", label: "Long", onPress: noop },
    ]
    expect(renderActionMenuLines(wide, 0)).toEqual([
      "> t    Short",
      "  esc  Long",
    ])
  })

  test("renders nothing for no items", () => {
    expect(renderActionMenuLines([], 0)).toEqual([])
  })

  test("marks no row when the selection is out of range", () => {
    expect(renderActionMenuLines(items, 9)).toEqual([
      "  t  Toggle show/hide command log",
      "  f  Focus command log",
    ])
  })
})

/**
 * `handleKey`'s accelerator/navigation/dismiss behaviour and `openMenu`/`close` state are the half
 * Task 8 (wiring `@` to this component) will actually depend on — a menu whose keys silently did
 * nothing would still pass every `renderActionMenuLines` test above. Built the same way
 * tests/ui/pane-colors.test.ts exercises other renderer-backed handles: a real `createTestRenderer`
 * rather than a mock.
 */
describe("createActionMenu", () => {
  const menuItems = (calls: string[]): readonly ActionMenuItem[] => [
    { key: "t", label: "Toggle show/hide command log", onPress: () => calls.push("t") },
    { key: "f", label: "Focus command log", onPress: () => calls.push("f") },
  ]

  test("starts closed; openMenu opens it and resets the cursor to the first item", async () => {
    const setup = await createTestRenderer({ width: 80, height: 24 })
    try {
      const menu = createActionMenu(setup.renderer)
      expect(menu.isOpen()).toBe(false)
      menu.openMenu("Command log", menuItems([]))
      expect(menu.isOpen()).toBe(true)
      expect(menu.box.title).toBe("Command log")
      const text = menu.box.findDescendantById("action-menu-text") as TextRenderable
      expect(text.plainText).toBe("> t  Toggle show/hide command log\n  f  Focus command log")
    } finally {
      setup.renderer.destroy()
    }
  })

  test("close() hides the menu and clears its items", async () => {
    const setup = await createTestRenderer({ width: 80, height: 24 })
    try {
      const menu = createActionMenu(setup.renderer)
      menu.openMenu("Command log", menuItems([]))
      menu.close()
      expect(menu.isOpen()).toBe(false)
      expect(menu.box.visible).toBe(false)
    } finally {
      setup.renderer.destroy()
    }
  })

  test("handleKey is a no-op while closed", async () => {
    const setup = await createTestRenderer({ width: 80, height: 24 })
    try {
      const menu = createActionMenu(setup.renderer)
      expect(menu.handleKey("t")).toBe(false)
    } finally {
      setup.renderer.destroy()
    }
  })

  test("escape dismisses the menu and consumes the key", async () => {
    const setup = await createTestRenderer({ width: 80, height: 24 })
    try {
      const menu = createActionMenu(setup.renderer)
      menu.openMenu("Command log", menuItems([]))
      expect(menu.handleKey("escape")).toBe(true)
      expect(menu.isOpen()).toBe(false)
    } finally {
      setup.renderer.destroy()
    }
  })

  test("an unmatched key is not consumed and leaves the menu open", async () => {
    const setup = await createTestRenderer({ width: 80, height: 24 })
    try {
      const menu = createActionMenu(setup.renderer)
      menu.openMenu("Command log", menuItems([]))
      expect(menu.handleKey("q")).toBe(false)
      expect(menu.isOpen()).toBe(true)
    } finally {
      setup.renderer.destroy()
    }
  })

  test("j/down moves the cursor forward and wraps", async () => {
    const setup = await createTestRenderer({ width: 80, height: 24 })
    try {
      const menu = createActionMenu(setup.renderer)
      menu.openMenu("Command log", menuItems([]))
      const text = menu.box.findDescendantById("action-menu-text") as TextRenderable
      menu.handleKey("j")
      expect(text.plainText).toBe("  t  Toggle show/hide command log\n> f  Focus command log")
      menu.handleKey("down")
      expect(text.plainText).toBe("> t  Toggle show/hide command log\n  f  Focus command log")
    } finally {
      setup.renderer.destroy()
    }
  })

  test("k/up moves the cursor backward and wraps", async () => {
    const setup = await createTestRenderer({ width: 80, height: 24 })
    try {
      const menu = createActionMenu(setup.renderer)
      menu.openMenu("Command log", menuItems([]))
      const text = menu.box.findDescendantById("action-menu-text") as TextRenderable
      menu.handleKey("k")
      expect(text.plainText).toBe("  t  Toggle show/hide command log\n> f  Focus command log")
      menu.handleKey("up")
      expect(text.plainText).toBe("> t  Toggle show/hide command log\n  f  Focus command log")
    } finally {
      setup.renderer.destroy()
    }
  })

  test("return fires the item under the cursor", async () => {
    const setup = await createTestRenderer({ width: 80, height: 24 })
    try {
      const calls: string[] = []
      const menu = createActionMenu(setup.renderer)
      menu.openMenu("Command log", menuItems(calls))
      menu.handleKey("j")
      expect(menu.handleKey("return")).toBe(true)
      expect(calls).toEqual(["f"])
    } finally {
      setup.renderer.destroy()
    }
  })

  /**
   * The production path: `RootView.handleModalKey` only ever passes `"enter"`, already normalized
   * to githunk's canonical key name before routing here (`root-view.ts:1069-1071`) — `"return"`
   * above exists only for callers that dispatch raw OpenTUI key names. Without this test, the only
   * covered name was the uncovered-in-production one.
   */
  test("enter fires the item under the cursor", async () => {
    const setup = await createTestRenderer({ width: 80, height: 24 })
    try {
      const calls: string[] = []
      const menu = createActionMenu(setup.renderer)
      menu.openMenu("Command log", menuItems(calls))
      menu.handleKey("j")
      expect(menu.handleKey("enter")).toBe(true)
      expect(calls).toEqual(["f"])
    } finally {
      setup.renderer.destroy()
    }
  })

  test("an item's own key fires it wherever the cursor is, closing the menu first", async () => {
    const setup = await createTestRenderer({ width: 80, height: 24 })
    try {
      const calls: string[] = []
      let openWhenPressed: boolean | undefined
      const menu = createActionMenu(setup.renderer)
      // Cursor stays on "t" (index 0); "f" fires anyway because its own key was pressed
      // (lazygit's MenuItem.Keys), and the menu must already be closed, per extras_panel.go:19-29.
      menu.openMenu("Command log", [
        { key: "t", label: "Toggle show/hide command log", onPress: () => calls.push("t") },
        {
          key: "f",
          label: "Focus command log",
          onPress: () => {
            openWhenPressed = menu.isOpen()
            calls.push("f")
          },
        },
      ])
      expect(menu.handleKey("f")).toBe(true)
      expect(calls).toEqual(["f"])
      expect(openWhenPressed).toBe(false)
      expect(menu.isOpen()).toBe(false)
    } finally {
      setup.renderer.destroy()
    }
  })
  test("renders disabled items with their reason and does not invoke them", async () => {
    const setup = await createTestRenderer({ width: 80, height: 24 })
    try {
      const calls: string[] = []
      const menu = createActionMenu(setup.renderer)
      menu.openMenu("Delete branch", [
        { key: "c", label: "Delete local branch", onPress: () => calls.push("local"), disabledReason: "checked out" },
        { key: "r", label: "Delete remote branch", onPress: () => calls.push("remote") },
      ])
      const text = menu.box.findDescendantById("action-menu-text") as TextRenderable
      expect(text.plainText).toContain("Delete local branch (unavailable: checked out)")
      expect(menu.handleKey("enter")).toBe(true)
      expect(calls).toEqual([])
      expect(menu.isOpen()).toBe(true)
    } finally {
      setup.renderer.destroy()
    }
  })

  test("renders an optional prompt above menu items", async () => {
    const setup = await createTestRenderer({ width: 80, height: 24 })
    try {
      const menu = createActionMenu(setup.renderer)
      menu.openMenu("Delete branch", [{ key: "d", label: "Delete", onPress: noop }], "Are you sure?")
      const text = menu.box.findDescendantById("action-menu-text") as TextRenderable
      expect(text.plainText).toBe("Are you sure?\n\n> d  Delete")
    } finally {
      setup.renderer.destroy()
    }
  })


  test("layout() hides the box when the menu is closed", async () => {
    const setup = await createTestRenderer({ width: 80, height: 24 })
    try {
      const menu = createActionMenu(setup.renderer)
      menu.layout({ x0: 0, y0: 0, x1: 79, y1: 23 }, 24)
      expect(menu.box.visible).toBe(false)
    } finally {
      setup.renderer.destroy()
    }
  })

  test("layout() sizes and shows the box within the host when open", async () => {
    const setup = await createTestRenderer({ width: 80, height: 24 })
    try {
      const menu = createActionMenu(setup.renderer)
      // width/height are yoga's *computed* layout, populated only once the box is part of the
      // render tree and a frame has run — root-view.ts:478 attaches the equivalent keybinding menu
      // to `this.root` the same way before its own layout pass.
      setup.renderer.root.add(menu.box)
      menu.openMenu("Command log", menuItems([]))
      const host = { x0: 0, y0: 0, x1: 79, y1: 23 }
      menu.layout(host, 24)
      await setup.renderOnce()
      expect(menu.box.visible).toBe(true)
      expect(menu.box.width).toBeGreaterThan(0)
      expect(menu.box.height).toBeGreaterThan(0)
      expect(menu.box.left).toBeGreaterThanOrEqual(host.x0)
      expect(menu.box.top).toBeGreaterThanOrEqual(host.y0)
    } finally {
      setup.renderer.destroy()
    }
  })
})
