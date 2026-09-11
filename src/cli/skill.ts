import { accessSync, constants, existsSync, statSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const SKILL_RELATIVE_PATH = join("skills", "githunk-handoff", "SKILL.md")

const STANDALONE_SKILL_RELATIVE_PATH = join("githunk-assets", SKILL_RELATIVE_PATH)
export type SkillOperation = "path" | "show"
export type SkillOutcome = { readonly text: string; readonly exitCode: number }

function findRelativePathFromAncestors(startPath: string, relativePath: string): string | undefined {
  let current = resolve(startPath)
  try {
    if (statSync(current).isFile()) current = dirname(current)
  } catch {
    // Missing search roots are treated as directories so their existing ancestors remain searchable.
  }

  for (;;) {
    const candidate = join(current, relativePath)
    if (existsSync(candidate)) {
      try {
        if (statSync(candidate).isFile()) {
          accessSync(candidate, constants.R_OK)
          return candidate
        }
      } catch {
        // Unreadable or non-file candidates fall through to the next ancestor.
      }
    }
    const parent = dirname(current)
    if (parent === current) return undefined
    current = parent
  }
}

/** Resolve the bundled handoff skill from source, npm, or standalone package layouts. */
export function defaultSkillSearchRoots(executablePath: string = process.execPath, moduleUrl: string = import.meta.url): readonly string[] {
  return [dirname(fileURLToPath(moduleUrl)), executablePath]
}

export function resolveBundledSkillPath(searchRoots: readonly string[] = defaultSkillSearchRoots()): string {
  for (const root of searchRoots) {
    for (const relativePath of [SKILL_RELATIVE_PATH, STANDALONE_SKILL_RELATIVE_PATH]) {
      const skillPath = findRelativePathFromAncestors(root, relativePath)
      if (skillPath !== undefined) return skillPath
    }
  }
  throw new Error("Could not locate the bundled githunk-handoff skill.")
}

export async function runSkillCommand(input: { readonly operation: SkillOperation; readonly searchRoots?: readonly string[] }): Promise<SkillOutcome> {
  try {
    const skillPath = resolveBundledSkillPath(input.searchRoots)
    if (input.operation === "path") return { text: `${skillPath}\n`, exitCode: 0 }
    return { text: await readFile(skillPath, "utf8"), exitCode: 0 }
  } catch (error) {
    return { text: error instanceof Error ? error.message : String(error), exitCode: 1 }
  }
}
