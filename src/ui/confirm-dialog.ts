export type ConfirmationRequest = {
  readonly title: string
  readonly message: string
  readonly confirmLabel: string
  readonly cancelLabel: string
  readonly confirmKey: string
  readonly cancelKey: string
}

export function discardConfirmation(path: string, untracked = false): ConfirmationRequest {
  const action = untracked ? "delete the untracked file" : "discard all working-tree changes"
  return {
    title: "Confirm discard",
    message: `Are you sure you want to ${action} in ${path}? This cannot be undone.`,
    confirmLabel: "Discard",
    cancelLabel: "Cancel",
    confirmKey: "d",
    cancelKey: "escape",
  }
}

export const createDiscardConfirmation = discardConfirmation

export function confirmationAccepts(key: string, request: ConfirmationRequest): boolean {
  return key === request.confirmKey
}

export function confirmationCancels(key: string, request: ConfirmationRequest): boolean {
  return key === request.cancelKey
}
