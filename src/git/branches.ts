import type { BranchListing, LocalBranch, Remote, RemoteBranch } from "../domain/branch"
import { trackingLocalName } from "../domain/branch"
import { GitRunner } from "./runner"

type CommandRunner = Pick<GitRunner, "run">

export type DeleteBranchOptions = {
  readonly force?: boolean
  /** Force deletion is deliberately a separately confirmed action. */
  readonly confirmed?: boolean
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

function parseNulFields(raw: string, width: number): string[][] {
  const values = raw.split("\0")
  const records: string[][] = []
  let fields: string[] = []
  for (const value of values) {
    const field = value.replace(/^\r?\n/, "").replace(/\r?\n$/, "")
    if (field.length === 0 && fields.length === 0) continue
    fields.push(field)
    if (fields.length === width) {
      records.push(fields)
      fields = []
    }
  }
  return records
}

async function validateBranchName(runner: CommandRunner, name: string): Promise<void> {
  await runner.run(["check-ref-format", "--branch", name], { readOnly: true })
}

async function listRemoteNames(runner: CommandRunner): Promise<readonly string[]> {
  const result = await runner.run(["remote"], { readOnly: true })
  return result.stdout.split(/\r?\n/).map((name) => name.trim()).filter(Boolean)
}

export async function listLocalBranches(runner: CommandRunner): Promise<readonly LocalBranch[]> {
  const result = await runner.run([
    "for-each-ref",
    "--format=%(refname:short)%00%(upstream:short)%00%(objectname)%00%(HEAD)%00%(committerdate:unix)%00%(subject)%00%(upstream:track)%00",
    "refs/heads",
  ], { readOnly: true })
  return parseNulFields(result.stdout, 7).map(([name, upstream, oid, head, committedAt, subject, upstreamTrack]) => ({
    name: name ?? "",
    ...(oid === undefined || oid.length === 0 ? {} : { oid }),
    ...(upstream === undefined || upstream.length === 0 ? {} : { upstream }),
    isCurrent: head === "*",
    committedAt: committedAt ?? "",
    subject: subject ?? "",
    upstreamTrack: upstreamTrack ?? "",
  }))
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

export async function listRemotes(runner: CommandRunner, includeBranches = false): Promise<readonly Remote[]> {
  const names = await listRemoteNames(runner)
  return Promise.all(
    names.map(async (name) => {
      let fetchUrl: string | undefined
      let pushUrl: string | undefined
      try {
        const result = await runner.run(["remote", "get-url", "--", name], { readOnly: true })
        const trimmed = result.stdout.trim()
        if (trimmed.length > 0) fetchUrl = trimmed
      } catch {}
      try {
        const result = await runner.run(["remote", "get-url", "--push", "--", name], { readOnly: true })
        const trimmed = result.stdout.trim()
        if (trimmed.length > 0) pushUrl = trimmed
      } catch {}
      if (pushUrl === undefined && fetchUrl !== undefined) pushUrl = fetchUrl
      if (fetchUrl === undefined && pushUrl !== undefined) fetchUrl = pushUrl
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
  const localBranches = await listLocalBranches(runner)
  const remotes = await listRemotes(runner)
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
export async function createBranch(runner: CommandRunner, branch: string, startPoint?: string): Promise<void> {
  await validateBranchName(runner, branch)
  if (startPoint === undefined) {
    await runner.run(["switch", "-c", branch])
    return
  }
  const resolved = await runner.run(["rev-parse", "--verify", "--quiet", "--end-of-options", `${startPoint}^{commit}`], { readOnly: true })
  if (resolved.stdout.trim().length === 0) throw new Error(`start point does not resolve to a commit: ${startPoint}`)
  await runner.run(["switch", "-c", branch, startPoint])
}


export async function deleteBranch(runner: CommandRunner, branch: string, options: DeleteBranchOptions = {}): Promise<void> {
  await validateBranchName(runner, branch)
  if (options.force === true && options.confirmed !== true) {
    throw new Error(`force deletion requires separate confirmation for ${branch}`)
  }
  await runner.run(["branch", options.force === true ? "-D" : "-d", "--", branch])
}

export async function renameBranch(runner: CommandRunner, oldName: string, newName: string): Promise<void> {
  await validateBranchName(runner, oldName)
  await validateBranchName(runner, newName)
  await runner.run(["branch", "-m", "--", oldName, newName])
}

export async function fetchRemote(runner: CommandRunner, remote: string): Promise<void> {
  const remotes = await listRemoteNames(runner)
  if (!remotes.includes(remote)) throw new Error(`remote does not exist: ${remote}`)
  await runner.run(["fetch", "--", remote])
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
