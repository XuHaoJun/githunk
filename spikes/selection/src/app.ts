import {
  BoxRenderable,
  ScrollBoxRenderable,
  TextRenderable,
  type CliRenderer,
  type MouseEvent,
  type Selection,
} from "@opentui/core"
import { copySelection } from "./clipboard"
import { LEFT_FIXTURE, PATCH_FIXTURE } from "./fixtures/patch"
import { computePaneLayout, resizeLeftPane } from "./layout"

export function createSelectionSpike(renderer: CliRenderer): { destroy(): void } {
  let layout = computePaneLayout(renderer.terminalWidth, 30)

  const root = new BoxRenderable(renderer, {
    id: "spike-root",
    flexDirection: "row",
    width: "100%",
    height: "100%",
  })

  const left = new BoxRenderable(renderer, {
    id: "left-pane",
    width: layout.leftWidth,
    height: "100%",
    border: true,
    title: "LEFT — must never contaminate PATCH copy",
  })

  const leftText = new TextRenderable(renderer, {
    id: "left-fixture",
    content: LEFT_FIXTURE.join("\n"),
    selectable: false,
    width: "100%",
  })

  const splitter = new BoxRenderable(renderer, {
    id: "vertical-splitter",
    width: 1,
    height: "100%",
  })

  const right = new BoxRenderable(renderer, {
    id: "right-pane",
    flexDirection: "column",
    width: layout.rightWidth,
    height: "100%",
  })

  const patchScroll = new ScrollBoxRenderable(renderer, {
    id: "patch-scroll",
    width: "100%",
    flexGrow: 1,
    border: true,
    title: "PATCH — drag to select",
    scrollY: true,
    scrollX: false,
  })

  const statusText = new TextRenderable(renderer, {
    id: "osc52-status",
    content: "Select patch text to emit OSC52",
    selectable: false,
    wrapMode: "none",
    width: "100%",
    height: 1,
  })

  const patch = new TextRenderable(renderer, {
    id: "patch-text",
    content: PATCH_FIXTURE,
    selectable: true,
    wrapMode: "word",
    width: "100%",
  })

  left.add(leftText)
  patchScroll.add(patch)
  right.add(patchScroll)
  right.add(statusText)
  root.add(left)
  root.add(splitter)
  root.add(right)
  renderer.root.add(root)

  const applyLayout = () => {
    left.width = layout.leftWidth
    right.width = layout.rightWidth
  }

  const handleSplitterDrag = (event: MouseEvent) => {
    layout = resizeLeftPane(
      computePaneLayout(renderer.terminalWidth, layout.leftWidth),
      event.x,
    )
    applyLayout()
  }

  const handleResize = () => {
    layout = computePaneLayout(renderer.terminalWidth, layout.leftWidth)
    applyLayout()
  }

  const handleSelection = (selection: Selection) => {
    const result = copySelection(selection.getSelectedText(), renderer)
    statusText.content =
      result.status === "emitted"
        ? `OSC52 emitted ${result.bytes} bytes — verify local clipboard`
        : result.status === "blocked"
          ? "OSC52 blocked/unsupported in this environment"
          : "No text selected"
  }

  splitter.onMouseDrag = handleSplitterDrag
  renderer.on("resize", handleResize)
  renderer.on("selection", handleSelection)

  return {
    destroy() {
      splitter.onMouseDrag = undefined
      renderer.off("resize", handleResize)
      renderer.off("selection", handleSelection)
      root.destroyRecursively()
    },
  }
}
