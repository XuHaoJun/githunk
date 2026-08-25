import type { WorkingTreeSnapshot, PatchSection } from "../domain/repository"
import type { ChangedFile, WorkingTreeScope } from "../domain/review-target"
import { GitRunner } from "./runner"
import { parsePorcelainV2 } from "./status"

const statusArgs = ["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all"] as const
const unstagedNumstatArgs = ["diff", "--no-ext-diff", "--no-color", "--find-renames", "--numstat", "-z"] as const
const stagedNumstatArgs = ["diff", "--cached", "--no-ext-diff", "--no-color", "--find-renames", "--numstat", "-z"] as const
const unstagedPatchArgs = ["diff", "--no-ext-diff", "--no-color", "--find-renames", "--binary", "--"] as const
const stagedPatchArgs = ["diff", "--cached", "--no-ext-diff", "--no-color", "--find-renames", "--binary", "--"] as const

export type NumstatEntry = {
  readonly path: string
  readonly previousPath?: string
  readonly additions: number
  readonly deletions: number
}

function count(value: string): number {
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0
}

/** Parse `git diff --numstat -z`, including rename records. */
export function parseNumstat(raw: string): readonly NumstatEntry[] {
  const records = raw.split("\0")
  const entries: NumstatEntry[] = []
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index] ?? ""
    if (record.length === 0) continue
    const firstTab = record.indexOf("\t")
    const secondTab = firstTab < 0 ? -1 : record.indexOf("\t", firstTab + 1)
    if (firstTab < 0 || secondTab < 0) continue
    const additions = count(record.slice(0, firstTab))
    const deletions = count(record.slice(firstTab + 1, secondTab))
    const path = record.slice(secondTab + 1)
    if (path.length === 0 && records[index + 1] !== undefined && records[index + 2] !== undefined) {
      entries.push({
        path: records[index + 2] ?? "",
        previousPath: records[index + 1] ?? "",
        additions,
        deletions,
      })
      index += 2
    } else {
      entries.push({ path, additions, deletions })
    }
  }
  return entries
}

function mergeStats(files: readonly ChangedFile[], stats: readonly NumstatEntry[]): ChangedFile[] {
  const byPath = new Map<string, NumstatEntry>()
  for (const stat of stats) {
    const existing = byPath.get(stat.path)
    if (existing === undefined) byPath.set(stat.path, stat)
    else {
      byPath.set(stat.path, {
        ...stat,
        additions: existing.additions + stat.additions,
        deletions: existing.deletions + stat.deletions,
      })
    }
  }
  return files.map((file) => {
    const stat = byPath.get(file.path)
    if (stat === undefined) return file
    const merged = { ...file, additions: stat.additions, deletions: stat.deletions }
    return file.previousPath !== undefined || stat.previousPath === undefined
      ? merged
      : { ...merged, previousPath: stat.previousPath }
  })
}

function scopeFiles(files: readonly ChangedFile[], scope: WorkingTreeScope): readonly ChangedFile[] {
  if (scope === "all") return files
  if (scope === "staged") return files.filter((file) => !file.untracked && file.indexStatus !== ".")
  return files.filter((file) => file.untracked || file.worktreeStatus !== ".")
}

async function runPatch(runner: GitRunner, args: readonly string[]): Promise<string> {
  return (await runner.run(args, { readOnly: true })).stdout
}

/**
 * Ceiling on concurrent `git` processes for the per-untracked-file work below. High enough that a
 * handful of untracked files cost one round trip rather than one each, low enough that a repo with
 * thousands of them cannot fork-bomb the machine.
 */
const UNTRACKED_CONCURRENCY = 8

/** `Promise.all` with a ceiling, preserving input order. */
async function mapWithLimit<T, R>(items: readonly T[], limit: number, run: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = next++
      if (index >= items.length) return
      results[index] = await run(items[index]!)
    }
  })
  await Promise.all(workers)
  return results
}

async function untrackedPatches(runner: GitRunner, files: readonly ChangedFile[]): Promise<string> {
  const texts = await mapWithLimit(files, UNTRACKED_CONCURRENCY, async (file) => {
    const result = await runner.run(
      ["diff", "--no-index", "--no-ext-diff", "--no-color", "--binary", "--", "/dev/null", file.path],
      { readOnly: true, acceptedExitCodes: [0, 1] },
    )
    return result.stdout
  })
  return texts.join("")
}
async function untrackedNumstats(runner: GitRunner, files: readonly ChangedFile[]): Promise<readonly NumstatEntry[]> {
  const entries = await mapWithLimit(files, UNTRACKED_CONCURRENCY, async (file) => {
    const result = await runner.run(
      ["diff", "--no-index", "--no-ext-diff", "--no-color", "--numstat", "--", "/dev/null", file.path],
      { readOnly: true, acceptedExitCodes: [0, 1] },
    )
    const entry = parseNumstat(result.stdout)[0]
    return entry === undefined ? undefined : { ...entry, path: file.path }
  })
  return entries.filter((entry): entry is NumstatEntry => entry !== undefined)
}

export type WorkingTreeLoadOptions = {
  /**
   * A refresh nobody asked for. It leaves `GIT_OPTIONAL_LOCKS=0` on the status call so it cannot
   * contend for `index.lock`; a foreground refresh drops the suppression instead, letting git
   * persist the stat-cache it just refreshed — lazygit's one exception to suppressing locks
   * everywhere (pkg/commands/git_commands/file_loader.go:228-236,
   * pkg/gui/types/refresh.go:89-96).
   */
  readonly background?: boolean
}

/** Load a stable working-tree status, statistics, and raw patches. */
export async function loadWorkingTree(runner: GitRunner, scope: WorkingTreeScope, options: WorkingTreeLoadOptions = {}): Promise<WorkingTreeSnapshot> {
  const includeUnstaged = scope === "all" || scope === "unstaged"
  const includeStaged = scope === "all" || scope === "staged"
  // Every one of these reads is independent of the others: only the *untracked* work below needs
  // the status output, so nothing is gained by waiting for it first. They all suppress
  // `index.lock` (the status call excepted, see above), so running them together cannot contend.
  const [statusOutput, unstagedStats, stagedStats, unstagedDiffText, stagedDiffText] = await Promise.all([
    runner.run(statusArgs, { readOnly: true, ...(options.background === true ? {} : { optionalLocks: true }) }).then((result) => result.stdout),
    includeUnstaged ? runner.run(unstagedNumstatArgs, { readOnly: true }).then((result) => parseNumstat(result.stdout)) : Promise.resolve([] as readonly NumstatEntry[]),
    includeStaged ? runner.run(stagedNumstatArgs, { readOnly: true }).then((result) => parseNumstat(result.stdout)) : Promise.resolve([] as readonly NumstatEntry[]),
    includeUnstaged ? runPatch(runner, unstagedPatchArgs) : Promise.resolve(""),
    includeStaged ? runPatch(runner, stagedPatchArgs) : Promise.resolve(""),
  ])
  const status = parsePorcelainV2(statusOutput)
  const files = scopeFiles(status.files, scope)
  const untracked = includeUnstaged ? files.filter((file) => file.untracked) : []
  const [untrackedStats, untrackedText] = untracked.length === 0
    ? [[] as readonly NumstatEntry[], ""]
    : await Promise.all([untrackedNumstats(runner, untracked), untrackedPatches(runner, untracked)])
  const stats = [...unstagedStats, ...stagedStats, ...untrackedStats]
  const unstagedText = `${unstagedDiffText}${untrackedText}`
  const stagedText = stagedDiffText
  const patches: PatchSection[] = []
  if (includeStaged) patches.push({ label: "STAGED", text: stagedText })
  if (includeUnstaged) patches.push({ label: "UNSTAGED", text: unstagedText })
  const snapshot = {
    repositoryRoot: runner.cwd,
    branch: status.branch,
    ...(status.upstream === undefined ? {} : { upstream: status.upstream }),
    reviewTarget: { kind: "working-tree" as const, scope },
    files: mergeStats(files, stats),
    patches,
  }
  return snapshot
}
