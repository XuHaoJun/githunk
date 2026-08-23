import type { CommandRecord } from "./command"
import type { ChangedFile, ReviewTarget, WorkingTreeScope } from "./review-target"

export type PatchSection = {
  readonly label: "STAGED" | "UNSTAGED"
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
  readonly selectionId?: string
  readonly focusId?: string
  readonly loading: boolean
  readonly banner?: string
  readonly commandLog: readonly CommandRecord[]
  readonly title: string
}
