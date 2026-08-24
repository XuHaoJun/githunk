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
}

export type PushOptions = {
  readonly upstream?: UpstreamCandidate
}

export type PushResult = { readonly kind: "pushed" } | UpstreamRequired

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
    const slash = remoteRef.indexOf("/")
    if (slash <= 0 || slash === remoteRef.length - 1) continue
    const remote = remoteRef.slice(0, slash)
    const branch = remoteRef.slice(slash + 1)
    if (remotes.includes(remote)) candidates.push({ remote, branch })
  }
  return candidates
}

export async function fetch(runner: CommandRunner, remote?: string): Promise<void> {
  await runner.run(remote === undefined ? ["fetch"] : ["fetch", remote])
}

export async function pull(runner: CommandRunner): Promise<void> {
  await runner.run(["pull"])
}

export async function push(runner: CommandRunner, options: PushOptions = {}): Promise<PushResult> {
  const branch = await currentBranch(runner)
  if (options.upstream !== undefined) {
    const { remote, branch: upstreamBranch } = options.upstream
    if (remote.length === 0 || upstreamBranch.length === 0 || remote.startsWith("-") || upstreamBranch.startsWith("-")) {
      throw new Error("invalid upstream choice")
    }
    await runner.run(["push", "--set-upstream", remote, upstreamBranch])
    return { kind: "pushed" }
  }
  if (await upstreamRef(runner) === undefined) {
    return { kind: "upstream-required", branch, candidates: await upstreamCandidates(runner) }
  }
  await runner.run(["push"])
  return { kind: "pushed" }
}
