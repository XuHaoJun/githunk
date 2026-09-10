import { chmodSync, cpSync, existsSync, mkdirSync, renameSync, rmSync } from "node:fs"
import { dirname, join } from "node:path"

export type StandalonePayload = {
  readonly stagedBinary: string
  readonly stagedSkill: string | undefined
  readonly executablePath: string
}

export type PayloadFs = {
  readonly rename?: (source: string, destination: string) => Promise<void>
}

function archiveSkillFor(executablePath: string): string {
  return join(dirname(executablePath), "skills", "githunk-handoff", "SKILL.md")
}

function flatSkillFor(executablePath: string): string {
  return join(dirname(executablePath), "githunk-assets", "skills", "githunk-handoff", "SKILL.md")
}

/** Where the companion skill lives for this installation. Archive layouts win when present. */
export function installedSkillFor(executablePath: string): string {
  if (existsSync(archiveSkillFor(executablePath))) return archiveSkillFor(executablePath)
  return flatSkillFor(executablePath)
}

function syncRename(source: string, destination: string): void {
  renameSync(source, destination)
}

/**
 * Replace the standalone binary and its companion skill as one payload.
 *
 * Skill first to `.new`, old skill parked at `.old`, binary swapped last.
 * A binary failure restores the parked skill so old binary never pairs new guidance.
 * A pre-skill `stagedSkill` removes any companion skill after the binary lands.
 */
export async function replaceStandalonePayload(
  payload: StandalonePayload & { readonly installRoot?: string; readonly installedSkill?: string },
  fs: PayloadFs = {},
): Promise<void> {
  const rename = fs.rename
  const doRename = rename !== undefined
    ? async (source: string, destination: string): Promise<void> => {
      await rename(source, destination)
    }
    : async (source: string, destination: string): Promise<void> => {
      syncRename(source, destination)
    }

  const archiveSkill = archiveSkillFor(payload.executablePath)
  const flatSkill = flatSkillFor(payload.executablePath)
  const targetSkill = payload.installedSkill ?? installedSkillFor(payload.executablePath)
  const stagedSkill = payload.stagedSkill

  if (stagedSkill !== undefined) {
    mkdirSync(dirname(targetSkill), { recursive: true })
    cpSync(stagedSkill, `${targetSkill}.new`)
    const hadOldSkill = existsSync(targetSkill)
    if (hadOldSkill) {
      syncRename(targetSkill, `${targetSkill}.old`)
    }
    try {
      await doRename(`${targetSkill}.new`, targetSkill)
    } catch (error) {
      if (hadOldSkill && existsSync(`${targetSkill}.old`)) {
        try {
          syncRename(`${targetSkill}.old`, targetSkill)
        } catch {
          // Preserve the original rename failure below.
        }
      } else {
        rmSync(`${targetSkill}.new`, { force: true })
      }
      throw error
    }

    try {
      cpSync(payload.stagedBinary, `${payload.executablePath}.new`)
      chmodSync(`${payload.executablePath}.new`, 0o755)
      await doRename(`${payload.executablePath}.new`, payload.executablePath)
    } catch (error) {
      if (hadOldSkill && existsSync(`${targetSkill}.old`)) {
        try {
          syncRename(`${targetSkill}.old`, targetSkill)
        } catch {
          // The binary error is the one callers must see.
        }
      } else {
        rmSync(targetSkill, { force: true })
      }
      rmSync(`${payload.executablePath}.new`, { force: true })
      throw error
    }
    rmSync(`${targetSkill}.old`, { force: true })
    return
  }

  cpSync(payload.stagedBinary, `${payload.executablePath}.new`)
  chmodSync(`${payload.executablePath}.new`, 0o755)
  await doRename(`${payload.executablePath}.new`, payload.executablePath)
  rmSync(archiveSkill, { force: true })
  rmSync(flatSkill, { force: true })
}
