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
  for (let index = 0; index + width <= values.length; index += width) {
    const fields = values.slice(index, index + width).map(withoutRecordTerminator)
    if (fields.every((field) => field.length === 0)) continue
    records.push(fields)
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
    "--format=%(refname:short)%00%(upstream:short)%00%(objectname)%00%(HEAD)",
    "refs/heads",
  ], { readOnly: true })
  return parseNulFields(result.stdout, 4).map(([name, upstream, oid, head]) => ({
    name: name ?? "",
    ...(oid === undefined || oid.length === 0 ? {} : { oid }),
    ...(upstream === undefined || upstream.length === 0 ? {} : { upstream }),
    isCurrent: head === "*",
  }))
}

export async function listRemoteBranches(runner: CommandRunner, remote: string): Promise<readonly RemoteBranch[]> {
  const remotes = await listRemoteNames(runner)
  if (!remotes.includes(remote)) throw new Error(`remote does not exist: ${remote}`)
  const result = await runner.run([
    "for-each-ref",
    "--format=%(refname:short)%00%(objectname)",
    `refs/remotes/${remote}`,
  ], { readOnly: true })
  return parseNulFields(result.stdout, 2).flatMap(([fullRef, oid]) => {
    if (fullRef === undefined || fullRef === `${remote}/HEAD` || !fullRef.startsWith(`${remote}/`)) return []
    return [{
      name: fullRef.slice(remote.length + 1),
      ref: fullRef,
      ...(oid === undefined || oid.length === 0 ? {} : { oid }),
    }]
  })
}

export async function listRemotes(runner: CommandRunner, includeBranches = false): Promise<readonly Remote[]> {
  const names = await listRemoteNames(runner)
  return Promise.all(names.map(async (name) => includeBranches
    ? { name, branches: await listRemoteBranches(runner, name) }
    : { name }))
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
  await runner.run(startPoint === undefined ? ["switch", "-c", branch] : ["switch", "-c", branch, startPoint])
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
  await runner.run(["fetch", remote])
}

function splitRemoteRef(remoteRef: string, remotes: readonly string[]): { readonly remote: string; readonly branch: string } {
  const remote = [...remotes].sort((left, right) => right.length - left.length).find((candidate) => remoteRef.startsWith(`${candidate}/`))
  if (remote === undefined) throw new Error(`remote ref is not configured: ${remoteRef}`)
  const branch = remoteRef.slice(remote.length + 1)
  trackingLocalName(remote, branch)
  return { remote, branch }
}

export async function checkoutRemoteTracking(
  runner: CommandRunner,
  remoteRef: string,
  options: CheckoutRemoteTrackingOptions = {},
): Promise<CheckoutRemoteTrackingResult> {
  const remotes = await listRemoteNames(runner)
  const { remote, branch } = splitRemoteRef(remoteRef, remotes)
  const localBranch = trackingLocalName(remote, branch)
  await validateBranchName(runner, localBranch)
  const locals = await listLocalBranches(runner)
  const existing = locals.find((candidate) => candidate.name === localBranch)
  if (existing === undefined) {
    await runner.run(["switch", "--track", "-c", localBranch, remoteRef])
    return { kind: "created", localBranch, remoteRef }
  }
  if (existing.upstream === remoteRef || options.confirmedMismatch === true) {
    await runner.run(["switch", localBranch])
    return { kind: "switched", localBranch, remoteRef }
  }
  const upstream = existing.upstream
  const message = upstream === undefined
    ? `local branch ${localBranch} has no upstream; expected ${remoteRef}`
    : `local branch ${localBranch} tracks ${upstream}; expected ${remoteRef}`
  return { kind: "mismatch", localBranch, remoteRef, ...(upstream === undefined ? {} : { upstream }), message }
}
export const listLocal = listLocalBranches
export const listRemote = listRemotes
export const switchBranch = switchLocal
