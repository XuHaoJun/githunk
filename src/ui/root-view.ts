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
import { createMainPane, changeLineIndexes, getMainCursorTarget, getMainDocument, mainActionAvailability, moveMainCursor, setMainCursorTarget, updateMainPane } from "./panes/main-pane"
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
  readonly onDiscardFile?: (path: string, untracked: boolean) => Promise<void>
  readonly onToggleAllFiles?: () => Promise<void>
  readonly onScopeChange?: (scope: "staged" | "unstaged") => Promise<void>
  readonly onModeChange?: (mode: "working-tree" | "branch") => Promise<void>
  readonly onChooseBase?: (baseRef: string) => Promise<void>
  readonly onApplySelection?: (document: DiffDocument, indexes: readonly number[], reverse: boolean) => Promise<void>
  readonly onDiscardSelection?: (document: DiffDocument, indexes: readonly number[]) => Promise<void>
  readonly onSelectFile?: (path: string) => void
  readonly onMarkFocusedFileReviewed?: (path?: string) => Promise<void>
  readonly onRefresh?: () => Promise<void>
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
  private readonly onDiscardFile: ((path: string, untracked: boolean) => Promise<void>) | undefined
  private readonly onToggleAllFiles: (() => Promise<void>) | undefined
  private readonly onScopeChange: ((scope: "staged" | "unstaged") => Promise<void>) | undefined
  private readonly onModeChange: ((mode: "working-tree" | "branch") => Promise<void>) | undefined
  private readonly onChooseBase: ((baseRef: string) => Promise<void>) | undefined
  private readonly onApplySelection: ((document: DiffDocument, indexes: readonly number[], reverse: boolean) => Promise<void>) | undefined
  private readonly onDiscardSelection: ((document: DiffDocument, indexes: readonly number[]) => Promise<void>) | undefined
  private basePickerIndex = 0
  private readonly onSelectFile: ((path: string) => void) | undefined
  private readonly onMarkFocusedFileReviewed: ((path?: string) => Promise<void>) | undefined
  private readonly onRefresh: (() => Promise<void>) | undefined
  private fileCursorIndex = 0
  private copyMenuOpen = false
  private discardPending = false
  private pendingFileDiscard: { readonly path: string; readonly untracked: boolean } | undefined
  private mutationInFlight = false
  private readonly handleResize: () => void
  private readonly handleKey: (key: KeyEvent) => void
  private destroyed = false

  constructor(renderer: CliRenderer, model: AppModel, options: RootViewOptions = {}) {
    const clipboardPort: ClipboardPort = {
      isOsc52Supported: () => renderer.isOsc52Supported(),
      copyToClipboardOSC52: (text) => renderer.copyToClipboardOSC52(text),
    }
    this.clipboard = new ClipboardService(clipboardPort)
    this.onModeChange = options.onModeChange
    this.onChooseBase = options.onChooseBase
    this.onStageFile = options.onStageFile
    this.onUnstageFile = options.onUnstageFile
    this.onDiscardFile = options.onDiscardFile
    this.onToggleAllFiles = options.onToggleAllFiles
    this.onScopeChange = options.onScopeChange
    this.onApplySelection = options.onApplySelection
    this.onDiscardSelection = options.onDiscardSelection
    this.onSelectFile = options.onSelectFile
    this.onMarkFocusedFileReviewed = options.onMarkFocusedFileReviewed
    this.onRefresh = options.onRefresh
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
      this.discardPending = false
      this.pendingFileDiscard = undefined
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
    const pickerCount = model.basePicker?.candidates.length ?? 0
    this.basePickerIndex = pickerCount === 0 ? 0 : Math.min(this.basePickerIndex, pickerCount - 1)
    if (model.basePicker === undefined) this.basePickerIndex = 0
    updateStatusPane(this.panes.status, model)
    const focusedIndex = model.focusId === undefined ? -1 : model.files.findIndex((file) => file.path === model.focusId)
    this.fileCursorIndex = focusedIndex >= 0
      ? focusedIndex
      : model.files.length === 0 ? 0 : Math.min(this.fileCursorIndex, model.files.length - 1)
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
    if ((key.name === "R" || (key.name === "r" && key.shift)) && this.onRefresh !== undefined) {
      this.runUiMutation(this.onRefresh())
      return true
    }
    if (this.model.basePicker !== undefined && this.onChooseBase !== undefined) {
      if (this.mutationInFlight) return true
      const count = this.model.basePicker.candidates.length
      const numericIndex = Number(key.name) - 1
      if (Number.isInteger(numericIndex) && numericIndex >= 0 && numericIndex < count) {
        this.runUiMutation(this.onChooseBase(this.model.basePicker.candidates[numericIndex]!))
        return true
      }
      if (count > 0 && (key.name === "j" || key.name === "down" || key.name === "k" || key.name === "up")) {
        this.basePickerIndex = Math.max(0, Math.min(count - 1, this.basePickerIndex + (key.name === "j" || key.name === "down" ? 1 : -1)))
        this.panes.status.box.bottomTitle = `${this.basePickerIndex + 1}/${count}: ${this.model.basePicker.candidates[this.basePickerIndex]} — Enter to choose`
        return true
      }
      if (count > 0 && key.name === "enter") {
        this.runUiMutation(this.onChooseBase(this.model.basePicker.candidates[this.basePickerIndex]!))
        return true
      }
    }
    if (!key.ctrl && !key.meta && key.name === "b" && this.onModeChange !== undefined) {
      if (this.mutationInFlight) return true
      this.runUiMutation(this.onModeChange("branch"))
      return true
    }
    if (!key.ctrl && !key.meta && key.name === "w" && this.onModeChange !== undefined) {
      if (this.mutationInFlight) return true
      this.runUiMutation(this.onModeChange("working-tree"))
      return true
    }
    if (this.mutationInFlight && ["space", "d", "tab", "a"].includes(key.name)) {
      this.panes.main.box.bottomTitle = "Mutation in progress; wait for refresh"
      return true
    }
    if (this.model.reviewTarget.kind === "branch" && ["space", "d", "a"].includes(key.name)) {
      this.panes.main.box.bottomTitle = "Branch Review is read-only"
      return true
    }
    if (this.focusManager.active === "files") {
      if (key.name === "j" || key.name === "down" || key.name === "k" || key.name === "up") {
        this.pendingFileDiscard = undefined
        this.discardPending = false
        this.fileCursorIndex = Math.max(0, Math.min(this.model.files.length - 1, this.fileCursorIndex + (key.name === "j" || key.name === "down" ? 1 : -1)))
        const selected = this.model.files[this.fileCursorIndex]
        this.panes.files.box.bottomTitle = selected?.path ?? "No files"
        if (selected !== undefined) this.onSelectFile?.(selected.path)
        return true
      }
      if (key.name === "enter") {
        const selected = this.model.files[this.fileCursorIndex]
        if (selected !== undefined) this.onSelectFile?.(selected.path)
        this.focusManager.focus("main")
        return true
      }
      const file = this.model.files[this.fileCursorIndex]
      if (key.name === "r" && this.onMarkFocusedFileReviewed !== undefined) {
        const focusedPath = this.model.focusId ?? this.model.selectionId
        const reviewPath = focusedPath !== undefined && this.model.files.some((candidate) => candidate.path === focusedPath)
          ? focusedPath
          : file?.path
        this.runUiMutation(this.onMarkFocusedFileReviewed(reviewPath))
        return true
      }
      if (key.name === "a" && this.onToggleAllFiles !== undefined) {
        this.runUiMutation(this.onToggleAllFiles())
        return true
      }
      if (file !== undefined && key.name === "space") {
        const staged = !file.untracked && file.worktreeStatus === "." && file.indexStatus !== "."
        const operation = staged ? this.onUnstageFile : this.onStageFile
        if (operation !== undefined) this.runUiMutation(operation(file.path))
        return operation !== undefined
      }
      if (file !== undefined && key.name === "d" && this.onDiscardFile !== undefined) {
        if (!file.untracked && file.worktreeStatus === "." && file.indexStatus !== ".") {
          this.panes.files.box.bottomTitle = "Discard disabled for staged content; unstage with Space"
          return true
        }
        const pending = this.pendingFileDiscard
        if (pending?.path === file.path && pending.untracked === file.untracked) {
          this.pendingFileDiscard = undefined
          this.runUiMutation(this.onDiscardFile(file.path, file.untracked))
        } else {
          this.pendingFileDiscard = { path: file.path, untracked: file.untracked }
          this.panes.files.box.bottomTitle = `${discardConfirmation(file.path, file.untracked).message} Press d again to confirm or Escape to cancel.`
        }
        return true
      }
      if (key.name === "escape" && this.pendingFileDiscard !== undefined) {
        this.pendingFileDiscard = undefined
        this.panes.files.box.bottomTitle = undefined
        return true
      }
      return false
    }
    if (this.model.reviewTarget.kind === "working-tree" && this.model.reviewTarget.scope === "all" && (key.name === "space" || key.name === "d")) {
      this.panes.main.box.bottomTitle = "Line actions disabled in All scope; press Tab to choose staged or unstaged"
      return true
    }
    if (this.focusManager.active !== "main") return false
    if (key.name === "tab" && this.onScopeChange !== undefined) {
      const scope = this.model.reviewTarget.kind === "working-tree" && this.model.reviewTarget.scope === "staged" ? "unstaged" : "staged"
      this.runUiMutation(this.onScopeChange(scope))
      return true
    }
    if (key.name === "space" && this.onApplySelection !== undefined) {
      const selected = this.mainChangeSelection()
      const document = getMainDocument(this.panes.main)
      const target = getMainCursorTarget(this.panes.main)
      const parsedPath = target === undefined || document === undefined ? undefined : document.files[target.fileIndex]?.newPath ?? document.files[target.fileIndex]?.oldPath
      const modelFile = parsedPath === undefined ? undefined : this.model.files.find((file) => file.path === parsedPath)
      const availability = modelFile?.conflicted
        ? { canStageLines: false, canDiscardLines: false, reason: "line actions disabled: conflicted file" }
        : modelFile !== undefined && !modelFile.untracked && modelFile.additions === 0 && modelFile.deletions === 0
          ? { canStageLines: false, canDiscardLines: false, reason: "line actions disabled: binary file" }
          : mainActionAvailability(document, target)
      if (!availability.canStageLines) {
        this.panes.main.box.bottomTitle = availability.reason
      } else if (selected === undefined || selected.indexes.length === 0) {
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
      const document = getMainDocument(this.panes.main)
      const targetFile = target === undefined || document === undefined ? undefined : document.files[target.fileIndex]
      const path = targetFile?.newPath ?? targetFile?.oldPath ?? "selected changes"
      const modelFile = target === undefined ? undefined : this.model.files.find((file) => file.path === path)
      if (modelFile?.untracked && this.onDiscardFile !== undefined) {
        const pending = this.pendingFileDiscard
        if (pending?.path === path && pending.untracked) {
          this.pendingFileDiscard = undefined
          this.runUiMutation(this.onDiscardFile(path, true))
        } else {
          this.pendingFileDiscard = { path, untracked: true }
          this.panes.main.box.bottomTitle = `${discardConfirmation(path, true).message} Press d again to confirm or Escape to cancel.`
        }
        return true
      }
      const availability = modelFile?.conflicted
        ? { canStageLines: false, canDiscardLines: false, reason: "line actions disabled: conflicted file" }
        : modelFile !== undefined && !modelFile.untracked && modelFile.additions === 0 && modelFile.deletions === 0
          ? { canStageLines: false, canDiscardLines: false, reason: "line actions disabled: binary file" }
          : mainActionAvailability(document, target)
      if (!availability.canDiscardLines) {
        this.panes.main.box.bottomTitle = availability.reason
        return true
      }
      
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
    if (this.mutationInFlight) return
    this.mutationInFlight = true
    this.panes.main.box.bottomTitle = "Mutation in progress; refreshing…"
    void operation.catch((error: unknown) => {
      this.panes.main.box.bottomTitle = error instanceof Error ? error.message : String(error)
      this.root.requestRender()
    }).finally(() => {
      this.mutationInFlight = false
      this.discardPending = false
      this.pendingFileDiscard = undefined
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
    this.discardPending = false
    this.pendingFileDiscard = undefined
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
