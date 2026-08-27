export type WorkingTreeScope = "all" | "staged" | "unstaged"

export type DiscardFileMode = "all" | "unstaged"

export type ReviewTarget =
  | { readonly kind: "working-tree"; readonly scope: WorkingTreeScope }
  | { readonly kind: "commit"; readonly oid: string }
  | { readonly kind: "stash"; readonly ref: string }

export type ChangedFile = {
  readonly path: string
  readonly previousPath?: string
  readonly indexStatus: string
  readonly worktreeStatus: string
  readonly untracked: boolean
  readonly conflicted: boolean
  readonly additions: number
  readonly deletions: number
}
