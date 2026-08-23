import type { CommandRecord } from "../domain/command"
import { CommandLog } from "../app/command-log"

export type GitRunOptions = {
  readonly stdin?: string
  readonly signal?: AbortSignal
  readonly readOnly?: boolean
  readonly acceptedExitCodes?: readonly number[]
}

export type GitResult = {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
  readonly record: CommandRecord
}

export class GitCommandError extends Error {
  readonly record: CommandRecord

  constructor(record: CommandRecord) {
    super(`git ${record.args.join(" ")} failed with exit code ${record.exitCode}`)
    this.name = "GitCommandError"
    this.record = record
  }
}

type GitRunnerOptions = {
  readonly cwd?: string
  readonly log?: CommandLog
}

export class GitRunner {
  readonly cwd: string
  readonly log: CommandLog
  private nextId: number

  constructor(options?: GitRunnerOptions | string, log?: CommandLog) {
    if (typeof options === "string") {
      this.cwd = options
      this.log = log ?? new CommandLog()
    } else {
      this.cwd = options?.cwd ?? process.cwd()
      this.log = options?.log ?? new CommandLog()
    }
    this.nextId = this.log.records().reduce((max, record) => Math.max(max, record.id), 0) + 1
  }

  async run(args: readonly string[], options: GitRunOptions = {}): Promise<GitResult> {
    const commandArgs = [...args]
    const startedAt = new Date()
    const startedAtMs = Date.now()
    let stdout = ""
    let stderr = ""
    let exitCode = -1

    try {
      const env: Record<string, string> = {}
      for (const [key, value] of Object.entries(process.env)) {
        if (value !== undefined && key !== "GIT_OPTIONAL_LOCKS") {
          env[key] = value
        }
      }
      env.LC_ALL = "C"
      env.GIT_TERMINAL_PROMPT = "0"
      if (options.readOnly === true) {
        env.GIT_OPTIONAL_LOCKS = "0"
      }

      const spawnOptions: {
        cwd: string
        env: Record<string, string>
        stdin: "pipe"
        stdout: "pipe"
        stderr: "pipe"
        signal?: AbortSignal
      } = {
        cwd: this.cwd,
        env,
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      }
      if (options.signal !== undefined) {
        spawnOptions.signal = options.signal
      }

      const proc = Bun.spawn(["git", "--no-pager", ...commandArgs], spawnOptions)
      if (proc.stdin === undefined || proc.stdout === undefined || proc.stderr === undefined) {
        throw new Error("git process did not expose piped standard streams")
      }

      if (options.stdin !== undefined) {
        proc.stdin.write(options.stdin)
      }
      proc.stdin.end()
      ;[stdout, stderr, exitCode] = await Promise.all([
        Bun.readableStreamToText(proc.stdout),
        Bun.readableStreamToText(proc.stderr),
        proc.exited,
      ])
    } catch (error) {
      stderr = error instanceof Error ? error.message : String(error)
    }

    const record: CommandRecord = {
      id: this.nextId++,
      cwd: this.cwd,
      args: commandArgs,
      startedAt: startedAt.toISOString(),
      durationMs: Date.now() - startedAtMs,
      exitCode,
      stdout,
      stderr,
    }
    this.log.append(record)

    const acceptedExitCodes = options.acceptedExitCodes ?? [0]
    if (!acceptedExitCodes.includes(exitCode)) {
      throw new GitCommandError(record)
    }

    return { exitCode, stdout, stderr, record }
  }
}
