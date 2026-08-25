import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"

export type TempGitResult = {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
}

export type TempRepository = {
  readonly path: string
  git(args: readonly string[], stdin?: string): Promise<TempGitResult>
  write(path: string, content: string): Promise<void>
  cleanup(): Promise<void>
}

export async function createTempRepository(): Promise<TempRepository> {
  const path = await mkdtemp(join(tmpdir(), "githunk-test-"))

  const git = async (args: readonly string[], stdin?: string): Promise<TempGitResult> => {
    const proc = Bun.spawn(["git", ...args], {
      cwd: path,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
      },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    })

    if (stdin !== undefined) {
      proc.stdin.write(stdin)
    }
    proc.stdin.end()

    const [stdout, stderr, exitCode] = await Promise.all([
      Bun.readableStreamToText(proc.stdout),
      Bun.readableStreamToText(proc.stderr),
      proc.exited,
    ])
    return { exitCode, stdout, stderr }
  }

  const initialized = await git(["init", "--quiet", "--initial-branch=master"])
  if (initialized.exitCode !== 0) {
    const fallback = await git(["init", "--quiet"])
    if (fallback.exitCode !== 0) {
      await rm(path, { recursive: true, force: true })
      throw new Error(`git init failed: ${fallback.stderr} / ${initialized.stderr}`)
    }
    const renamed = await git(["branch", "-M", "master"])
    if (renamed.exitCode !== 0) {
      await rm(path, { recursive: true, force: true })
      throw new Error(`git branch -M master failed: ${renamed.stderr}`)
    }
  } else {
    // init succeeded with --initial-branch=master; nothing else needed
  }
  for (const [key, value] of [
    ["user.name", "Githunk Test"],
    ["user.email", "githunk-test@example.invalid"],
  ] as const) {
    const configured = await git(["config", key, value])
    if (configured.exitCode !== 0) {
      await rm(path, { recursive: true, force: true })
      throw new Error(`git config ${key} failed: ${configured.stderr}`)
    }
  }

  return {
    path,
    git,
    async write(relativePath: string, content: string): Promise<void> {
      const target = resolve(path, relativePath)
      if (!target.startsWith(`${path}/`)) {
        throw new Error(`refusing to write outside temporary repository: ${relativePath}`)
      }
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, content, "utf8")
    },
    async cleanup(): Promise<void> {
      await rm(path, { recursive: true, force: true })
    },
  }
}
