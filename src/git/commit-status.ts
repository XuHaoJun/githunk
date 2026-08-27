import type { CommitStatus, CommitSummary } from "../domain/commit"
import type { GitRunner } from "./runner"

type CommandRunner = Pick<GitRunner, "run">

/** lazygit's `git.mainBranches` default (pkg/config/user_config.go:957). */
export const DEFAULT_MAIN_BRANCHES: readonly string[] = ["master", "main"]

export type CommitStatusSets = {
  /**
   * Commits reachable from the checked-out branch but not from its upstream or a main branch.
   * Absent on a detached HEAD, where lazygit leaves `unpushedCommitHashes` nil
   * (`refresh_helper.go:833-838` returns no ref, `commit_loader.go:118-121` then skips the query).
   */
  readonly unpushed?: ReadonlySet<string>
  /** Commits not reachable from any main branch. Absent when no configured main branch exists. */
  readonly unmerged?: ReadonlySet<string>
}

/**
 * A query whose failure is not an error: lazygit's `getReachableHashes` swallows the rev-list error
 * and returns an empty set (commit_loader.go:563-577), and `determineMainBranches` treats a failed
 * rev-parse as "this main branch does not exist here" (main_branches.go:89-116).
 */
async function tryOutput(runner: CommandRunner, args: readonly string[]): Promise<string | undefined> {
  try {
    const result = await runner.run(args, { readOnly: true, dontLog: true })
    const text = result.stdout.trim()
    return text.length === 0 ? undefined : text
  } catch {
    return undefined
  }
}

/**
 * lazygit's three probes for one configured main branch name, in order
 * (main_branches.go:89-116): the local branch's upstream, then `refs/remotes/origin/<name>`, then
 * the local `refs/heads/<name>` — so a repository that only ever works locally still gets merged
 * statuses.
 */
async function existingMainBranch(runner: CommandRunner, name: string): Promise<string | undefined> {
  const upstream = await tryOutput(runner, ["rev-parse", "--symbolic-full-name", `${name}@{u}`])
  if (upstream !== undefined) return upstream
  const remote = `refs/remotes/origin/${name}`
  if (await tryOutput(runner, ["rev-parse", "--verify", "--quiet", remote]) !== undefined) return remote
  const local = `refs/heads/${name}`
  if (await tryOutput(runner, ["rev-parse", "--verify", "--quiet", local]) !== undefined) return local
  return undefined
}

const mainBranchCache = new WeakMap<CommandRunner, { readonly key: string; readonly branches: Promise<readonly string[]> }>()

/**
 * Resolves the configured main branch names to the full ref names that exist here, cached for the
 * lifetime of the runner exactly as lazygit caches `existingMainBranches` for the lifetime of the
 * process (main_branches.go:40-52): a main branch created after startup is picked up on restart.
 */
export function resolveMainBranches(
  runner: CommandRunner,
  names: readonly string[] = DEFAULT_MAIN_BRANCHES,
): Promise<readonly string[]> {
  const key = names.join("\n")
  const cached = mainBranchCache.get(runner)
  if (cached !== undefined && cached.key === key) return cached.branches
  const branches = Promise.all(names.map((name) => existingMainBranch(runner, name)))
    .then((resolved) => resolved.filter((branch): branch is string => branch !== undefined))
  mainBranchCache.set(runner, { key, branches })
  return branches
}

/** `git rev-list <refName> ^<notRefName>…`, lazygit's `getReachableHashes` (commit_loader.go:563). */
export async function reachableHashes(
  runner: CommandRunner,
  refName: string,
  notRefNames: readonly string[],
): Promise<ReadonlySet<string>> {
  const output = await tryOutput(runner, ["rev-list", refName, ...notRefNames.map((name) => `^${name}`)])
  if (output === undefined) return new Set()
  return new Set(output.split("\n").map((line) => line.trim()).filter((line) => line.length > 0))
}

/**
 * The checked-out branch's short name, or undefined on a detached HEAD — lazygit's
 * `determineCheckedOutRef` (refresh_helper.go:829-838), which returns no ref in that case so the
 * unpushed query is skipped and nothing renders red.
 */
async function checkedOutBranch(runner: CommandRunner): Promise<string | undefined> {
  return await tryOutput(runner, ["symbolic-ref", "--quiet", "--short", "HEAD"])
}

/**
 * The two reachability sets `setCommitStatuses` needs, issued concurrently the way lazygit issues
 * them (commit_loader.go:104-124). `refName` is the ref the log was taken from — "HEAD" for the
 * Commits panel.
 */
export async function loadCommitStatusSets(
  runner: CommandRunner,
  options: { readonly refName?: string; readonly mainBranches?: readonly string[] } = {},
): Promise<CommitStatusSets> {
  const refName = options.refName ?? "HEAD"
  const mainBranches = await resolveMainBranches(runner, options.mainBranches)
  const branch = await checkedOutBranch(runner)
  const [unmerged, unpushed] = await Promise.all([
    mainBranches.length === 0 ? undefined : reachableHashes(runner, refName, mainBranches),
    branch === undefined
      ? undefined
      : reachableHashes(runner, `refs/heads/${branch}`, [`${branch}@{u}`, ...mainBranches]),
  ])
  return {
    ...(unpushed === undefined ? {} : { unpushed }),
    ...(unmerged === undefined ? {} : { unmerged }),
  }
}

/**
 * lazygit's `setCommitStatuses` (commit_loader.go:543-558). A missing `unmerged` set means no main
 * branch exists to be merged into, so nothing is merged; a missing `unpushed` set means the pushed
 * question could not be asked, so everything unmerged reads as pushed rather than as unpushed.
 */
export function commitStatusFor(
  oid: string,
  sets: CommitStatusSets,
): CommitStatus {
  if (sets.unmerged !== undefined && !sets.unmerged.has(oid)) return "merged"
  return sets.unpushed !== undefined && sets.unpushed.has(oid) ? "unpushed" : "pushed"
}

export function withCommitStatuses(
  commits: readonly CommitSummary[],
  sets: CommitStatusSets,
): readonly CommitSummary[] {
  return commits.map((commit) => ({ ...commit, status: commitStatusFor(commit.oid, sets) }))
}
