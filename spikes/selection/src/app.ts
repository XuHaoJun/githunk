import {
  BoxRenderable,
  ScrollBoxRenderable,
  TextRenderable,
  type CliRenderer,
  type MouseEvent,
} from "@opentui/core"
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

  const patchScroll = new ScrollBoxRenderable(renderer, {
    id: "patch-scroll",
    width: layout.rightWidth,
    height: "100%",
    border: true,
    title: "PATCH — drag to select",
    scrollY: true,
    scrollX: false,
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
  root.add(left)
  root.add(splitter)
  root.add(patchScroll)
  renderer.root.add(root)

  const applyLayout = () => {
    left.width = layout.leftWidth
    patchScroll.width = layout.rightWidth
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

  splitter.onMouseDrag = handleSplitterDrag
  renderer.on("resize", handleResize)

  return {
    destroy() {
      splitter.onMouseDrag = undefined
      renderer.off("resize", handleResize)
      root.destroyRecursively()
    },
  }
}
