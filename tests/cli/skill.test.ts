import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { defaultSkillSearchRoots, resolveBundledSkillPath, runSkillCommand } from "../../src/cli/skill"

describe("bundled githunk handoff skill", () => {
  const temporaryDirectories: string[] = []

  afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
  })

  async function fixtureSkill(): Promise<{ root: string; nested: string; skillPath: string; content: string }> {
    const root = await mkdtemp(join(tmpdir(), "githunk-skill-"))
    temporaryDirectories.push(root)
    const nested = join(root, "dist", "nested")
    const skillPath = join(root, "skills", "githunk-handoff", "SKILL.md")
    const content = "---\nname: githunk-handoff\n---\n\n# Fixture skill\n"
    await mkdir(nested, { recursive: true })
    await mkdir(join(root, "skills", "githunk-handoff"), { recursive: true })
    await writeFile(skillPath, content)
    return { root, nested, skillPath, content }
  }

  test("derives the module search root from a standard file URL", () => {
    expect(defaultSkillSearchRoots("/usr/bin/node", "file:///opt/githunk/dist/githunk.js")).toEqual(["/opt/githunk/dist", "/usr/bin/node"])
  })

  test("finds the bundled skill from a nested source or package path", async () => {
    const fixture = await fixtureSkill()

    expect(resolveBundledSkillPath([fixture.nested])).toBe(fixture.skillPath)
  })

  test("finds the standalone companion skill beside the installed binary", async () => {
    const root = await mkdtemp(join(tmpdir(), "githunk-skill-standalone-"))
    temporaryDirectories.push(root)
    const binary = join(root, "githunk")
    const skillPath = join(root, "githunk-assets", "skills", "githunk-handoff", "SKILL.md")
    await mkdir(join(root, "githunk-assets", "skills", "githunk-handoff"), { recursive: true })
    await writeFile(binary, "binary")
    await writeFile(skillPath, "standalone skill\n")

    expect(resolveBundledSkillPath([binary])).toBe(skillPath)
  })

  test("skips a directory masquerading as the skill file", async () => {
    const root = await mkdtemp(join(tmpdir(), "githunk-skill-dir-"))
    temporaryDirectories.push(root)
    const nested = join(root, "nested")
    await mkdir(join(root, "skills", "githunk-handoff", "SKILL.md"), { recursive: true })
    await mkdir(nested, { recursive: true })

    const outcome = await runSkillCommand({ operation: "path", searchRoots: [nested] })
    expect(outcome.exitCode).toBe(1)
    expect(outcome.text).toContain("Could not locate")
  })

  test("path returns a readable absolute skill path", async () => {
    const fixture = await fixtureSkill()

    expect(await runSkillCommand({ operation: "path", searchRoots: [fixture.nested] })).toEqual({
      text: `${fixture.skillPath}\n`,
      exitCode: 0
    })
  })

  test("show prints the bundled skill document", async () => {
    const fixture = await fixtureSkill()

    expect(await runSkillCommand({ operation: "show", searchRoots: [fixture.nested] })).toEqual({
      text: fixture.content,
      exitCode: 0
    })
  })

  test("reports a missing packaged skill instead of printing a dead path", async () => {
    const root = await mkdtemp(join(tmpdir(), "githunk-skill-missing-"))
    temporaryDirectories.push(root)

    const outcome = await runSkillCommand({ operation: "path", searchRoots: [root] })
    expect(outcome.exitCode).toBe(1)
    expect(outcome.text).toContain("Could not locate the bundled githunk-handoff skill")
  })
})
