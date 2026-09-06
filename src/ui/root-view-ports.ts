import type { DiffDocument } from "../domain/diff/document"
import type { DiscardFileMode, WorkingTreeScope } from "../domain/review-target"
import type { BranchDeleteRequest } from "../domain/branch"
import type { CommitDetails, CommitSummary } from "../domain/commit"
import type { TagPreview, TagSummary } from "../domain/tag"
import type { RefLogTarget } from "../git/ref-log"
import type { CheckoutRemoteTrackingResult, CreateBranchOptions, RemoteBranchSelection } from "../git/branches"
import type { UiState as PersistedUiState } from "./ui-state-store"

/**
 * Everything the repository view asks the application layer to *do*. Each call changes the
 * repository or the controller's model; the wiring in `src/app/create-app.ts` repaints the view
 * once the call settles. Names keep their historical `on*` prefix so the move out of
 * `RootViewOptions` is a mechanical one; the prefix carries no meaning here.
 */
export type RepositoryCommands = {
  readonly onStageFile: (path: string) => Promise<void>
  readonly onStageFiles: (paths: readonly string[], stage: boolean) => Promise<void>
  readonly onUnstageFile: (path: string) => Promise<void>
  readonly onDiscardFile: (path: string, mode: DiscardFileMode) => Promise<void>
  readonly onDiscardFiles: (paths: readonly string[], mode: DiscardFileMode) => Promise<void>
  readonly onToggleAllFiles: () => Promise<void>
  readonly onScopeChange: (scope: WorkingTreeScope) => Promise<void>
  readonly onOpenBranchReview: () => Promise<void>
  readonly onApplySelection: (document: DiffDocument, indexes: readonly number[], reverse: boolean) => Promise<void>
  readonly onDiscardSelection: (document: DiffDocument, indexes: readonly number[]) => Promise<void>
  readonly onSelectFile: (path: string) => void
  /** Drops the 300-commit bound and reloads the full history; true when a reload happened. */
  readonly onExpandCommits: () => Promise<boolean>
  readonly onMarkFocusedFileReviewed: (path?: string) => Promise<void>
  readonly onCommitMessage: (message: string) => Promise<void>
  readonly onAmendMessage: (message: string) => Promise<void>
  readonly onCreateBranch: (startPoint?: string, branchName?: string, options?: CreateBranchOptions) => Promise<void>
  readonly onCreateBranchWithAutostash: (startPoint?: string, branchName?: string, options?: CreateBranchOptions) => Promise<void>
  readonly onRefresh: () => Promise<void>
  readonly onSwitchLocalBranch: (branch: string) => Promise<void>
  readonly onDeleteBranch: (request: BranchDeleteRequest) => Promise<void>
  readonly onDeleteBranches: (requests: readonly BranchDeleteRequest[]) => Promise<void>
  readonly onDeleteBranchFromWorktree: (path: string, action: "remove" | "detach", request: BranchDeleteRequest, forceWorktree?: boolean) => Promise<void>
  readonly onFetchRemote: (remote: string) => Promise<void>
  readonly onRenameBranch: (branch: string, newName?: string) => Promise<void>
  readonly onFetch: () => Promise<void>
  readonly onPull: () => Promise<void>
  readonly onPush: () => Promise<void>
  readonly onChooseUpstream: (remote: string, branch: string) => Promise<void>
  readonly onCancelUpstream: () => Promise<void>
  readonly onPopStash: (ref: string) => Promise<void>
  readonly onCreateStash: (message: string, includeUntracked: boolean) => Promise<void>
  readonly onApplyStash: (ref: string) => Promise<void>
  readonly onDropStash: (ref: string) => Promise<void>
  readonly onDropStashes: (refs: readonly string[]) => Promise<void>
  readonly onInspectStash: (ref: string) => Promise<void>
  readonly onBrowseRemote: (remote: string) => Promise<void>
  readonly onInspectBranch: (branch: string) => Promise<void>
  readonly onCheckoutRemoteTracking: (selection: RemoteBranchSelection, confirmedMismatch?: boolean) => Promise<CheckoutRemoteTrackingResult | undefined>
  readonly onEditFile: (path: string, line?: number) => Promise<void>
}

/** Read-only lookups the view renders from. None of these change the model. */
export type RepositoryQueries = {
  readonly loadCommitInspection: (oid: string) => Promise<CommitDetails>
  readonly loadBranchCommits: (branch: string) => Promise<readonly CommitSummary[]>
  readonly loadCommitFileInspection: (oid: string, path: string) => Promise<DiffDocument>
  readonly loadTagInspection: (tag: TagSummary) => Promise<TagPreview>
  readonly loadRefLogInspection: (target: RefLogTarget) => Promise<string>
  readonly onCurrentCommitMessage: () => Promise<string>
  readonly onCheckBranchMerged: (branch: string, upstream?: string) => Promise<boolean>
}

/** Hooks the view raises toward the process hosting it. */
export type ViewHost = {
  readonly onQuit: () => void
  readonly onGeometryChange: (state: PersistedUiState) => void
  /**
   * Fired whenever a git operation this view started has settled, however it settled. The single
   * choke point for "githunk just touched the repository": the refs watcher re-seeds its baseline
   * here, so githunk's own commits and checkouts are never mistaken for external ones.
   */
  readonly onMutationSettled: () => void
  readonly onPreviewError: (error: unknown) => void
  readonly isBranchReviewActive: () => boolean
}

export type RootViewPorts = {
  readonly commands: RepositoryCommands
  readonly queries: RepositoryQueries
  readonly host: ViewHost
}
