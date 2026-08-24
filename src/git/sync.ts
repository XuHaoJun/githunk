import { GitCommandError, GitRunner } from "./runner"

type CommandRunner = Pick<GitRunner, "run">

export type UpstreamCandidate = {
  readonly remote: string
  readonly branch: string
}

export type UpstreamRequired = {
  readonly kind: "upstream-required"
  readonly branch: string
  readonly candidates: readonly UpstreamCandidate[]
  readonly operation: "pull" | "push"
}

export type PushOptions = {
  readonly upstream?: UpstreamCandidate
}

export type PullOptions = {
  readonly upstream?: UpstreamCandidate
}

export type PushResult = { readonly kind: "pushed" } | UpstreamRequired
export type PullResult = { readonly kind: "pulled" } | UpstreamRequired

async function currentBranch(runner: CommandRunner): Promise<string> {
  const result = await runner.run(["symbolic-ref", "--quiet", "--short", "HEAD"], { readOnly: true })
  const branch = result.stdout.trim()
  if (branch.length === 0) throw new Error("synchronization requires an attached branch")
  return branch
}

async function upstreamRef(runner: CommandRunner): Promise<string | undefined> {
  try {
    const result = await runner.run(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], { readOnly: true })
    const value = result.stdout.trim()
    return value.length === 0 ? undefined : value
  } catch (error) {
    if (error instanceof GitCommandError && error.record.exitCode === 128) return undefined
    throw error
  }
}

async function upstreamCandidates(runner: CommandRunner): Promise<readonly UpstreamCandidate[]> {
  const remotes = (await runner.run(["remote"], { readOnly: true })).stdout.split(/\r?\n/).map((remote) => remote.trim()).filter(Boolean)
  const refs = (await runner.run(["for-each-ref", "--format=%(refname)", "refs/remotes"], { readOnly: true })).stdout
    .split(/\r?\n/)
    .map((ref) => ref.trim())
    .filter((ref) => ref.startsWith("refs/remotes/") && !ref.endsWith("/HEAD"))
  const candidates: UpstreamCandidate[] = []
  for (const ref of refs) {
    const remoteRef = ref.slice("refs/remotes/".length)
    const remote = remotes.slice().sort((left, right) => right.length - left.length).find((candidate) => remoteRef.startsWith(`${candidate}/`))
    if (remote === undefined) continue
    const branch = remoteRef.slice(remote.length + 1)
    if (branch.length > 0) candidates.push({ remote, branch })
  }
  return candidates
}
function validateUpstream(upstream: UpstreamCandidate): void {
  if (upstream.remote.length === 0 || upstream.branch.length === 0 || upstream.remote.startsWith("-") || upstream.branch.startsWith("-")) {
    throw new Error("invalid upstream choice")
  }
}
export async function fetch(runner: CommandRunner, remote?: string): Promise<void> {
  await runner.run(remote === undefined ? ["fetch"] : ["fetch", remote])
}

export async function pull(runner: CommandRunner, options: PullOptions = {}): Promise<PullResult> {
  const branch = await currentBranch(runner)
  if (options.upstream !== undefined) {
    validateUpstream(options.upstream)
    await runner.run(["pull", options.upstream.remote, options.upstream.branch])
    return { kind: "pulled" }
  }
  if (await upstreamRef(runner) === undefined) {
    return { kind: "upstream-required", branch, candidates: await upstreamCandidates(runner), operation: "pull" }
  }
  await runner.run(["pull"])
  return { kind: "pulled" }
}

export async function push(runner: CommandRunner, options: PushOptions = {}): Promise<PushResult> {
  const branch = await currentBranch(runner)
  if (options.upstream !== undefined) {
    validateUpstream(options.upstream)
    await runner.run(["push", "--set-upstream", options.upstream.remote, options.upstream.branch])
    return { kind: "pushed" }
  }
  if (await upstreamRef(runner) === undefined) {
    return { kind: "upstream-required", branch, candidates: await upstreamCandidates(runner), operation: "push" }
  }
  await runner.run(["push"])
  return { kind: "pushed" }
}
