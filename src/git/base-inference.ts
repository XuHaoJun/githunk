import { GitRunner } from "./runner"

export type BaseInference =
  | { readonly kind: "confident"; readonly ref: string; readonly oid: string; readonly reason: string }
  | { readonly kind: "choose"; readonly candidates: readonly string[]; readonly reason: string }

type CommandRunner = Pick<GitRunner, "run">

async function output(runner: CommandRunner, args: readonly string[]): Promise<string | undefined> {
  try {
    return (await runner.run(args, { readOnly: true })).stdout
  } catch {
    return undefined
  }
}

export async function resolveRefOid(runner: CommandRunner, ref: string): Promise<string | undefined> {
  const resolved = await output(runner, ["rev-parse", "--verify", `${ref}^{commit}`])
  const oid = resolved?.trim()
  return oid !== undefined && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(oid) ? oid : undefined
}
export async function currentBranchRef(runner: CommandRunner): Promise<string | undefined> {
  const ref = (await output(runner, ["symbolic-ref", "--quiet", "HEAD"]))?.trim()
  return ref?.startsWith("refs/heads/") ? ref : undefined
}

async function symbolicDefault(runner: CommandRunner, remote: string): Promise<{ readonly ref: string; readonly oid: string } | undefined> {
  const symbolic = (await output(runner, ["symbolic-ref", "--quiet", `refs/remotes/${remote}/HEAD`]))?.trim()
  if (symbolic === undefined || !symbolic.startsWith(`refs/remotes/${remote}/`)) return undefined
  const oid = await resolveRefOid(runner, symbolic)
  return oid === undefined ? undefined : { ref: symbolic, oid }
}

async function remotes(runner: CommandRunner): Promise<readonly string[]> {
  const raw = await output(runner, ["remote"])
  return (raw ?? "").split(/\r?\n/).map((remote) => remote.trim()).filter(Boolean)
}

export async function reviewBaseCandidates(runner: CommandRunner): Promise<readonly string[]> {
  const localRaw = await output(runner, ["for-each-ref", "--format=%(refname:short)", "refs/heads"])
  const remoteRaw = await output(runner, ["for-each-ref", "--format=%(refname)", "refs/remotes"])
  const values = [
    ...(localRaw ?? "").split(/\r?\n/),
    ...(remoteRaw ?? "").split(/\r?\n/),
  ].map((ref) => ref.trim()).filter((ref) => ref.length > 0 && !ref.endsWith("/HEAD"))
  return [...new Set(values)].sort()
}

async function candidates(runner: CommandRunner): Promise<readonly string[]> {
  return reviewBaseCandidates(runner)
}

export async function inferReviewBase(runner: CommandRunner): Promise<BaseInference> {
  const branchRef = await currentBranchRef(runner)
  const allCandidates = await candidates(runner)
  if (branchRef === undefined || await resolveRefOid(runner, "HEAD") === undefined) {
    return { kind: "choose", candidates: allCandidates, reason: branchRef === undefined ? "HEAD is detached" : "HEAD has no commit" }
  }

  const remoteNames = await remotes(runner)
  const upstream = (await output(runner, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]))?.trim()
  const upstreamRemote = upstream?.split("/")[0]
  if (upstreamRemote !== undefined && remoteNames.includes(upstreamRemote)) {
    const preferred = await symbolicDefault(runner, upstreamRemote)
    if (preferred !== undefined) {
      return { kind: "confident", ref: preferred.ref, oid: preferred.oid, reason: `remote default for upstream ${upstreamRemote}` }
    }
  }

  if (remoteNames.includes("origin")) {
    const preferred = await symbolicDefault(runner, "origin")
    if (preferred !== undefined) {
      return { kind: "confident", ref: preferred.ref, oid: preferred.oid, reason: "origin symbolic default" }
    }
  }

  if (remoteNames.length === 1) {
    const preferred = await symbolicDefault(runner, remoteNames[0]!)
    if (preferred !== undefined) {
      return { kind: "confident", ref: preferred.ref, oid: preferred.oid, reason: "sole remote symbolic default" }
    }
  }

  return { kind: "choose", candidates: allCandidates, reason: "no authoritative remote default" }
}
