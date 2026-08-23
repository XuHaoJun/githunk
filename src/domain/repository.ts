import type { CommandRecord } from "./command"
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
  readonly reviewTarget: ReviewTarget
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
  readonly selectionId?: string
  readonly focusId?: string
  readonly loading: boolean
  readonly basePicker?: {
    readonly candidates: readonly string[]
    readonly reason: string
  }
  readonly banner?: string
  readonly commandLog: readonly CommandRecord[]
  readonly title: string
}
