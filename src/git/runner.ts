import { formatCommandLine, type CommandRecord } from "../domain/command"
import { CommandLog } from "../app/command-log"

export type GitRunOptions = {
  readonly stdin?: string
  readonly signal?: AbortSignal
  /**
   * Suppresses `index.lock` via `GIT_OPTIONAL_LOCKS=0`, so a read can never contend with a write.
   * lazygit sets this on *every* git command by default
   * (pkg/commands/git_cmd_obj_builder.go:35-38).
   */
  readonly readOnly?: boolean
  /**
   * Lets a read take the lock anyway, so git can persist the stat-cache it just refreshed and keep
   * later status calls fast. lazygit's one exception to the rule above: a *foreground* files
   * refresh removes the variable (pkg/commands/git_commands/file_loader.go:228-236), while a
   * background one leaves it, because not persisting the cache is the right trade-off for
   * unattended work. Ignored unless `readOnly` is set.
   */
  readonly optionalLocks?: boolean
  readonly acceptedExitCodes?: readonly number[]
  /**
   * Keeps the command out of the Command Log pane. lazygit's `DontLog()`
   * (pkg/commands/oscommands/cmd_obj.go:118-128), which it sets on the plumbing behind a rendered
   * value — the `rev-parse`/`rev-list` reachability queries that colour commit hashes, for one —
   * so a 10s background refresh cannot bury the commands the user actually ran. The record is
   * still returned to the caller and still raises `GitCommandError`.
   */
  readonly dontLog?: boolean
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
    this.nextId = 1
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
      if (options.readOnly === true && options.optionalLocks !== true) {
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
    if (options.dontLog !== true) this.log.logCommand(formatCommandLine(["git", ...commandArgs]), true)

    const acceptedExitCodes = options.acceptedExitCodes ?? [0]
    if (!acceptedExitCodes.includes(exitCode)) {
      throw new GitCommandError(record)
    }

    return { exitCode, stdout, stderr, record }
  }
}
