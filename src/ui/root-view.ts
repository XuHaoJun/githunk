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
import { createMainPane, changeLineIndexes, getMainCursorTarget, getMainDocument, moveMainCursor, setMainCursorTarget, updateMainPane } from "./panes/main-pane"
import { createStashPane, updateStashPane } from "./panes/stash-pane"
import { createStatusPane, updateStatusPane } from "./panes/status-pane"
import type { PaneHandle } from "./panes/common"
import { copySelection, selectionFromRenderable } from "../domain/diff/selection"
import type { CopyMode, DiffDocument } from "../domain/diff/document"
import { ClipboardService, formatCopyResult, type ClipboardPort } from "./clipboard"
import { discardConfirmation } from "./confirm-dialog"
import { COPY_MENU_ITEMS } from "./copy-menu"
export type RootViewOptions = {
  readonly leftWidth?: number
  readonly logHeight?: number
  readonly logVisible?: boolean
  readonly onStageFile?: (path: string) => Promise<void>
  readonly onUnstageFile?: (path: string) => Promise<void>
  readonly onToggleAllFiles?: () => Promise<void>
  readonly onScopeChange?: (scope: "staged" | "unstaged") => Promise<void>
  readonly onApplySelection?: (document: DiffDocument, indexes: readonly number[], reverse: boolean) => Promise<void>
  readonly onDiscardSelection?: (document: DiffDocument, indexes: readonly number[]) => Promise<void>
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
  private readonly clipboard: ClipboardService
  private readonly verticalSplitter: BoxRenderable
  private readonly horizontalSplitter: BoxRenderable
  private readonly onStageFile: ((path: string) => Promise<void>) | undefined
  private readonly onUnstageFile: ((path: string) => Promise<void>) | undefined
  private readonly onToggleAllFiles: (() => Promise<void>) | undefined
  private readonly onScopeChange: ((scope: "staged" | "unstaged") => Promise<void>) | undefined
  private copyMenuOpen = false
  private readonly onApplySelection: ((document: DiffDocument, indexes: readonly number[], reverse: boolean) => Promise<void>) | undefined
  private readonly onDiscardSelection: ((document: DiffDocument, indexes: readonly number[]) => Promise<void>) | undefined
  private discardPending = false
  private readonly handleResize: () => void
  private readonly handleKey: (key: KeyEvent) => void
  private destroyed = false

  constructor(renderer: CliRenderer, model: AppModel, options: RootViewOptions = {}) {
    const clipboardPort: ClipboardPort = {
      isOsc52Supported: () => renderer.isOsc52Supported(),
      copyToClipboardOSC52: (text) => renderer.copyToClipboardOSC52(text),
    }
    this.clipboard = new ClipboardService(clipboardPort)
    this.onStageFile = options.onStageFile
    this.onUnstageFile = options.onUnstageFile
    this.onToggleAllFiles = options.onToggleAllFiles
    this.onScopeChange = options.onScopeChange
    this.onApplySelection = options.onApplySelection
    this.onDiscardSelection = options.onDiscardSelection
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
      if (this.handleMutationKey(key)) {
        key.preventDefault()
        key.stopPropagation()
        return
      }
      if (this.handleCopyKey(key)) {
        key.preventDefault()
        key.stopPropagation()
        return
      }
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
  private handleCopyKey(key: KeyEvent): boolean {
    if (this.focusManager.active !== "main") return false
    if (this.copyMenuOpen) {
      if (key.name === "escape") {
        this.copyMenuOpen = false
        this.panes.main.box.bottomTitle = undefined
        this.root.requestRender()
        return true
      }
      const index = Number(key.name) - 1
      if (Number.isInteger(index) && index >= 0 && index < COPY_MENU_ITEMS.length) {
        this.copyMenuOpen = false
        this.copyMainMode(COPY_MENU_ITEMS[index]!.mode)
        return true
      }
    }
    if (key.ctrl && key.name === "o") {
      this.copyMainMode("text")
      return true
    }
    if (!key.ctrl && !key.meta && key.name === "y") {
      this.copyMenuOpen = true
      this.panes.main.box.bottomTitle = `Copy: ${COPY_MENU_ITEMS.map((item, index) => `${index + 1} ${item.label}`).join(" | ")}`
      this.root.requestRender()
      return true
    }
    if (!key.ctrl && !key.meta && (key.name === "j" || key.name === "down" || key.name === "k" || key.name === "up")) {
      this.moveMainCursor(key.name === "j" || key.name === "down" ? "next" : "previous")
      return true
    }
    return false
  }

  private handleMutationKey(key: KeyEvent): boolean {
    if (this.focusManager.active === "files") {
      if (key.name === "enter") {
        this.focusManager.focus("main")
        return true
      }
      if (key.name === "a" && this.onToggleAllFiles !== undefined) {
        this.runUiMutation(this.onToggleAllFiles())
        return true
      }
      if (key.name === "space" && this.model.files[0] !== undefined) {
        const file = this.model.files[0]
        const staged = !file.untracked && file.worktreeStatus === "." && file.indexStatus !== "."
        const operation = staged ? this.onUnstageFile : this.onStageFile
        if (operation !== undefined) this.runUiMutation(operation(file.path))
        return operation !== undefined
      }
      return false
    }
    if (this.focusManager.active !== "main") return false
    if (key.name === "tab" && this.onScopeChange !== undefined) {
      const scope = this.model.reviewTarget.kind === "working-tree" && this.model.reviewTarget.scope === "staged" ? "unstaged" : "staged"
      this.runUiMutation(this.onScopeChange(scope))
      return true
    }
    if (key.name === "space" && this.onApplySelection !== undefined) {
      const selected = this.mainChangeSelection()
      if (selected === undefined || selected.indexes.length === 0) {
        this.panes.main.box.bottomTitle = "No changed lines selected"
      } else {
        const reverse = this.model.reviewTarget.kind === "working-tree" && this.model.reviewTarget.scope === "staged"
        this.runUiMutation(this.onApplySelection(selected.document, selected.indexes, reverse))
      }
      return true
    }
    if (key.name === "d" && this.onDiscardSelection !== undefined) {
      if (this.model.reviewTarget.kind === "working-tree" && this.model.reviewTarget.scope === "staged") {
        this.panes.main.box.bottomTitle = "Discard disabled for staged content; unstage with Space"
        return true
      }
      const selected = this.mainChangeSelection()
      const target = getMainCursorTarget(this.panes.main)
      const path = target === undefined ? "selected changes" : this.model.files[target.fileIndex]?.path ?? "selected changes"
      if (selected === undefined || selected.indexes.length === 0) {
        this.panes.main.box.bottomTitle = "No changed lines selected"
      } else if (!this.discardPending) {
        this.discardPending = true
        this.panes.main.box.bottomTitle = `${discardConfirmation(path).message} Press d again to confirm or Escape to cancel.`
      } else {
        this.discardPending = false
        this.runUiMutation(this.onDiscardSelection(selected.document, selected.indexes))
      }
      return true
    }
    if (key.name === "escape" && this.discardPending) {
      this.discardPending = false
      this.panes.main.box.bottomTitle = undefined
      return true
    }
    return false
  }

  private mainChangeSelection(): { readonly document: DiffDocument; readonly indexes: readonly number[] } | undefined {
    const document = getMainDocument(this.panes.main)
    if (!document) return undefined
    const nativeRange = this.panes.main.text.getSelection()
    if (nativeRange) {
      const selection = selectionFromRenderable(document, nativeRange, this.panes.main.text.getSelectedText())
      if (selection.valid && selection.endUtf16 > selection.startUtf16) {
        return { document, indexes: changeLineIndexes(document, selection.startUtf16, selection.endUtf16) }
      }
    }
    const target = getMainCursorTarget(this.panes.main)
    if (!target) return undefined
    const file = document.files[target.fileIndex]
    if (!file) return undefined
    const hunk = target.hunkIndex === undefined ? undefined : file.hunks[target.hunkIndex]
    const lines = hunk?.lines ?? file.lines
    return {
      document,
      indexes: lines.flatMap((line) => {
        const index = document.lines.indexOf(line)
        return index >= 0 && (line.kind === "addition" || line.kind === "deletion") ? [index] : []
      }),
    }
  }

  private runUiMutation(operation: Promise<void>): void {
    void operation.catch((error: unknown) => {
      this.panes.main.box.bottomTitle = error instanceof Error ? error.message : String(error)
      this.root.requestRender()
    })
  }

  private moveMainCursor(direction: "next" | "previous"): void {
    const pane = this.panes.main
    const document = getMainDocument(pane)
    if (!document) {
      pane.box.bottomTitle = "No patch loaded"
      this.root.requestRender()
      return
    }
    const target = moveMainCursor(document, getMainCursorTarget(pane), direction)
    if (!target) {
      pane.box.bottomTitle = "No file target"
      this.root.requestRender()
      return
    }
    setMainCursorTarget(pane, target)
    const location = target.hunkIndex === undefined ? "file" : `hunk ${target.hunkIndex + 1}`
    pane.box.bottomTitle = `Cursor file ${target.fileIndex + 1}, ${location}`
    this.root.requestRender()
  }
  private copyMainMode(mode: CopyMode): void {
    const pane = this.panes.main
    const document = getMainDocument(pane)
    if (!document) {
      pane.box.bottomTitle = "No text selected"
      this.root.requestRender()
      return
    }
    const nativeRange = pane.text.getSelection()
    let selection = nativeRange ? selectionFromRenderable(document, nativeRange, pane.text.getSelectedText()) : undefined
    if (!selection && (mode === "hunk" || mode === "file")) {
      const target = getMainCursorTarget(pane)
      if (target) {
        selection = {
          valid: true,
          startUtf16: 0,
          endUtf16: 0,
          fileIndex: target.fileIndex,
          ...(target.hunkIndex === undefined ? {} : { hunkIndex: target.hunkIndex }),
          active: false,
        }
      }
    }
    const text = copySelection(document, selection, mode)
    if (selection && !selection.valid) {
      pane.box.bottomTitle = `Selection rejected: ${selection.reason ?? "native/display mismatch"}`
      this.root.requestRender()
      return
    }
    pane.box.bottomTitle = formatCopyResult(this.clipboard.copy(text))
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
