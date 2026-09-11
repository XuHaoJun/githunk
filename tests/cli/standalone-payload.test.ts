import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { replaceStandalonePayload } from "../../src/cli/standalone-payload"

describe("replaceStandalonePayload", () => {
  const temporaryDirectories: string[] = []

  afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
  })

  async function fixture(layout: "archive" | "flat") {
    const root = await mkdtemp(join(tmpdir(), "githunk-payload-"))
    temporaryDirectories.push(root)
    const stagedRoot = join(root, "staged")
    const installRoot = join(root, "installed")
    const stagedBinary = join(stagedRoot, "githunk")
    const stagedSkill = join(stagedRoot, "skills", "githunk-handoff", "SKILL.md")
    const executablePath = join(installRoot, "githunk")
    const installedSkill = layout === "archive" ? join(installRoot, "skills", "githunk-handoff", "SKILL.md") : join(installRoot, "githunk-assets", "skills", "githunk-handoff", "SKILL.md")
    await mkdir(join(stagedRoot, "skills", "githunk-handoff"), { recursive: true })
    await mkdir(join(installedSkill, ".."), { recursive: true })
    await writeFile(stagedBinary, "new binary")
    await writeFile(stagedSkill, "new skill")
    await writeFile(executablePath, "old binary")
    await writeFile(installedSkill, "old skill")
    return { installRoot, stagedBinary, stagedSkill, executablePath, installedSkill }
  }

  test("updates an extracted archive's existing skill in place", async () => {
    const paths = await fixture("archive")

    await replaceStandalonePayload(paths)

    expect(await Bun.file(paths.executablePath).text()).toBe("new binary")
    expect(await Bun.file(paths.installedSkill).text()).toBe("new skill")
    expect(await Bun.file(join(paths.installRoot, "githunk-assets", "skills", "githunk-handoff", "SKILL.md")).exists()).toBe(false)
  })

  test("restores the old skill when committing the binary fails", async () => {
    const paths = await fixture("flat")

    await expect(
      replaceStandalonePayload(paths, {
        rename: async (source, destination) => {
          if (source === `${paths.executablePath}.new` && destination === paths.executablePath) {
            throw new Error("binary locked")
          }
          await rename(source, destination)
        }
      })
    ).rejects.toThrow("binary locked")

    expect(await Bun.file(paths.executablePath).text()).toBe("old binary")
    expect(await Bun.file(paths.installedSkill).text()).toBe("old skill")
    expect(await Bun.file(`${paths.installedSkill}.old`).exists()).toBe(false)
  })

  test("removes a newer companion skill when downgrading to a pre-skill archive", async () => {
    const paths = await fixture("flat")

    await replaceStandalonePayload({
      stagedBinary: paths.stagedBinary,
      stagedSkill: undefined,
      executablePath: paths.executablePath
    })

    expect(await Bun.file(paths.executablePath).text()).toBe("new binary")
    expect(await Bun.file(paths.installedSkill).exists()).toBe(false)
  })
})
