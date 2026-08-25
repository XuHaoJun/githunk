import { join } from "node:path"

/**
 * One `[submodule "…"]` section of a `.gitmodules` file, modelled on lazygit's
 * submodule config (`pkg/commands/models/submodule_config.go`).
 *
 * Nested submodules keep a reference to the module they were found in, which is
 * what the presentation layer (`pkg/gui/presentation/submodules.go`) indents by:
 * two spaces per parent plus a `"- "` prefix.
 */
export type SubmoduleConfig = {
  /** Section name, e.g. `vendor/lib`. May contain slashes and spaces. */
  readonly name: string
  /** `path = …`, relative to the worktree of the module holding it. Empty when the section has none. */
  readonly path: string
  /** `url = …`, absent when the section has none. */
  readonly url?: string
  /** The module this one is nested in; absent for a top-level submodule. */
  readonly parentModule?: SubmoduleConfig
}

/** Name qualified by the parent chain — lazygit's `FullName`, and its list identity. */
export function submoduleFullName(submodule: SubmoduleConfig): string {
  if (submodule.parentModule === undefined) return submodule.name
  return `${submoduleFullName(submodule.parentModule)}/${submodule.name}`
}

/** Path relative to the top-level worktree — lazygit's `FullPath`. */
export function submoduleFullPath(submodule: SubmoduleConfig): string {
  if (submodule.parentModule === undefined) return submodule.path
  return `${submoduleFullPath(submodule.parentModule)}/${submodule.path}`
}

/** How many modules this one is nested inside; 0 for a top-level submodule. */
export function submoduleDepth(submodule: SubmoduleConfig): number {
  let depth = 0
  for (let parent = submodule.parentModule; parent !== undefined; parent = parent.parentModule) {
    depth += 1
  }
  return depth
}

/** Git dir of the submodule under the repository's git dir — lazygit's `GitDirPath`. */
export function submoduleGitDirPath(repoGitDirPath: string, submodule: SubmoduleConfig): string {
  const parentPath =
    submodule.parentModule === undefined
      ? repoGitDirPath
      : submoduleGitDirPath(repoGitDirPath, submodule.parentModule)
  return join(parentPath, "modules", submodule.name)
}
