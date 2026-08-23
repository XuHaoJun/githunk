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
        GIT_AUTHOR_NAME: "Githunk Test",
        GIT_AUTHOR_EMAIL: "githunk-test@example.invalid",
        GIT_COMMITTER_NAME: "Githunk Test",
        GIT_COMMITTER_EMAIL: "githunk-test@example.invalid",
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

  const initialized = await git(["init", "--quiet"])
  if (initialized.exitCode !== 0) {
    await rm(path, { recursive: true, force: true })
    throw new Error(`git init failed: ${initialized.stderr}`)
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
