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

async function untrackedPatches(runner: GitRunner, files: readonly ChangedFile[]): Promise<string> {
  let text = ""
  for (const file of files) {
    const result = await runner.run(
      ["diff", "--no-index", "--no-ext-diff", "--no-color", "--binary", "--", "/dev/null", file.path],
      { readOnly: true, acceptedExitCodes: [0, 1] },
    )
    text += result.stdout
  }
  return text
}
async function untrackedNumstats(runner: GitRunner, files: readonly ChangedFile[]): Promise<readonly NumstatEntry[]> {
  const stats: NumstatEntry[] = []
  for (const file of files) {
    const result = await runner.run(
      ["diff", "--no-index", "--no-ext-diff", "--no-color", "--numstat", "--", "/dev/null", file.path],
      { readOnly: true, acceptedExitCodes: [0, 1] },
    )
    const entry = parseNumstat(result.stdout)[0]
    if (entry !== undefined) stats.push({ ...entry, path: file.path })
  }
  return stats
}

/** Load a stable working-tree status, statistics, and raw patches. */
export async function loadWorkingTree(runner: GitRunner, scope: WorkingTreeScope): Promise<WorkingTreeSnapshot> {
  const status = parsePorcelainV2((await runner.run(statusArgs, { readOnly: true })).stdout)
  const includeUnstaged = scope === "all" || scope === "unstaged"
  const includeStaged = scope === "all" || scope === "staged"
  const unstagedStats = includeUnstaged ? parseNumstat((await runner.run(unstagedNumstatArgs, { readOnly: true })).stdout) : []
  const stagedStats = includeStaged ? parseNumstat((await runner.run(stagedNumstatArgs, { readOnly: true })).stdout) : []
  const files = scopeFiles(status.files, scope)
  const untracked = includeUnstaged ? files.filter((file) => file.untracked) : []
  const untrackedStats = untracked.length > 0 ? await untrackedNumstats(runner, untracked) : []
  const stats = [...(includeUnstaged ? unstagedStats : []), ...(includeStaged ? stagedStats : []), ...untrackedStats]
  let unstagedText = ""
  let stagedText = ""
  if (includeUnstaged) unstagedText = await runPatch(runner, unstagedPatchArgs)
  if (includeStaged) stagedText = await runPatch(runner, stagedPatchArgs)
  if (untracked.length > 0) unstagedText += await untrackedPatches(runner, untracked)
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
