import type { ConfirmationRequest } from "./confirm-dialog"

export function branchForceDeleteConfirmation(branch: string): ConfirmationRequest {
  return {
    title: "Force delete branch",
    message: `'${branch}' is not fully merged. Are you sure you want to delete it?`,
    confirmLabel: "Force delete",
    cancelLabel: "Cancel",
    confirmKey: "d",
    cancelKey: "escape",
  }
}

export function branchAutostashConfirmation(): ConfirmationRequest {
  return {
    title: "Autostash?",
    message: "You must stash and pop your changes to bring them across. Do this automatically? (enter/esc)",
    confirmLabel: "Autostash",
    cancelLabel: "Cancel",
    confirmKey: "enter",
    cancelKey: "escape",
  }
}

export function worktreeForceRemoveConfirmation(worktree: string): ConfirmationRequest {
  return {
    title: "Remove worktree",
    message: `'${worktree}' contains modified or untracked files, or submodules (or all of these). Are you sure you want to remove it?`,
    confirmLabel: "Remove",
    cancelLabel: "Cancel",
    confirmKey: "enter",
    cancelKey: "escape",
  }
}

export function branchRemoteDeleteConfirmation(branch: string, remote: string): ConfirmationRequest {
  return {
    title: `Delete branch '${branch}'?`,
    message: `Are you sure you want to delete the remote branch '${branch}' from '${remote}'?`,
    confirmLabel: "Delete",
    cancelLabel: "Cancel",
    confirmKey: "d",
    cancelKey: "escape",
  }
}

export function branchLocalAndRemoteDeleteConfirmation(branch: string, remote: string, remoteBranch: string, forceRequired: boolean): ConfirmationRequest {
  return {
    title: "Delete local and remote branch",
    message: `Are you sure you want to delete both '${branch}' from your machine, and '${remoteBranch}' from '${remote}'?${forceRequired ? `\n\n'${branch}' is not fully merged. Are you sure you want to delete it?` : ""}`,
    confirmLabel: "Delete",
    cancelLabel: "Cancel",
    confirmKey: "d",
    cancelKey: "escape",
  }
}
export function branchLocalDeleteRangeConfirmation(branches: readonly string[]): ConfirmationRequest {
  const names = branches.map((branch) => `'${branch}'`).join(", ")
  return {
    title: "Delete local branches",
    message: `Are you sure you want to delete the selected local branches: ${names}?`,
    confirmLabel: "Delete",
    cancelLabel: "Cancel",
    confirmKey: "d",
    cancelKey: "escape",
  }
}

export function branchForceDeleteRangeConfirmation(branches: readonly string[]): ConfirmationRequest {
  const names = branches.map((branch) => `'${branch}'`).join(", ")
  return {
    title: "Force delete branches",
    message: `${names} are not fully merged. Are you sure you want to delete them?`,
    confirmLabel: "Force delete",
    cancelLabel: "Cancel",
    confirmKey: "d",
    cancelKey: "escape",
  }
}

type RemoteBranchDeleteTarget = {
  readonly branch: string
  readonly remote: string
}

export function branchRemoteDeleteRangeConfirmation(
  branches: readonly string[] | readonly RemoteBranchDeleteTarget[],
  remote?: string,
): ConfirmationRequest {
  const names = remote === undefined
    ? branches.map((entry) => typeof entry === "string" ? `'${entry}'` : `'${entry.branch}' from '${entry.remote}'`).join(", ")
    : branches.map((entry) => `'${typeof entry === "string" ? entry : entry.branch}'`).join(", ")
  const source = remote === undefined ? "" : ` from '${remote}'`
  return {
    title: "Delete remote branches",
    message: `Are you sure you want to delete the selected remote branches ${names}${source}?`,
    confirmLabel: "Delete",
    cancelLabel: "Cancel",
    confirmKey: "d",
    cancelKey: "escape",
  }
}

export function branchLocalAndRemoteDeleteRangeConfirmation(
  branches: readonly { readonly branch: string; readonly remote: string; readonly remoteBranch: string }[],
  forceRequired: boolean,
): ConfirmationRequest {
  const names = branches.map(({ branch, remote, remoteBranch }) => `'${branch}' and '${remoteBranch}' from '${remote}'`).join(", ")
  return {
    title: "Delete local and remote branches",
    message: `Are you sure you want to delete both ${names}?${forceRequired ? "\n\nAt least one selected branch is not fully merged. Are you sure you want to delete it?" : ""}`,
    confirmLabel: "Delete",
    cancelLabel: "Cancel",
    confirmKey: "d",
    cancelKey: "escape",
  }
}

export function branchRenameConfirmation(): ConfirmationRequest {
  return {
    title: "Rename branch",
    message: "This branch is tracking a remote. This action will only rename the local branch name, not the name of the remote branch. Continue?",
    confirmLabel: "Continue",
    cancelLabel: "Cancel",
    confirmKey: "enter",
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
