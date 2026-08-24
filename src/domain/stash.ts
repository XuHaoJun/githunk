export type StashEntry = {
  readonly ref: string
  readonly message: string
  readonly oid: string
}

export type StashPatch = {
  readonly stash: StashEntry
  readonly patch: string
}

export type StashCreateOptions = {
  /** Explicitly choose whether untracked files are included. */
  readonly includeUntracked: boolean
}

export type StashDropOptions = {
  readonly confirmed: boolean
}
