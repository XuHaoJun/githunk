import { describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))))

describe("compiled binary", () => {
  test("reports the package version, not the dev fallback", async () => {
    const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as { version: string }
    const workdir = await mkdtemp(join(tmpdir(), "githunk-compile-"))
    try {
      const binary = join(workdir, "githunk")
      const build = Bun.spawnSync(["bun", "build", "--compile", "src/cli.ts", "--outfile", binary], { cwd: root })
      expect(build.exitCode).toBe(0)
      const run = Bun.spawnSync([binary, "--version"], { stdout: "pipe", stderr: "pipe" })
      expect(run.exitCode).toBe(0)
      expect(run.stdout.toString()).toContain(manifest.version)
      expect(run.stdout.toString()).not.toContain("0.0.0-dev")
    } finally {
      await rm(workdir, { recursive: true, force: true })
    }
  })

  test("boots outside a git repository without node", async () => {
    const workdir = await mkdtemp(join(tmpdir(), "githunk-compile-"))
    const project = await mkdtemp(join(tmpdir(), "githunk-notgit-"))
    try {
      const binary = join(workdir, "githunk")
      expect(
        Bun.spawnSync(["bun", "build", "--compile", "src/cli.ts", "--outfile", binary], { cwd: root }).exitCode,
      ).toBe(0)
      const run = Bun.spawnSync([binary], { cwd: project, stdout: "pipe", stderr: "pipe" })
      expect(run.exitCode).toBe(1)
      expect(run.stderr.toString()).toContain("githunk: not inside a Git repository")
    } finally {
      await rm(workdir, { recursive: true, force: true })
      await rm(project, { recursive: true, force: true })
    }
  })
})
