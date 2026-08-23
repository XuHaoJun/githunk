import {
  BoxRenderable,
  type CliRenderer,
  type KeyEvent,
  type MouseEvent,
} from "@opentui/core"
import type { AppModel } from "../app/model"
import {
  computeLayout,
  resizeCommandLog,
  resizeLeftPane,
  type LayoutGeometry,
} from "./layout"
import { FocusManager, FOCUS_IDS, type FocusId } from "./focus"
import { createBranchesPane, updateBranchesPane } from "./panes/branches-pane"
import { createCommitsPane, updateCommitsPane } from "./panes/commits-pane"
import { createCommandLogPane, type CommandLogPaneHandle } from "./panes/command-log-pane"
import { createFilesPane, updateFilesPane } from "./panes/files-pane"
import { createMainPane, updateMainPane } from "./panes/main-pane"
import { createStashPane, updateStashPane } from "./panes/stash-pane"
import { createStatusPane, updateStatusPane } from "./panes/status-pane"
import type { PaneHandle } from "./panes/common"

export type RootViewOptions = {
  readonly leftWidth?: number
  readonly logHeight?: number
  readonly logVisible?: boolean
}

function stackedHeights(total: number, count: number): number[] {
  const base = Math.floor(total / count)
  const remainder = total % count
  return Array.from({ length: count }, (_, index) => base + (index < remainder ? 1 : 0))
}

export class RootView {
  readonly renderer: CliRenderer
  readonly root: BoxRenderable
  readonly focusManager = new FocusManager()
  geometry: LayoutGeometry

  private model: AppModel
  private readonly panes: Record<Exclude<FocusId, "command-log">, PaneHandle>
  private readonly commandLog: CommandLogPaneHandle
  private readonly verticalSplitter: BoxRenderable
  private readonly horizontalSplitter: BoxRenderable
  private readonly handleResize: () => void
  private readonly handleKey: (key: KeyEvent) => void
  private destroyed = false

  constructor(renderer: CliRenderer, model: AppModel, options: RootViewOptions = {}) {
    this.renderer = renderer
    this.model = model
    this.geometry = computeLayout(
      { width: renderer.terminalWidth, height: renderer.terminalHeight },
      {
        ...options,
        logVisible: options.logVisible ?? false,
      },
    )
    this.root = new BoxRenderable(renderer, {
      id: "githunk-root",
      width: "100%",
      height: "100%",
      position: "relative",
      overflow: "hidden",
    })

    this.panes = {
      main: createMainPane(renderer, model),
      status: createStatusPane(renderer, model),
      files: createFilesPane(renderer, model),
      branches: createBranchesPane(renderer, model),
      commits: createCommitsPane(renderer, model),
      stash: createStashPane(renderer, model),
    }
    this.commandLog = createCommandLogPane(renderer, model.commandLog)
    this.verticalSplitter = new BoxRenderable(renderer, {
      id: "vertical-splitter",
      position: "absolute",
      width: 1,
      height: "100%",
      backgroundColor: "#333333",
    })
    this.verticalSplitter.selectable = false
    this.horizontalSplitter = new BoxRenderable(renderer, {
      id: "horizontal-splitter",
      position: "absolute",
      width: "100%",
      height: 1,
      backgroundColor: "#333333",
    })
    for (const id of FOCUS_IDS) this.root.add(this.panes[id].box)
    this.root.add(this.commandLog.box)
    this.root.add(this.verticalSplitter)
    this.root.add(this.horizontalSplitter)
    renderer.root.add(this.root)

    this.focusManager.onChange = (focus, logVisible) => {
      this.applyFocus(focus)
      this.geometry = computeLayout(
        { width: renderer.terminalWidth, height: renderer.terminalHeight },
        {
          leftWidth: this.geometry.leftWidth,
          logHeight: this.geometry.logHeight,
          logVisible,
        },
      )
      this.applyLayout()
    }
    this.handleResize = () => {
      this.geometry = computeLayout(
        { width: renderer.terminalWidth, height: renderer.terminalHeight },
        {
          leftWidth: this.geometry.leftWidth,
          logHeight: this.geometry.logHeight,
          logVisible: this.focusManager.logVisible,
        },
      )
      this.applyLayout()
    }
    this.handleKey = (key: KeyEvent) => {
      if (this.focusManager.handleKey(key.name)) {
        key.preventDefault()
        key.stopPropagation()
      }
    }
    renderer.on("resize", this.handleResize)
    renderer.keyInput.on("keypress", this.handleKey)
    this.installMouseHandlers()
    this.applyFocus(this.focusManager.active)
    this.applyLayout()
  }

  update(model: AppModel): void {
    this.model = model
    updateStatusPane(this.panes.status, model)
    updateFilesPane(this.panes.files, model)
    updateBranchesPane(this.panes.branches, model)
    updateCommitsPane(this.panes.commits, model)
    updateStashPane(this.panes.stash, model)
    updateMainPane(this.panes.main, model, this.geometry.tooSmall)
    this.commandLog.update(model.commandLog)
    this.root.requestRender()
  }

  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    this.verticalSplitter.onMouseDown = undefined
    this.verticalSplitter.onMouseDrag = undefined
    this.horizontalSplitter.onMouseDown = undefined
    this.horizontalSplitter.onMouseDrag = undefined
    this.renderer.off("resize", this.handleResize)
    this.renderer.keyInput.off("keypress", this.handleKey)
    this.root.destroyRecursively()
  }

  private installMouseHandlers(): void {
    this.verticalSplitter.onMouseDown = (event: MouseEvent) => {
      event.preventDefault()
      event.stopPropagation()
    }
    this.verticalSplitter.onMouseDrag = (event: MouseEvent) => {
      event.preventDefault()
      event.stopPropagation()
      this.geometry = resizeLeftPane(this.geometry, event.x)
      this.applyLayout()
    }
    this.horizontalSplitter.onMouseDown = (event: MouseEvent) => {
      event.preventDefault()
      event.stopPropagation()
    }
    this.horizontalSplitter.onMouseDrag = (event: MouseEvent) => {
      event.preventDefault()
      event.stopPropagation()
      this.geometry = resizeCommandLog(this.geometry, event.y)
      this.applyLayout()
    }
    for (const pane of Object.values(this.panes)) {
      pane.box.onMouseDown = (event: MouseEvent) => {
        event.stopPropagation()
        this.focusManager.focus(pane.id)
      }
    }
    this.commandLog.box.onMouseDown = (event: MouseEvent) => {
      event.stopPropagation()
      this.focusManager.focus("command-log")
    }
  }

  private applyFocus(active: FocusId): void {
    for (const pane of Object.values(this.panes)) pane.setFocused(pane.id === active)
    this.commandLog.setFocused(active === "command-log")
  }

  private applyLayout(): void {
    const geometry = this.geometry
    const leftHeights = stackedHeights(geometry.terminalHeight, FOCUS_IDS.length - 1)
    let top = 0
    for (const id of FOCUS_IDS.slice(1)) {
      const pane = this.panes[id]
      const height = leftHeights[top === 0 ? 0 : FOCUS_IDS.indexOf(id) - 1] ?? 0
      pane.box.left = geometry.leftX
      pane.box.top = top
      pane.box.width = Math.max(1, geometry.leftWidth)
      pane.box.height = Math.max(1, height)
      pane.box.visible = geometry.leftWidth > 0 && height > 0
      top += height
    }

    const main = this.panes.main.box
    main.left = geometry.rightX
    main.top = geometry.mainY
    main.width = Math.max(1, geometry.mainWidth)
    main.height = Math.max(1, geometry.mainHeight)
    main.visible = geometry.mainWidth > 0 && geometry.mainHeight > 0
    this.verticalSplitter.left = geometry.verticalSplitterX
    this.verticalSplitter.top = 0
    this.verticalSplitter.width = Math.max(1, geometry.verticalSplitterWidth)
    this.verticalSplitter.height = Math.max(1, geometry.terminalHeight)
    this.verticalSplitter.visible = geometry.verticalSplitterWidth > 0

    this.horizontalSplitter.left = geometry.rightX
    this.horizontalSplitter.top = geometry.horizontalSplitterY
    this.horizontalSplitter.width = Math.max(1, geometry.mainWidth)
    this.horizontalSplitter.height = Math.max(1, geometry.horizontalSplitterHeight)
    this.horizontalSplitter.visible = geometry.logVisible && geometry.horizontalSplitterHeight > 0 && geometry.mainWidth > 0

    this.commandLog.box.left = geometry.rightX
    this.commandLog.box.top = geometry.logY
    this.commandLog.box.width = Math.max(1, geometry.mainWidth)
    this.commandLog.box.height = Math.max(1, geometry.logHeight)
    this.commandLog.box.visible = geometry.logVisible && geometry.logHeight > 0 && geometry.mainWidth > 0
    updateMainPane(this.panes.main, this.model, geometry.tooSmall)
    this.root.requestRender()
  }
}
