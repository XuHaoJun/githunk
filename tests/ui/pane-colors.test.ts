import { describe, expect, test } from "bun:test"
import { createTestRenderer } from "@opentui/core/testing"
import { createKeybindingMenu } from "../../src/ui/keybinding-menu"
import { createPane } from "../../src/ui/panes/common"

describe("lazygit pane color semantics", () => {
  test("uses terminal defaults when a pane is unfocused", async () => {
    const setup = await createTestRenderer({ width: 80, height: 24 })
    try {
      const pane = createPane(setup.renderer, "files", "Files", "content")
      expect(pane.text.fg.intent).toBe("default")
      expect(pane.box.borderColor.intent).toBe("default")
      expect(pane.box.titleColor?.intent).toBe("default")
    } finally {
      setup.renderer.destroy()
    }
  })

  test("uses lazygit green for focused pane chrome", async () => {
    const setup = await createTestRenderer({ width: 80, height: 24 })
    try {
      const pane = createPane(setup.renderer, "files", "Files", "content")
      pane.setFocused(true)
      expect(pane.box.borderColor.intent).toBe("indexed")
      expect(pane.box.borderColor.slot).toBe(2)
      expect(pane.box.titleColor?.intent).toBe("indexed")
      expect(pane.box.titleColor?.slot).toBe(2)
    } finally {
      setup.renderer.destroy()
    }
  })

  test("uses terminal default background for the keybinding menu", async () => {
    const setup = await createTestRenderer({ width: 80, height: 24 })
    try {
      const menu = createKeybindingMenu(setup.renderer)
      expect(menu.box.backgroundColor.intent).toBe("default")
      expect(menu.box.borderColor.intent).toBe("default")
    } finally {
      setup.renderer.destroy()
    }
  })
})
