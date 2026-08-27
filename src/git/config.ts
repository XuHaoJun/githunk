import type { GitRunner } from "./runner"

type CommandRunner = Pick<GitRunner, "run">

/**
 * The repo-local config the side panels need, read in one git process.
 *
 * lazygit reads every remote's URLs with a single
 * `git config --local --get-regexp '^remote\.[^.]+\.(url|pushurl)$'`
 * (pkg/commands/git_commands/remote_loader.go:69-71) rather than a `git remote get-url` per
 * remote per direction. The branch keys ride along in the same call: `branch.<name>.remote` is
 * how a branch can be *configured* to track a remote whose ref is not in the local object store,
 * which is the only way to tell lazygit's magenta `?` (tracking, count unknown) apart from a
 * branch that tracks nothing at all — `%(upstream:short)` is empty in both cases.
 */

export type RemoteConfig = {
  readonly fetchUrl?: string
  readonly pushUrl?: string
}

export type BranchUpstreamConfig = {
  readonly remote?: string
  readonly merge?: string
}

export type RepoConfig = {
  readonly remotes: ReadonlyMap<string, RemoteConfig>
  readonly branchUpstreams: ReadonlyMap<string, BranchUpstreamConfig>
}

/**
 * Git matches `--get-regexp` against the *key*, with POSIX ERE. Anchored so a key like
 * `remote.origin.urlsomething` cannot slip in, and deliberately narrow: `remote.<name>.fetch`
 * refspecs and `branch.<name>.rebase` are not read here, so widening the pattern would only make
 * the parse do more work.
 */
export const REPO_CONFIG_KEY_PATTERN = "^(remote\\.[^.]+\\.(url|pushurl)|branch\\..+\\.(remote|merge))$"

const EMPTY: RepoConfig = { remotes: new Map(), branchUpstreams: new Map() }

/**
 * `git config -z --get-regexp` frames one key/value pair per NUL, with a newline between the key
 * and its value. A key with no value (a boolean set by presence) has no newline, and is skipped.
 */
export function parseRepoConfig(raw: string): RepoConfig {
  if (raw.length === 0) return EMPTY
  const remotes = new Map<string, { fetchUrl?: string; pushUrl?: string }>()
  const branchUpstreams = new Map<string, { remote?: string; merge?: string }>()
  for (const record of raw.split("\0")) {
    const separator = record.indexOf("\n")
    if (separator < 0) continue
    const key = record.slice(0, separator)
    const value = record.slice(separator + 1)
    if (key.startsWith("remote.")) {
      const rest = key.slice("remote.".length)
      const dot = rest.lastIndexOf(".")
      if (dot <= 0) continue
      const name = rest.slice(0, dot)
      const field = rest.slice(dot + 1)
      const entry = remotes.get(name) ?? {}
      if (field === "url") entry.fetchUrl = value
      else if (field === "pushurl") entry.pushUrl = value
      else continue
      remotes.set(name, entry)
      continue
    }
    if (!key.startsWith("branch.")) continue
    // A branch name may contain dots, so the *last* dot separates the field.
    const rest = key.slice("branch.".length)
    const dot = rest.lastIndexOf(".")
    if (dot <= 0) continue
    const name = rest.slice(0, dot)
    const field = rest.slice(dot + 1)
    const entry = branchUpstreams.get(name) ?? {}
    if (field === "remote") entry.remote = value
    else if (field === "merge") entry.merge = value
    else continue
    branchUpstreams.set(name, entry)
  }
  return { remotes, branchUpstreams }
}

export async function loadRepoConfig(runner: CommandRunner): Promise<RepoConfig> {
  // Exit code 1 means "no keys matched", which an empty repo legitimately reports.
  const result = await runner.run(["config", "--local", "-z", "--get-regexp", REPO_CONFIG_KEY_PATTERN], {
    readOnly: true,
    acceptedExitCodes: [0, 1],
  })
  return parseRepoConfig(result.stdout)
}
