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

function stashConfirmation(title: string, message: string, confirmLabel: string): ConfirmationRequest {
  return {
    title,
    message,
    confirmLabel,
    cancelLabel: "Cancel",
    confirmKey: "enter",
    cancelKey: "escape",
  }
}

export function stashApplyConfirmation(_ref: string): ConfirmationRequest {
  return stashConfirmation("Stash apply", "Are you sure you want to apply this stash entry?", "Apply")
}

export function stashPopConfirmation(_ref: string): ConfirmationRequest {
  return stashConfirmation("Stash pop", "Are you sure you want to pop this stash entry?", "Pop")
}

export function stashDropConfirmation(_ref: string): ConfirmationRequest {
  return stashConfirmation("Stash drop", "Are you sure you want to drop the selected stash entry(ies)?", "Drop")
}

export function confirmationAccepts(key: string, request: ConfirmationRequest): boolean {
  return key === request.confirmKey
}

export function confirmationCancels(key: string, request: ConfirmationRequest): boolean {
  return key === request.cancelKey
}
