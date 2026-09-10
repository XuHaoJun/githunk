import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { copyBundledSkill } from "../../scripts/prebuilt-package-helpers"

describe("copyBundledSkill", () => {
  const temporaryDirectories: string[] = []

  afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
  })

  test("copies only the agent-facing handoff skill into a release payload", async () => {
    const source = await mkdtemp(join(tmpdir(), "githunk-skill-source-"))
    const destination = await mkdtemp(join(tmpdir(), "githunk-skill-destination-"))
    temporaryDirectories.push(source, destination)
    await mkdir(join(source, "skills", "githunk-handoff"), { recursive: true })
    await mkdir(join(source, "skills", "githunk-release"), { recursive: true })
    await writeFile(join(source, "skills", "githunk-handoff", "SKILL.md"), "agent skill\n")
    await writeFile(join(source, "skills", "githunk-release", "SKILL.md"), "maintainer skill\n")

    copyBundledSkill(source, destination)

    expect(await Bun.file(join(destination, "skills", "githunk-handoff", "SKILL.md")).text()).toBe("agent skill\n")
    expect(await Bun.file(join(destination, "skills", "githunk-release", "SKILL.md")).exists()).toBe(false)
  })
})
