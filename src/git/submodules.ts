import { readFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { submoduleFullPath, type SubmoduleConfig } from "../domain/submodule"
import { GitRunner } from "./runner"

type CommandRunner = Pick<GitRunner, "run">

/** One `[submodule "…"]` section as it appears in a `.gitmodules` file. */
export type GitModulesEntry = {
  readonly name: string
  readonly path: string
  readonly url?: string
}

const SECTION_PATTERN = /\[submodule "(.*)"\]/
const PATH_PATTERN = /\s*path\s*=\s*(.*)/
const URL_PATTERN = /\s*url\s*=\s*(.*)/

/**
 * Parse a `.gitmodules` file the way lazygit's `SubmoduleCommands.GetConfigs`
 * does: match the section headers and the `path`/`url` entries under them, and
 * ignore everything else.
 */
export function parseGitModules(raw: string): readonly GitModulesEntry[] {
  const entries: { name: string; path: string; url?: string }[] = []

  for (const line of raw.replace(/\r\n/g, "\n").split("\n")) {
    const section = SECTION_PATTERN.exec(line)
    if (section !== null) {
      entries.push({ name: section[1] ?? "", path: "" })
      continue
    }
    const current = entries[entries.length - 1]
    if (current === undefined) continue
    const path = PATH_PATTERN.exec(line)
    if (path !== null) {
      current.path = path[1] ?? ""
      continue
    }
    const url = URL_PATTERN.exec(line)
    if (url !== null) current.url = url[1] ?? ""
  }

  return entries.map((entry) => ({
    name: entry.name,
    path: entry.path,
    ...(entry.url === undefined ? {} : { url: entry.url }),
  }))
}

async function readGitModules(directory: string): Promise<string | undefined> {
  try {
    return await readFile(join(directory, ".gitmodules"), "utf8")
  } catch (error) {
    if (error instanceof Error && "code" in error) {
      const code = (error as NodeJS.ErrnoException).code
      // No .gitmodules (or no directory to hold one) simply means no submodules.
      if (code === "ENOENT" || code === "ENOTDIR") return undefined
    }
    throw error
  }
}

async function collectSubmodules(
  worktreePath: string,
  parentModule: SubmoduleConfig | undefined,
  visited: Set<string>,
): Promise<readonly SubmoduleConfig[]> {
  const directory =
    parentModule === undefined ? worktreePath : join(worktreePath, submoduleFullPath(parentModule))
  const resolved = resolve(directory)
  // A submodule pointing back at a directory we already read would recurse for ever.
  if (visited.has(resolved)) return []
  visited.add(resolved)

  const raw = await readGitModules(directory)
  if (raw === undefined) return []

  const configs: SubmoduleConfig[] = []
  for (const entry of parseGitModules(raw)) {
    const config: SubmoduleConfig = {
      name: entry.name,
      path: entry.path,
      ...(entry.url === undefined ? {} : { url: entry.url }),
      ...(parentModule === undefined ? {} : { parentModule }),
    }
    configs.push(config)
    // Nested submodules follow their parent, which is what the indented
    // presentation expects.
    if (config.path.length > 0) {
      configs.push(...(await collectSubmodules(worktreePath, config, visited)))
    }
  }
  return configs
}

/**
 * Read the submodules of the worktree at `worktreePath`, recursing into the
 * `.gitmodules` of each one. `parentModule` names a module inside that worktree
 * to start from instead of the worktree itself.
 */
export async function readSubmoduleConfigs(
  worktreePath: string,
  parentModule?: SubmoduleConfig,
): Promise<readonly SubmoduleConfig[]> {
  return await collectSubmodules(worktreePath, parentModule, new Set<string>())
}

export async function listSubmodules(runner: CommandRunner): Promise<readonly SubmoduleConfig[]> {
  const result = await runner.run(["rev-parse", "--path-format=absolute", "--show-toplevel"], { readOnly: true })
  const worktreePath = (result.stdout.replace(/\r\n/g, "\n").split("\n")[0] ?? "").trim()
  if (worktreePath.length === 0) throw new Error("git did not report a worktree path")
  return await readSubmoduleConfigs(worktreePath)
}
