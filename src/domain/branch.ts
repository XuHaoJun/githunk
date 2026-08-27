export type LocalBranch = {
  readonly name: string
  readonly oid?: string
  readonly upstream?: string
  readonly isCurrent: boolean
  // TODO Task 5: make required once fixtures updated
  readonly committedAt?: string
  // TODO Task 5: make required once fixtures updated
  readonly subject?: string
  /** Raw `%(upstream:track)` — `[ahead 1, behind 2]`, `[gone]`, or empty. */
  readonly upstreamTrack?: string
  /**
   * lazygit's `AheadForPull`/`BehindForPull` (pkg/commands/models/branch.go:17-20): decimal counts
   * against the upstream, or `"?"` when the upstream's ref is not in this repo — which is what
   * distinguishes "up to date" from "we cannot tell". `parseUpstreamInfo`,
   * pkg/commands/git_commands/branch_loader.go:466-481.
   */
  readonly aheadForPull?: string
  readonly behindForPull?: string
  /** lazygit's `UpstreamGone`: tracking a remote branch that has been deleted (`[gone]`). */
  readonly upstreamGone?: boolean
  /**
   * `branch.<name>.remote` and `branch.<name>.merge`. lazygit fills `UpstreamRemote`/
   * `UpstreamBranch` from exactly these keys (branch_loader.go:120-127), which is why a branch can
   * be known to track a remote whose ref is absent locally.
   */
  readonly upstreamRemote?: string
  readonly upstreamBranch?: string
}

export type BranchDeleteMode = "local" | "remote" | "local-and-remote"

export type BranchDeleteRequest = {
  readonly mode: BranchDeleteMode
  readonly branch: string
  readonly remote?: string
  readonly remoteBranch?: string
  readonly force: boolean
}

/** Mirrors lazygit's branch-name prompt normalization: literal spaces become separators. */
export function sanitizeBranchName(name: string): string {
  return name.replaceAll(" ", "-")
}

export type RemoteBranch = {
  readonly name: string
  readonly ref: string
  readonly oid?: string
}

export type Remote = {
  readonly name: string
  readonly branches?: readonly RemoteBranch[]
  readonly fetchUrl?: string
  readonly pushUrl?: string
}

export type BranchListing = {
  readonly current?: string
  readonly detached: boolean
  readonly localBranches: readonly LocalBranch[]
  readonly remotes: readonly Remote[]
}

/** Convert a remote name and branch name into the matching local branch name. */
export function trackingLocalName(remote: string, remoteBranch: string): string {
  const normalizedRemote = remote.trim()
  const normalizedBranch = remoteBranch.startsWith(`${normalizedRemote}/`)
    ? remoteBranch.slice(normalizedRemote.length + 1)
    : remoteBranch
  if (normalizedRemote.length === 0) throw new Error("remote name must not be empty")
  if (normalizedBranch.length === 0 || normalizedBranch === "HEAD") {
    throw new Error(`remote branch is not checkoutable: ${remoteBranch}`)
  }
  return normalizedBranch
}
