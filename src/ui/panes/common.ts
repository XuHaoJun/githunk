import { BoxRenderable, TextRenderable, type CliRenderer, type StyledText } from "@opentui/core"
import type { FocusId } from "../focus"

export type PaneHandle = {
  readonly id: FocusId
  readonly box: BoxRenderable
  readonly text: TextRenderable
  update(content: string | StyledText): void
  setFocused(focused: boolean): void
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
  return {
    id,
    box,
    text,
    update(nextContent: string | StyledText) {
      text.content = nextContent
    },
    setFocused(focused: boolean) {
      box.borderColor = focused ? "#ffffff" : "#555555"
      box.titleColor = focused ? "#ffffff" : "#aaaaaa"
      box.requestRender()
    },
  }
}
