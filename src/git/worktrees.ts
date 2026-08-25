import { stat } from "node:fs/promises"
import { dirname, join } from "node:path"
import type { Worktree } from "../domain/worktree"
import { shortHash } from "../domain/reflog"
import { GitRunner } from "./runner"

type CommandRunner = Pick<GitRunner, "run">

/** One record of `git worktree list --porcelain`, before any derivation. */
export type WorktreeListEntry = {
  readonly path: string
  readonly head?: string
  readonly branch?: string
}

type PendingWorktree = {
  path: string
  head?: string
  branch?: string
  gitDir: string
  isPathMissing: boolean
  isMain: boolean
  isCurrent: boolean
}

type RepositoryPaths = {
  readonly worktreePath: string
  readonly worktreeGitDirPath: string
  readonly repoPath: string
  readonly repoGitDirPath: string
}

type IndexedPath = { readonly path: string; readonly index: number }
type IndexedName = { readonly name: string; readonly index: number }

function finalizeEntry(entry: { path: string; head?: string; branch?: string }): WorktreeListEntry {
  return {
    path: entry.path,
    ...(entry.head === undefined ? {} : { head: entry.head }),
    ...(entry.branch === undefined ? {} : { branch: entry.branch }),
  }
}

/**
 * Parse `git worktree list --porcelain`, following lazygit's
 * `WorktreeLoader.GetWorktrees`: records span multiple lines and are separated
 * by blank lines, and a record carrying a lone `bare` line is not a worktree at
 * all, so it is dropped.
 */
export function parseWorktreeList(raw: string): readonly WorktreeListEntry[] {
  const entries: WorktreeListEntry[] = []
  let current: { path: string; head?: string; branch?: string } | undefined

  for (const line of raw.replace(/\r\n/g, "\n").split("\n")) {
    if (line.length === 0) {
      if (current !== undefined) entries.push(finalizeEntry(current))
      current = undefined
      continue
    }
    if (line === "bare") {
      current = undefined
      continue
    }
    if (line.startsWith("worktree ")) {
      current = { path: line.slice("worktree ".length) }
      continue
    }
    if (current === undefined) continue
    if (line.startsWith("HEAD ")) {
      current.head = line.slice("HEAD ".length)
    } else if (line.startsWith("branch ")) {
      current.branch = line.slice("branch ".length).replace(/^refs\/heads\//, "")
    }
  }

  return entries
}

function trimSlashes(path: string): string {
  return path.replace(/^\/+/, "").replace(/\/+$/, "")
}

/** If the path is /a/b/c/d and the depth is 0 the value is 'd'; at depth 1 it is 'c'. */
function valueAtDepth(path: string, depth: number): string {
  const segments = trimSlashes(path).split("/")
  const index = segments.length - 1 - depth
  return index < 0 ? "" : (segments[index] ?? "")
}

/** If the path is /a/b/c/d and the depth is 0 the value is 'd'; at depth 1 it is 'c/d'. */
function sliceAtDepth(path: string, depth: number): string {
  const segments = trimSlashes(path).split("/")
  const index = segments.length - 1 - depth
  return index < 0 ? "" : segments.slice(index).join("/")
}

function uniqueNamesAtDepth(paths: readonly IndexedPath[], depth: number): readonly IndexedName[] {
  if (paths.length === 0) return []
  if (paths.length === 1) {
    const only = paths[0]!
    return [{ index: only.index, name: sliceAtDepth(only.path, depth) }]
  }

  const groups = new Map<string, IndexedPath[]>()
  for (const path of paths) {
    const value = valueAtDepth(path.path, depth)
    const group = groups.get(value)
    if (group === undefined) groups.set(value, [path])
    else group.push(path)
  }

  const names: IndexedName[] = []
  for (const group of groups.values()) {
    if (group.length === 1) {
      const only = group[0]!
      names.push({ index: only.index, name: sliceAtDepth(only.path, depth) })
    } else {
      names.push(...uniqueNamesAtDepth(group, depth + 1))
    }
  }
  return names
}

/**
 * Name each path by its shortest trailing portion that tells it apart from the
 * others, as lazygit's `getUniqueNamesFromPaths` does.
 */
export function uniqueWorktreeNames(paths: readonly string[]): readonly string[] {
  const indexed = paths.map((path, index): IndexedPath => ({ path, index }))
  const names = new Array<string>(paths.length).fill("")
  for (const named of uniqueNamesAtDepth(indexed, 0)) {
    names[named.index] = named.name
  }
  return names
}

async function resolveRepositoryPaths(runner: CommandRunner): Promise<RepositoryPaths> {
  const result = await runner.run(
    [
      "rev-parse",
      "--path-format=absolute",
      "--show-toplevel",
      "--absolute-git-dir",
      "--git-common-dir",
      "--show-superproject-working-tree",
    ],
    { readOnly: true },
  )
  const lines = result.stdout.replace(/\r\n/g, "\n").split("\n")
  const worktreePath = lines[0] ?? ""
  const worktreeGitDirPath = lines[1] ?? ""
  const repoGitDirPath = lines[2] ?? ""
  // A worktree that has the repo's common git dir to itself is the main
  // worktree, and so is a submodule's worktree even though its git dir lives
  // under the superproject. Otherwise this is a linked worktree, and the repo
  // path is the directory holding the common git dir — the same derivation
  // `git worktree list` uses to report the main worktree.
  const isSubmodule = (lines[3] ?? "").length > 0
  const repoPath =
    worktreeGitDirPath === repoGitDirPath || isSubmodule ? worktreePath : dirname(repoGitDirPath)
  return { worktreePath, worktreeGitDirPath, repoPath, repoGitDirPath }
}

async function isPathMissing(path: string): Promise<boolean> {
  try {
    await stat(path)
    return false
  } catch (error) {
    if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") return true
    return false
  }
}

async function resolveGitDir(runner: CommandRunner, path: string): Promise<string> {
  try {
    const result = await runner.run(["-C", path, "rev-parse", "--path-format=absolute", "--absolute-git-dir"], {
      readOnly: true,
    })
    return result.stdout.trim()
  } catch {
    // A worktree we can't ask git about keeps an empty git dir, as in lazygit.
    return ""
  }
}

async function readTrimmedFile(path: string): Promise<string | undefined> {
  try {
    const text = await Bun.file(path).text()
    return text.trim()
  } catch {
    return undefined
  }
}

/**
 * A worktree mid-rebase or mid-bisect is on a branch that `git worktree list`
 * doesn't report, so recover it from the git dir the way lazygit does.
 */
async function inProgressBranch(gitDir: string): Promise<string | undefined> {
  for (const directory of ["rebase-merge", "rebase-apply"]) {
    const headName = await readTrimmedFile(join(gitDir, directory, "head-name"))
    if (headName !== undefined) return headName.replace(/^refs\/heads\//, "")
  }
  return await readTrimmedFile(join(gitDir, "BISECT_START"))
}

export async function listWorktrees(runner: CommandRunner): Promise<readonly Worktree[]> {
  const repositoryPaths = await resolveRepositoryPaths(runner)
  const result = await runner.run(["worktree", "list", "--porcelain"], { readOnly: true })

  const worktrees: PendingWorktree[] = []
  for (const entry of parseWorktreeList(result.stdout)) {
    worktrees.push({
      path: entry.path,
      ...(entry.head === undefined ? {} : { head: entry.head }),
      ...(entry.branch === undefined ? {} : { branch: entry.branch }),
      gitDir: "",
      isPathMissing: await isPathMissing(entry.path),
      isMain: false,
      isCurrent: false,
    })
  }

  for (const worktree of worktrees) {
    if (worktree.isPathMissing) continue
    worktree.gitDir = await resolveGitDir(runner, worktree.path)
  }

  // Identify the current and the main worktree by their git dir rather than by
  // their path: `git worktree list` reports the main worktree as the common git
  // dir with a trailing "/.git" removed, which is the working tree only when the
  // git dir sits inside it. A worktree whose directory is gone has no git dir to
  // compare, so there we have nothing better than its path.
  for (const worktree of worktrees) {
    if (worktree.gitDir.length > 0) {
      worktree.isCurrent = worktree.gitDir === repositoryPaths.worktreeGitDirPath
      worktree.isMain = worktree.gitDir === repositoryPaths.repoGitDirPath
    } else {
      worktree.isCurrent = worktree.path === repositoryPaths.worktreePath
      worktree.isMain = worktree.path === repositoryPaths.repoPath
    }
  }

  const names = uniqueWorktreeNames(worktrees.map((worktree) => worktree.path))

  const ordered = worktrees.map((worktree, index) => ({ worktree, name: names[index] ?? "" }))
  const currentIndex = ordered.findIndex((entry) => entry.worktree.isCurrent)
  if (currentIndex > 0) {
    ordered.unshift(...ordered.splice(currentIndex, 1))
  }

  const listing: Worktree[] = []
  for (const { worktree, name } of ordered) {
    const branch =
      worktree.branch !== undefined || worktree.gitDir.length === 0
        ? worktree.branch
        : await inProgressBranch(worktree.gitDir)
    listing.push({
      path: worktree.path,
      ...(worktree.gitDir.length === 0 ? {} : { gitDir: worktree.gitDir }),
      name,
      ...(branch === undefined || branch.length === 0 ? {} : { branch }),
      ...(worktree.head === undefined
        ? {}
        : { head: worktree.head, shortHead: shortHash(worktree.head) }),
      isMain: worktree.isMain,
      isCurrent: worktree.isCurrent,
      isPathMissing: worktree.isPathMissing,
    })
  }
  return listing
}
