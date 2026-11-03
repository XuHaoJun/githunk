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
    const stagedNotices = join(stagedRoot, "third-party", "opentui")
    const installedNotices = layout === "archive" ? join(installRoot, "third-party", "opentui") : join(installRoot, "githunk-assets", "third-party", "opentui")
    await mkdir(join(stagedRoot, "skills", "githunk-handoff"), { recursive: true })
    await mkdir(stagedNotices, { recursive: true })
    await mkdir(join(installedSkill, ".."), { recursive: true })
    await mkdir(installedNotices, { recursive: true })
    await writeFile(stagedBinary, "new binary")
    await writeFile(stagedSkill, "new skill")
    await writeFile(join(stagedNotices, "LICENSE-FFMPEG"), "new notices")
    await writeFile(executablePath, "old binary")
    await writeFile(installedSkill, "old skill")
    await writeFile(join(installedNotices, "LICENSE-FFMPEG"), "old notices")
    return { installRoot, stagedBinary, stagedSkill, stagedNotices, executablePath, installedSkill, installedNotices }
  }

  test("updates an extracted archive's existing skill in place", async () => {
    const paths = await fixture("archive")

    await replaceStandalonePayload(paths)

    expect(await Bun.file(paths.executablePath).text()).toBe("new binary")
    expect(await Bun.file(paths.installedSkill).text()).toBe("new skill")
    expect(await Bun.file(join(paths.installRoot, "githunk-assets", "skills", "githunk-handoff", "SKILL.md")).exists()).toBe(false)
    expect(await Bun.file(join(paths.installedNotices, "LICENSE-FFMPEG")).text()).toBe("new notices")
    expect(await Bun.file(join(paths.installRoot, "githunk-assets", "third-party", "opentui", "LICENSE-FFMPEG")).exists()).toBe(false)
  })

  test("updates a flat installation's notice directory", async () => {
    const paths = await fixture("flat")

    await replaceStandalonePayload(paths)

    expect(await Bun.file(join(paths.installedNotices, "LICENSE-FFMPEG")).text()).toBe("new notices")
    expect(await Bun.file(join(paths.installRoot, "third-party", "opentui", "LICENSE-FFMPEG")).exists()).toBe(false)
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
    expect(await Bun.file(join(paths.installedNotices, "LICENSE-FFMPEG")).text()).toBe("old notices")
    expect(await Bun.file(`${paths.installedSkill}.old`).exists()).toBe(false)
  })

  test("removes a newer companion skill when downgrading to a pre-skill archive", async () => {
    const paths = await fixture("flat")

    await replaceStandalonePayload({
      stagedBinary: paths.stagedBinary,
      stagedSkill: undefined,
      stagedNotices: undefined,
      executablePath: paths.executablePath
    })

    expect(await Bun.file(paths.executablePath).text()).toBe("new binary")
    expect(await Bun.file(paths.installedSkill).exists()).toBe(false)
    expect(await Bun.file(join(paths.installedNotices, "LICENSE-FFMPEG")).text()).toBe("old notices")
  })
})
