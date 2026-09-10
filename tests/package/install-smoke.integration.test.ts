import { afterEach, describe, expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))))
const installer = join(root, "install.sh")

const isWindows = process.platform === "win32"
const suite = isWindows ? describe.skip : describe

type ProcessResult = {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
}

async function run(
  command: string,
  args: readonly string[],
  cwd: string,
  env: Record<string, string | undefined>,
): Promise<ProcessResult> {
  const child = Bun.spawn([command, ...args], {
    cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env,
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    Bun.readableStreamToText(child.stdout),
    Bun.readableStreamToText(child.stderr),
    child.exited,
  ])
  return { exitCode, stdout, stderr }
}

async function fixtureRelease(releases: string, version: string, includeSkill = true): Promise<void> {
  const directory = join(releases, `v${version}`)
  await mkdir(join(directory, "githunk-linux-x64"), { recursive: true })
  await writeFile(join(directory, "githunk-linux-x64", "githunk"), `#!/bin/sh\necho "${version}"\n`)
  await chmod(join(directory, "githunk-linux-x64", "githunk"), 0o755)
  if (includeSkill) {
    await mkdir(join(directory, "githunk-linux-x64", "skills", "githunk-handoff"), { recursive: true })
    await writeFile(
      join(directory, "githunk-linux-x64", "skills", "githunk-handoff", "SKILL.md"),
      `skill ${version}\n`,
    )
  }
  const tar = Bun.spawnSync(["tar", "-czf", "githunk-linux-x64.tar.gz", "githunk-linux-x64"], {
    cwd: directory,
    stdout: "ignore",
    stderr: "pipe",
  })
  expect(tar.exitCode).toBe(0)
  const sum = Bun.spawnSync(["sha256sum", "githunk-linux-x64.tar.gz"], {
    cwd: directory,
    stdout: "pipe",
    stderr: "pipe",
  })
  expect(sum.exitCode).toBe(0)
  await writeFile(join(directory, "SHA256SUMS"), sum.stdout.toString())
}

suite("install.sh", () => {
  const temporaryDirectories: string[] = []
  afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
  })

  async function setup(): Promise<{ home: string; releases: string; workdir: string }> {
    const home = await mkdtemp(join(tmpdir(), "githunk-inst-home-"))
    const releases = await mkdtemp(join(tmpdir(), "githunk-inst-releases-"))
    const workdir = await mkdtemp(join(tmpdir(), "githunk-inst-work-"))
    temporaryDirectories.push(home, releases, workdir)
    await fixtureRelease(releases, "9.9.9")
    return { home, releases, workdir }
  }

  function installerEnv(home: string, releases: string): Record<string, string> {
    return {
      PATH: "/usr/bin:/bin:/usr/local/bin",
      HOME: home,
      GITHUNK_RELEASE_BASE: `file://${releases}`,
    }
  }

  test("installs the release binary into ~/.local/bin and wires PATH", async () => {
    const { home, releases, workdir } = await setup()
    await writeFile(join(home, ".bashrc"), "# fixture rc\n")

    const install = await run("sh", [installer, "9.9.9"], workdir, installerEnv(home, releases))
    expect(install.exitCode).toBe(0)
    expect(`${install.stdout}${install.stderr}`).toContain(join(home, ".local", "bin", "githunk"))

    const installed = join(home, ".local", "bin", "githunk")
    const version = await run(installed, ["--version"], workdir, installerEnv(home, releases))
    expect(version.exitCode).toBe(0)
    expect(version.stdout.trim()).toBe("9.9.9")

    const rc = await Bun.file(join(home, ".bashrc")).text()
    expect(rc).toContain(join(home, ".local", "bin"))

    const installedSkill = join(
      home,
      ".local",
      "bin",
      "githunk-assets",
      "skills",
      "githunk-handoff",
      "SKILL.md",
    )
    expect(await Bun.file(installedSkill).text()).toBe("skill 9.9.9\n")
  })

  test("installs historical archives that predate the bundled skill", async () => {
    const { home, releases, workdir } = await setup()
    await fixtureRelease(releases, "8.8.8", false)
    const env = installerEnv(home, releases)

    const install = await run("sh", [installer, "8.8.8", "--no-modify-path"], workdir, env)
    expect(install.exitCode, `${install.stdout}${install.stderr}`).toBe(0)
    expect(`${install.stdout}${install.stderr}`).toContain("does not include the bundled handoff skill")

    const installed = join(home, ".local", "bin", "githunk")
    const version = await run(installed, ["--version"], workdir, env)
    expect(version.stdout.trim()).toBe("8.8.8")
  })

  test("reinstalling the current version is a no-op", async () => {
    const { home, releases, workdir } = await setup()
    const env = installerEnv(home, releases)
    expect((await run("sh", [installer, "9.9.9"], workdir, env)).exitCode).toBe(0)
    const again = await run("sh", [installer, "9.9.9"], workdir, env)
    expect(again.exitCode).toBe(0)
    expect(`${again.stdout}${again.stderr}`).toMatch(/already|up to date|current/i)
  })

  test("reinstalling the current version repairs a missing skill", async () => {
    const { home, releases, workdir } = await setup()
    const env = installerEnv(home, releases)
    expect((await run("sh", [installer, "9.9.9"], workdir, env)).exitCode).toBe(0)
    await rm(join(home, ".local", "bin", "githunk-assets", "skills", "githunk-handoff", "SKILL.md"), { force: true })

    const repair = await run("sh", [installer, "9.9.9"], workdir, env)
    expect(repair.exitCode).toBe(0)
    expect(`${repair.stdout}${repair.stderr}`).toMatch(/repairing|Installing to/)
    expect(
      await Bun.file(join(home, ".local", "bin", "githunk-assets", "skills", "githunk-handoff", "SKILL.md")).text(),
    ).toBe("skill 9.9.9\n")
  })

  test("--no-modify-path leaves shell startup files alone", async () => {
    const { home, releases, workdir } = await setup()
    await writeFile(join(home, ".bashrc"), "# fixture rc\n")

    const install = await run("sh", [installer, "9.9.9", "--no-modify-path"], workdir, installerEnv(home, releases))
    expect(install.exitCode).toBe(0)
    expect(await Bun.file(join(home, ".bashrc")).text()).toBe("# fixture rc\n")
  })
})
