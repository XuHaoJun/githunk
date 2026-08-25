export type LocalBranch = {
  readonly name: string
  readonly oid?: string
  readonly upstream?: string
  readonly isCurrent: boolean
  readonly committedAt?: string
  readonly subject?: string
  readonly upstreamTrack?: string
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
