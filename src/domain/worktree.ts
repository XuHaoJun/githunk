/**
 * One entry of `git worktree list`, modelled on lazygit's worktree model
 * (`pkg/commands/models/worktree.go`).
 *
 * The presentation layer (`pkg/gui/presentation/worktrees.go`) renders
 * `[current marker, name, branch or "HEAD detached at <shortHead>", " (main)"]`
 * and paints the whole row red when the path is missing, so everything a row
 * needs is carried here.
 */
export type Worktree = {
  /** Path of the directory holding the user's files. */
  readonly path: string
  /**
   * Path of this worktree's git dir — `<repo>/.git` for the main worktree and
   * `<repo>/.git/worktrees/<name>` for a linked one. Absent when git could not
   * be asked, i.e. when the path is missing.
   */
  readonly gitDir?: string
  /** Shortest unambiguous trailing portion of `path`; see `uniqueWorktreeNames`. */
  readonly name: string
  /**
   * Checked-out branch, if any. A branch counts as checked out when the
   * worktree is on it directly, mid-rebase on it, or mid-bisect on it.
   */
  readonly branch?: string
  /** HEAD hash. Populated even when `branch` is set; displayed when it is not. */
  readonly head?: string
  /** `head` shortened the way lazygit shortens hashes (eight characters). */
  readonly shortHead?: string
  /** False for a linked worktree. */
  readonly isMain: boolean
  /** True for the worktree the runner is pointed at. */
  readonly isCurrent: boolean
  /** True when `path` no longer exists on disk. */
  readonly isPathMissing: boolean
}
