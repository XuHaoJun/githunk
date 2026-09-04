import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
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

async function run(command: string, args: readonly string[], cwd: string): Promise<ProcessResult> {
  const process = Bun.spawn([command, ...args], {
    cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    Bun.readableStreamToText(process.stdout),
    Bun.readableStreamToText(process.stderr),
    process.exited,
  ])
  return { exitCode, stdout, stderr }
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe("published CLI package", () => {
  test("builds a public Node executable exposed as githunk", async () => {
    const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as Record<string, unknown>
    const bin = manifest.bin as Record<string, unknown> | undefined
    const publishConfig = manifest.publishConfig as Record<string, unknown> | undefined
    const engines = manifest.engines as Record<string, unknown> | undefined

    expect(manifest.name).toBe("@xuhaojun/githunk")
    expect(manifest.private).toBeUndefined()
    expect(manifest.license).toBe("MIT")
    expect(bin?.githunk).toBe("bin/githunk.js")
    expect(publishConfig?.access).toBe("public")
    expect(engines?.node).toBe(">=26.1.0")
    expect(manifest.files).toEqual(expect.arrayContaining(["bin", "dist/githunk.js", "README.md", "LICENSE"]))
    expect(await readFile(join(root, "bin/githunk.js"), "utf8")).toContain("--experimental-ffi")
    expect(await readFile(join(root, "README.md"), "utf8")).toContain("npm install --global @xuhaojun/githunk")
    expect(await readFile(join(root, "LICENSE"), "utf8")).toContain("MIT License")

    const build = await run("bun", ["run", "build"], root)
    expect(build).toEqual(expect.objectContaining({ exitCode: 0 }))

    const smokeDirectory = await mkdtemp(join(tmpdir(), "githunk-package-"))
    temporaryDirectories.push(smokeDirectory)
    const executable = join(root, String(bin?.githunk))
    const smoke = await run("node", [executable], smokeDirectory)
    expect(smoke.exitCode).toBe(1)
    expect(smoke.stderr).toContain("githunk: not inside a Git repository")
    expect(smoke.stderr).toContain("fatal: not a git repository")
    expect(smoke.stderr).not.toContain("Bun is not defined")
  })

  test("keeps compiled binaries and release staging out of the root tarball", async () => {
    const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as Record<string, unknown>
    const files = manifest.files as readonly string[]
    expect(files).toEqual(expect.arrayContaining(["bin", "dist/githunk.js", "README.md", "LICENSE"]))
    expect(files).not.toContain("dist")
  })

  test("maps child termination signals to conventional exit codes", async () => {
    const repository = await mkdtemp(join(tmpdir(), "githunk-package-signal-"))
    temporaryDirectories.push(repository)
    const init = await run("git", ["init", "--quiet"], repository)
    expect(init.exitCode).toBe(0)
    const build = await run("bun", ["run", "build"], root)
    expect(build.exitCode).toBe(0)

    const child = Bun.spawn(["node", join(root, "bin/githunk.js")], {
      cwd: repository,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    })
    // The wrapper launches a real renderer; a fake clock cannot tell us when signal forwarding is installed.
    await Bun.sleep(300)
    child.kill("SIGTERM")
    const [stdout, stderr, exitCode] = await Promise.all([
      Bun.readableStreamToText(child.stdout),
      Bun.readableStreamToText(child.stderr),
      child.exited,
    ])
    expect(exitCode).toBe(143)
    expect(`${stdout}${stderr}`).not.toContain("Bun is not defined")
  })
})
