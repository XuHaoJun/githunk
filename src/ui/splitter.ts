import { BoxRenderable, TextRenderable, type CliRenderer } from "@opentui/core"

const IDLE_COLOR = "#555555"
const HOVER_COLOR = "#ffffff"
const VERTICAL_RULE = "│"
const HORIZONTAL_RULE = "─"
const VERTICAL_GRAB = "⇔"
const HORIZONTAL_GRAB = "⇕"

export type SplitterAxis = "vertical" | "horizontal"

/**
 * A rule in the frame colour rather than a filled block: a solid block reads as
 * a scrollbar. The grab glyph appears only on hover, which is what tells the
 * user the rule can be dragged.
 */
export function splitterGlyphs(axis: SplitterAxis, width: number, height: number, hovered: boolean): string {
  if (axis === "vertical") {
    if (height <= 0 || width <= 0) return ""
    const midpoint = Math.floor(height / 2)
    return Array.from({ length: height }, (_value, row) =>
      hovered && row === midpoint ? VERTICAL_GRAB : VERTICAL_RULE).join("\n")
  }
  if (width <= 0 || height <= 0) return ""
  const midpoint = Math.floor(width / 2)
  return Array.from({ length: width }, (_value, column) =>
    hovered && column === midpoint ? HORIZONTAL_GRAB : HORIZONTAL_RULE).join("")
}

export type SplitterHandle = {
  readonly box: BoxRenderable
  setHovered(hovered: boolean): void
  render(width: number, height: number): void
}

export function createSplitter(renderer: CliRenderer, axis: SplitterAxis, id: string): SplitterHandle {
  const box = new BoxRenderable(renderer, {
    id,
    position: "absolute",
    width: axis === "vertical" ? 1 : "100%",
    height: axis === "vertical" ? "100%" : 1,
  })
  const text = new TextRenderable(renderer, {
    id: `${id}-glyphs`,
    content: "",
    selectable: false,
    wrapMode: "none",
    width: "100%",
    height: "100%",
    fg: IDLE_COLOR,
  })
  box.add(text)
  // A drag must never begin a text selection, and a selection must never drag.
  box.selectable = false
  text.selectable = false

  let hovered = false
  let lastWidth = 1
  let lastHeight = 1

  return {
    box,
    setHovered(next: boolean) {
      if (next === hovered) return
      hovered = next
      text.fg = hovered ? HOVER_COLOR : IDLE_COLOR
      text.content = splitterGlyphs(axis, lastWidth, lastHeight, hovered)
      box.requestRender()
    },
    render(width: number, height: number) {
      lastWidth = width
      lastHeight = height
      text.content = splitterGlyphs(axis, width, height, hovered)
    },
  }
}
