import type { StashEntry } from "./stash"
import type { UpstreamRequired } from "../git/sync"
import type { CommandLogLine } from "./command"
import type { CommandLogWriteKind } from "../app/command-log"
import type { CommitSummary } from "./commit"
import type { BranchListing } from "./branch"
import type { PullRequest } from "./pull-request"
import type { TagSummary } from "./tag"
import type { ReflogEntry } from "./reflog"
import type { Worktree } from "./worktree"
import type { SubmoduleConfig } from "./submodule"
import type { ChangedFile, ReviewTarget, WorkingTreeScope } from "./review-target"
import type { ReviewFileState } from "./review-progress"
export type PatchSection = {
  readonly label: "STAGED" | "UNSTAGED" | "BRANCH"
  readonly text: string
}

export type WorkingTreeSnapshot = {
  readonly repositoryRoot: string
  readonly branch: string
  readonly upstream?: string
  readonly reviewTarget: { readonly kind: "working-tree"; readonly scope: WorkingTreeScope }
  readonly files: readonly ChangedFile[]
  readonly patches: readonly PatchSection[]
}
export type AppModel = {
  readonly repositoryRoot: string
  readonly branch: string
  readonly upstream?: string
  readonly branches?: BranchListing
  /**
   * Branch name → its pull request, keyed as `pullRequestsByBranch` keys them. Absent until the
   * background refresh has asked `gh`, and absent for good where `gh` is unavailable — so the
   * branches panel must render identically without it.
   */
  readonly pullRequests?: Readonly<Record<string, PullRequest>>
  readonly tags?: readonly TagSummary[]
  /** `git log -g` for HEAD, backing panel 4's Reflog tab. */
  readonly reflog?: readonly ReflogEntry[]
  /** `git worktree list`, backing panel 2's Worktrees tab. */
  readonly worktrees?: readonly Worktree[]
  /** The `.gitmodules` sections, recursively, backing panel 2's Submodules tab. */
  readonly submodules?: readonly SubmoduleConfig[]
  readonly upstreamChoice?: UpstreamRequired
  readonly stashes?: readonly StashEntry[]
  readonly reviewTarget: ReviewTarget
  /** Aggregate Branch Review identity survives individual commit drill-down. */
  readonly branchReviewTarget?: Extract<ReviewTarget, { readonly kind: "branch" }>
  readonly files: readonly ChangedFile[]
  readonly patches: readonly PatchSection[]
  readonly rawPatchSections: readonly PatchSection[]
  readonly reviewStatuses?: Readonly<Record<string, ReviewFileState>>
  readonly reviewSummary?: {
    readonly reviewed: number
    readonly invalidated: number
    readonly commits: number
    readonly files: number
    readonly additions: number
    readonly deletions: number
  }
  readonly commits?: readonly CommitSummary[]
  readonly selectionId?: string
  readonly focusId?: string
  readonly loading: boolean
  readonly basePicker?: {
    readonly candidates: readonly string[]
    readonly reason: string
  }
  readonly banner?: string
  readonly commandLog: readonly CommandLogLine[]
  /**
   * The autoscroll transition the log's most recent write implies — lazygit assigns
   * `Autoscroll = true` in `LogAction`/`LogCommand` (pkg/gui/command_log_panel.go:38,62) and not in
   * the `prefixWriter` or the header (pkg/gui/extras_panel.go:109-119,
   * command_log_panel.go:70-85), so the pane needs to know which one it just received.
   */
  readonly commandLogWriteKind?: CommandLogWriteKind
  readonly title: string
}
