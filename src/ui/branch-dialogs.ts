import type { ConfirmationRequest } from "./confirm-dialog"

export function branchDeleteConfirmation(branch: string, force = false): ConfirmationRequest {
  return {
    title: force ? "Confirm force delete branch" : "Confirm delete branch",
    message: force
      ? `Force delete branch ${branch}? This can discard commits and cannot be undone.`
      : `Delete branch ${branch}?`
    ,
    confirmLabel: force ? "Force delete" : "Delete",
    cancelLabel: "Cancel",
    confirmKey: "d",
    cancelKey: "escape",
  }
}

export function remoteTrackingMismatchConfirmation(message: string): ConfirmationRequest {
  return {
    title: "Remote tracking mismatch",
    message: `${message}. Switch without changing its upstream?`,
    confirmLabel: "Switch",
    cancelLabel: "Cancel",
    confirmKey: "enter",
    cancelKey: "escape",
  }
}
