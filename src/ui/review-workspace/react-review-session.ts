import { FinishDialog } from "./finish-dialog"
import type { ReviewWorkspaceController } from "./controller"

type Listener = () => void

function createFinishDialog(controller: ReviewWorkspaceController): FinishDialog {
  return new FinishDialog({
    controller,
    clipboard: {
      isOsc52Supported: () => false,
      copyToClipboardOSC52: () => false,
    },
  })
}

export class ReactReviewSession {
  controller: ReviewWorkspaceController
  onClose: () => void
  active = true
  viewportStart = 0
  finishDialog: FinishDialog
  private version = 0
  private readonly listeners = new Set<Listener>()

  constructor(controller: ReviewWorkspaceController, onClose: () => void) {
    this.controller = controller
    this.onClose = onClose
    this.finishDialog = createFinishDialog(controller)
  }

  getSnapshot = (): number => this.version

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  activate(controller: ReviewWorkspaceController, onClose: () => void): void {
    this.controller = controller
    this.onClose = onClose
    this.finishDialog = createFinishDialog(controller)
    this.active = true
    this.version += 1
    this.publish()
  }

  deactivate(): void {
    if (!this.active) return
    this.active = false
    this.finishDialog.close()
    this.version += 1
    this.publish()
  }

  invalidate(): void {
    this.version += 1
    this.publish()
  }

  setViewportStart = (top: number): void => {
    this.viewportStart = top
  }

  private publish(): void {
    for (const listener of this.listeners) {
      try { listener() } catch {}
    }
  }
}
