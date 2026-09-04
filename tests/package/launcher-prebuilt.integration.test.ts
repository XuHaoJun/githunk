import { afterEach, describe, expect, test } from "bun:test"
import { chmod, cp, mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))))
const temporaryDirectories: string[] = []

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
    env: { ...process.env, ...env },
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    Bun.readableStreamToText(child.stdout),
    Bun.readableStreamToText(child.stderr),
    child.exited,
  ])
  return { exitCode, stdout, stderr }
}

async function writeFakeBinary(path: string): Promise<void> {
  await Bun.write(path, `#!/bin/sh\necho "prebuilt-binary:$@"\nexit 7\n`)
  await chmod(path, 0o755)
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe("launcher prebuilt lookup", () => {
  test("prefers GITHUNK_BIN_PATH over the node bundle", async () => {
    const workdir = await mkdtemp(join(tmpdir(), "githunk-prebuilt-"))
    temporaryDirectories.push(workdir)
    const fake = join(workdir, "githunk-fake")
    await writeFakeBinary(fake)

    const child = await run("node", [join(root, "bin", "githunk.js"), "--version"], workdir, {
      GITHUNK_BIN_PATH: fake,
    })
    expect(child.exitCode).toBe(7)
    expect(child.stdout).toContain("prebuilt-binary:--version")
  })

  test("finds the platform binary installed alongside the package", async () => {
    const osToken = process.platform === "darwin" ? "darwin" : process.platform === "win32" ? "windows" : "linux"
    const cpuToken = process.arch === "arm64" ? "arm64" : "x64"
    const binaryName = process.platform === "win32" ? "githunk.exe" : "githunk"
    const fixture = await mkdtemp(join(tmpdir(), "githunk-prebuilt-"))
    temporaryDirectories.push(fixture)
    await mkdir(join(fixture, "bin"), { recursive: true })
    await cp(join(root, "bin", "githunk.js"), join(fixture, "bin", "githunk.js"))
    const installDir = join(fixture, "node_modules", "@xuhaojun", `githunk-${osToken}-${cpuToken}`, "bin")
    await mkdir(installDir, { recursive: true })
    await writeFakeBinary(join(installDir, binaryName))

    const child = await run("node", [join(fixture, "bin", "githunk.js"), "--version"], fixture, {})
    expect(child.exitCode).toBe(7)
    expect(child.stdout).toContain("prebuilt-binary:--version")
  })
})
