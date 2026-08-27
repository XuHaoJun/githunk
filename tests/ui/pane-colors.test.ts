import { describe, expect, test } from "bun:test"
import { TextRenderable } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import { createHintsBar } from "../../src/ui/hints-bar"
import { createKeybindingMenu } from "../../src/ui/keybinding-menu"
import { createPane } from "../../src/ui/panes/common"
import { createSplitter } from "../../src/ui/splitter"

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
      // Popups are modal and always show the active (green) border, matching
      // lazygit's ActiveBorderColor for the current popup context.
      expect(menu.box.borderColor.intent).toBe("indexed")
      expect(menu.box.borderColor.slot).toBe(2)
    } finally {
      setup.renderer.destroy()
    }
  })
  test("uses lazygit's blue hint color and terminal-default status color", async () => {
    const setup = await createTestRenderer({ width: 80, height: 24 })
    try {
      const hints = createHintsBar(setup.renderer)
      expect(hints.hints.fg.intent).toBe("indexed")
      expect(hints.hints.fg.slot).toBe(4)
      expect(hints.status.fg.intent).toBe("default")
    } finally {
      setup.renderer.destroy()
    }
  })

  test("uses terminal-default splitter rules and lazygit green hover", async () => {
    const setup = await createTestRenderer({ width: 80, height: 24 })
    try {
      const splitter = createSplitter(setup.renderer, "vertical", "splitter")
      const text = splitter.box.findDescendantById("splitter-glyphs") as TextRenderable
      expect(text.fg.intent).toBe("default")
      splitter.setHovered(true)
      expect(text.fg.intent).toBe("indexed")
      expect(text.fg.slot).toBe(2)
    } finally {
      setup.renderer.destroy()
    }
  })
})
