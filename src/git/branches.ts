import type { BranchListing, LocalBranch, Remote, RemoteBranch } from "../domain/branch"
import { trackingLocalName } from "../domain/branch"
import { GitCommandError, GitRunner } from "./runner"
import { loadRepoConfig, type RepoConfig } from "./config"
import { parseNulFields } from "./parse"

type CommandRunner = Pick<GitRunner, "run">

export type DeleteBranchOptions = {
  readonly force?: boolean
  /** Force deletion is deliberately a separately confirmed action. */
  readonly confirmed?: boolean
}

export type CreateBranchOptions = {
  /** Let Git create normal upstream tracking unless explicitly disabled. */
  readonly track?: boolean
}

export type CheckoutRemoteTrackingOptions = {
  /** Permit switching an existing local branch while leaving its upstream unchanged. */
  readonly confirmedMismatch?: boolean
}
export type RemoteBranchSelection = {
  readonly remote: string
  readonly branch: string
  readonly ref?: string
}

export type CheckoutRemoteTrackingResult =
  | { readonly kind: "created"; readonly localBranch: string; readonly remoteRef: string }
  | { readonly kind: "switched"; readonly localBranch: string; readonly remoteRef: string }
  | {
      readonly kind: "mismatch"
      readonly localBranch: string
      readonly remoteRef: string
      readonly upstream?: string
      readonly message: string
    }

function withoutRecordTerminator(value: string): string {
  return value.replace(/\r?\n$/, "")
}

async function validateBranchName(runner: CommandRunner, name: string): Promise<void> {
  // `dontLog: false` overrides the `readOnly`-implies-quiet default (runner.ts's `dontLog` doc
  // comment) deliberately: `createBranch`/`renameBranch`/`deleteBranch` already log their action
  // label before calling this, so a rejected name must still show *something* under that label —
  // otherwise the log shows a yellow action with nothing under it, contradicting
  // `AppController`'s "a mutation the target refuses logs nothing" guarantee (controller.ts).
  await runner.run(["check-ref-format", "--branch", name], { readOnly: true, dontLog: false })
}

async function listRemoteNames(runner: CommandRunner): Promise<readonly string[]> {
  const result = await runner.run(["remote"], { readOnly: true })
  return result.stdout.split(/\r?\n/).map((name) => name.trim()).filter(Boolean)
}

/**
 * lazygit's `parseUpstreamInfo` (pkg/commands/git_commands/branch_loader.go:466-481). An empty
 * `%(upstream:short)` means the remote-tracking ref is not in this repo, so the counts are unknown
 * rather than zero — the distinction the magenta `?` row is drawn from.
 */
function parseUpstreamTrack(upstreamShort: string, track: string): {
  readonly aheadForPull: string
  readonly behindForPull: string
  readonly upstreamGone: boolean
} {
  if (upstreamShort.length === 0) return { aheadForPull: "?", behindForPull: "?", upstreamGone: false }
  if (track === "[gone]") return { aheadForPull: "?", behindForPull: "?", upstreamGone: true }
  const ahead = /ahead (\d+)/.exec(track)?.[1] ?? "0"
  const behind = /behind (\d+)/.exec(track)?.[1] ?? "0"
  return { aheadForPull: ahead, behindForPull: behind, upstreamGone: false }
}

/**
 * `config` carries the repo-local `branch.<name>.remote`/`.merge` keys; pass the one
 * `listBranches` already read so this does not spawn a second `git config`.
 */
export async function listLocalBranches(runner: CommandRunner, config?: RepoConfig): Promise<readonly LocalBranch[]> {
  const resolvedConfig = config ?? await loadRepoConfig(runner)
  const result = await runner.run([
    "for-each-ref",
    "--format=%(refname:short)%00%(upstream:short)%00%(objectname)%00%(HEAD)%00%(committerdate:unix)%00%(subject)%00%(upstream:track)%00",
    "refs/heads",
  ], { readOnly: true })
  return parseNulFields(result.stdout, 7).map(([name, upstream, oid, head, committedAt, subject, upstreamTrack]) => {
    const branchName = name ?? ""
    const track = parseUpstreamTrack(upstream ?? "", upstreamTrack ?? "")
    const upstreamConfig = resolvedConfig.branchUpstreams.get(branchName)
    return {
      name: branchName,
      ...(oid === undefined || oid.length === 0 ? {} : { oid }),
      ...(upstream === undefined || upstream.length === 0 ? {} : { upstream }),
      isCurrent: head === "*",
      ...(committedAt ? { committedAt } : {}),
      ...(subject ? { subject } : {}),
      ...(upstreamTrack ? { upstreamTrack } : {}),
      ...track,
      ...(upstreamConfig?.remote === undefined ? {} : { upstreamRemote: upstreamConfig.remote }),
      // `refs/heads/` stripped, so this is the *branch* name a pull request's head ref matches —
      // lazygit's `BranchConfig.Merge` (pkg/commands/git_commands/config.go:110).
      ...(upstreamConfig?.merge === undefined ? {} : { upstreamBranch: upstreamConfig.merge.replace(/^refs\/heads\//, "") }),
    }
  })
}

export async function listRemoteBranches(runner: CommandRunner, remote: string): Promise<readonly RemoteBranch[]> {
  const remotes = await listRemoteNames(runner)
  if (!remotes.includes(remote)) throw new Error(`remote does not exist: ${remote}`)
  const result = await runner.run([
    "for-each-ref",
    "--format=%(refname)%00%(objectname)%00",
    `refs/remotes/${remote}`,
  ], { readOnly: true })
  return parseNulFields(result.stdout, 2).flatMap(([refName, oid]) => {
    const prefix = `refs/remotes/${remote}/`
    if (refName === undefined || refName === `${prefix}HEAD` || !refName.startsWith(prefix)) return []
    const name = refName.slice(prefix.length)
    const ref = `${remote}/${name}`
    return [{
      name,
      ref,
      ...(oid === undefined || oid.length === 0 ? {} : { oid }),
    }]
  })
}

/**
 * lazygit sorts remotes with `origin` pinned first, then case-insensitively by name
 * (pkg/commands/git_commands/remote_loader.go:55-64) — "we want origin at the top because we'll be
 * most likely to want it".
 */
function compareRemoteNames(left: string, right: string): number {
  if (left === "origin") return -1
  if (right === "origin") return 1
  return left.toLowerCase().localeCompare(right.toLowerCase())
}

/**
 * Every remote's URLs from the one `git config --get-regexp` `listBranches` already ran, rather
 * than a `git remote get-url` per remote per direction — lazygit's `getRemotesFromConfig`
 * (pkg/commands/git_commands/remote_loader.go:68-110). Pass `config` to reuse that read; omit it
 * and this loads its own.
 */
export async function listRemotes(runner: CommandRunner, includeBranches = false, config?: RepoConfig): Promise<readonly Remote[]> {
  const resolvedConfig = config ?? await loadRepoConfig(runner)
  const names = [...resolvedConfig.remotes.keys()].sort(compareRemoteNames)
  return Promise.all(
    names.map(async (name) => {
      const entry = resolvedConfig.remotes.get(name)!
      // git falls back to the fetch URL when no `pushurl` is configured, and vice versa.
      const fetchUrl = entry.fetchUrl ?? entry.pushUrl
      const pushUrl = entry.pushUrl ?? entry.fetchUrl
      const branches = includeBranches ? await listRemoteBranches(runner, name) : undefined
      return {
        name,
        ...(fetchUrl === undefined ? {} : { fetchUrl }),
        ...(pushUrl === undefined ? {} : { pushUrl }),
        ...(branches === undefined ? {} : { branches }),
      }
    }),
  )
}

export async function listBranches(runner: CommandRunner): Promise<BranchListing> {
  // One config read feeds both loaders: the branch upstreams and every remote's URLs live in it.
  const config = await loadRepoConfig(runner)
  const [localBranches, remotes] = await Promise.all([
    listLocalBranches(runner, config),
    listRemotes(runner, false, config),
  ])
  const current = localBranches.find((branch) => branch.isCurrent)?.name
  return {
    ...(current === undefined ? {} : { current }),
    detached: current === undefined,
    localBranches,
    remotes,
  }
}

export async function switchLocal(runner: CommandRunner, branch: string): Promise<void> {
  await validateBranchName(runner, branch)
  await runner.run(["switch", branch])
}
export async function createBranch(runner: CommandRunner, branch: string, startPoint?: string, options: CreateBranchOptions = {}): Promise<void> {
  await validateBranchName(runner, branch)
  if (startPoint === undefined) {
    await runner.run(["switch", "-c", branch])
    return
  }
  const resolved = await runner.run(["rev-parse", "--verify", "--quiet", "--end-of-options", `${startPoint}^{commit}`], { readOnly: true })
  if (resolved.stdout.trim().length === 0) throw new Error(`start point does not resolve to a commit: ${startPoint}`)
  await runner.run(["switch", "-c", branch, ...(options.track === false ? ["--no-track"] : []), startPoint])
}


export async function deleteBranch(runner: CommandRunner, branch: string, options: DeleteBranchOptions = {}): Promise<void> {
  await validateBranchName(runner, branch)
  if (options.force === true && options.confirmed !== true) {
    throw new Error(`force deletion requires separate confirmation for ${branch}`)
  }
  await runner.run(["branch", options.force === true ? "-D" : "-d", "--", branch])
}

export async function deleteRemoteBranch(runner: CommandRunner, remote: string, branch: string): Promise<void> {
  await validateBranchName(runner, branch)
  const remotes = await listRemoteNames(runner)
  if (!remotes.includes(remote)) throw new Error(`remote does not exist: ${remote}`)
  await runner.run(["push", remote, "--delete", `refs/heads/${branch}`], { streamOutput: true })
}

/** Validates an unconfirmed force delete before touching the remote, then deletes remote first. */
export async function deleteLocalAndRemoteBranch(
  runner: CommandRunner,
  branch: string,
  remote: string,
  remoteBranch: string,
  options: DeleteBranchOptions = {},
): Promise<void> {
  const merged = await isBranchMerged(runner, branch)
  if (!merged && (options.force !== true || options.confirmed !== true)) {
    throw new Error(`force deletion requires separate confirmation for ${branch}`)
  }
  const localOptions = merged ? { force: true, confirmed: true } : options
  await deleteRemoteBranch(runner, remote, remoteBranch)
  await deleteBranch(runner, branch, localOptions)
}

/**
 * Mirrors lazygit's `IsBranchMerged`: a branch is merged when it has no commit outside the
 * checked-out branch or its live upstream. Main-branch configuration is not available in githunk,
 * so HEAD and the branch's explicit upstream are the complete local set.
 */
export async function isBranchMerged(runner: CommandRunner, branch: string, upstream?: string): Promise<boolean> {
  const exclusions = ["^HEAD", ...(upstream === undefined || upstream.length === 0 ? [] : [`^${upstream}`])]
  const result = await runner.run(["rev-list", "--max-count=1", `refs/heads/${branch}`, ...exclusions, "--"], { readOnly: true })
  return result.stdout.trim().length === 0
}

export function branchCheckoutRequiresStash(error: unknown): boolean {
  if (!(error instanceof GitCommandError)) return false
  const stderr = error.record.stderr
  return stderr.includes("Please commit your changes or stash them before you switch branch") ||
    stderr.includes("Please move or remove them before you switch branch")
}

export async function renameBranch(runner: CommandRunner, oldName: string, newName: string): Promise<void> {
  await validateBranchName(runner, oldName)
  await validateBranchName(runner, newName)
  await runner.run(["branch", "-m", "--", oldName, newName])
}

export async function fetchRemote(runner: CommandRunner, remote: string): Promise<void> {
  const remotes = await listRemoteNames(runner)
  if (!remotes.includes(remote)) throw new Error(`remote does not exist: ${remote}`)
  // lazygit's FetchRemote builds with PromptOnCredentialRequest (sync.go:127-132), which routes it
  // through runAndStream and so into the Git output: block (cmd_obj_runner.go:38-40,234-246).
  await runner.run(["fetch", "--", remote], { streamOutput: true })
}

function splitRemoteRef(remoteRef: string, remotes: readonly string[]): { readonly remote: string; readonly branch: string } {
  const matches = remotes.filter((candidate) => remoteRef.startsWith(`${candidate}/`))
  if (matches.length === 0) throw new Error(`remote ref is not configured: ${remoteRef}`)
  if (matches.length > 1) throw new Error(`ambiguous remote ref ${remoteRef}; select a remote explicitly`)
  const remote = matches[0]!
  const branch = remoteRef.slice(remote.length + 1)
  trackingLocalName(remote, branch)
  return { remote, branch }
}

function selectedRemoteRef(selection: RemoteBranchSelection): { readonly remote: string; readonly branch: string; readonly remoteRef: string } {
  const branch = trackingLocalName(selection.remote, selection.branch)
  const remoteRef = selection.ref ?? `${selection.remote}/${selection.branch}`
  if (remoteRef !== `${selection.remote}/${selection.branch}`) throw new Error(`remote branch selection does not match its remote: ${remoteRef}`)
  return { remote: selection.remote, branch, remoteRef }
}

export async function checkoutRemoteTracking(
  runner: CommandRunner,
  selection: RemoteBranchSelection,
  options?: CheckoutRemoteTrackingOptions,
): Promise<CheckoutRemoteTrackingResult>
export async function checkoutRemoteTracking(
  runner: CommandRunner,
  remoteRef: string,
  options?: CheckoutRemoteTrackingOptions,
): Promise<CheckoutRemoteTrackingResult>
export async function checkoutRemoteTracking(
  runner: CommandRunner,
  remote: string,
  branch: string,
  options?: CheckoutRemoteTrackingOptions,
): Promise<CheckoutRemoteTrackingResult>
export async function checkoutRemoteTracking(
  runner: CommandRunner,
  remoteOrSelection: string | RemoteBranchSelection,
  branchOrOptions?: string | CheckoutRemoteTrackingOptions,
  maybeOptions: CheckoutRemoteTrackingOptions = {},
): Promise<CheckoutRemoteTrackingResult> {
  const remotes = await listRemoteNames(runner)
  const selection = typeof remoteOrSelection === "string"
    ? typeof branchOrOptions === "string"
      ? selectedRemoteRef({ remote: remoteOrSelection, branch: branchOrOptions })
      : (() => {
          const remoteRef = remoteOrSelection
          const split = splitRemoteRef(remoteRef, remotes)
          return { ...split, remoteRef }
        })()
    : selectedRemoteRef(remoteOrSelection)
  if (!remotes.includes(selection.remote)) throw new Error(`remote does not exist: ${selection.remote}`)
  const options = typeof branchOrOptions === "object" ? branchOrOptions : maybeOptions
  const localBranch = trackingLocalName(selection.remote, selection.branch)
  await validateBranchName(runner, localBranch)
  const locals = await listLocalBranches(runner)
  const existing = locals.find((candidate) => candidate.name === localBranch)
  if (existing === undefined) {
    await runner.run(["switch", "--track", "-c", localBranch, selection.remoteRef])
    return { kind: "created", localBranch, remoteRef: selection.remoteRef }
  }
  if (existing.upstream === selection.remoteRef || options.confirmedMismatch === true) {
    await runner.run(["switch", localBranch])
    return { kind: "switched", localBranch, remoteRef: selection.remoteRef }
  }
  const upstream = existing.upstream
  const message = upstream === undefined
    ? `local branch ${localBranch} has no upstream; expected ${selection.remoteRef}`
    : `local branch ${localBranch} tracks ${upstream}; expected ${selection.remoteRef}`
  return { kind: "mismatch", localBranch, remoteRef: selection.remoteRef, ...(upstream === undefined ? {} : { upstream }), message }
}
export const listLocal = listLocalBranches
export const listRemote = listRemotes
export const switchBranch = switchLocal
