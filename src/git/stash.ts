import type { StashCreateOptions, StashDropOptions, StashEntry, StashPatch } from "../domain/stash"
import { GitRunner } from "./runner"

type CommandRunner = Pick<GitRunner, "run">

function parseNulFields(raw: string, width: number): string[][] {
  const fields = raw.split("\0")
  const rows: string[][] = []
  for (let index = 0; index + width <= fields.length; index += width) {
    const row = fields.slice(index, index + width)
    if (row.every((value) => value === "")) continue
    if (row[0] === "") continue
    rows.push(row)
  }
  return rows
}

export async function listStashes(runner: CommandRunner): Promise<readonly StashEntry[]> {
  const result = await runner.run(["stash", "list", "-z", "--format=%gd%x00%gs%x00%H"], { readOnly: true })
  return parseNulFields(result.stdout, 3).map(([ref, message, oid]) => ({
    ref: ref ?? "",
    message: message ?? "",
    oid: oid ?? "",
  }))
}

export async function loadStash(runner: CommandRunner, ref: string): Promise<StashPatch> {
  const stashes = await listStashes(runner)
  const stash = stashes.find((entry) => entry.ref === ref)
  if (stash === undefined) throw new Error(`stash not found: ${ref}`)
  const result = await runner.run(["stash", "show", "--patch", "--no-color", "--binary", ref], { readOnly: true })
  return { stash, patch: result.stdout }
}

export async function createStash(
  runner: CommandRunner,
  message: string,
  options: StashCreateOptions,
): Promise<StashEntry | undefined> {
  if (typeof message !== "string" || message.trim().length === 0) throw new Error("stash message must not be empty")
  if (options === undefined || typeof options.includeUntracked !== "boolean") throw new Error("includeUntracked choice is required")
  const args = ["stash", "push"]
  if (options.includeUntracked) args.push("--include-untracked")
  args.push("-m", message)
  await runner.run(args)
  return (await listStashes(runner))[0]
}

export async function applyStash(runner: CommandRunner, ref: string): Promise<void> {
  await runner.run(["stash", "apply", ref])
}

export async function popStash(runner: CommandRunner, ref: string): Promise<void> {
  await runner.run(["stash", "pop", ref])
}

export async function dropStash(runner: CommandRunner, ref: string, options: StashDropOptions): Promise<void> {
  if (options === undefined || options.confirmed !== true) throw new Error("dropping a stash requires confirmation")
  await runner.run(["stash", "drop", ref])
}
