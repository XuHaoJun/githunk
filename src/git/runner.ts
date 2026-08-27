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
   * Keeps the command out of the Command Log pane, or forces it in. lazygit's `DontLog()`
   * (pkg/commands/oscommands/cmd_obj.go:118-128), which it sets by hand at 76 call sites (a naive
   * recursive grep for the literal text finds 80 hits; 4 of those are the declaration and its own
   * comments, cmd_obj.go:19,118,125,130) — every loader and query, plus the background fetch
   * (git_commands/sync.go:81).
   *
   * githunk defaults it from `readOnly` instead: a read is never logged and a write always is,
   * which reproduces lazygit's set as a structural invariant rather than something each new loader
   * must remember. Set this explicitly to override in either direction — `true` for a write that
   * should stay quiet (the background fetch), `false` for a read that should not. The record is
   * still returned to the caller and still raises `GitCommandError`.
   */
  readonly dontLog?: boolean
  /**
   * Writes the command's output into the log under a magenta `Git output:` heading. lazygit does
   * this for the commands it streams — the ones with a credential strategy, so push, pull and
   * foreground fetch (pkg/commands/oscommands/cmd_obj_runner.go:234-246,
   * pkg/commands/git_commands/sync.go:44,110,69) — via `getCmdWriter`
   * (pkg/gui/extras_panel.go:96-98).
   */
  readonly streamOutput?: boolean
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
    // `readOnly` marks exactly githunk's reads, so it is what decides whether the command is
    // logged, unless the caller says otherwise. Every `run()` call site in `src/git/` and
    // `src/main.ts` passes `readOnly: true` for a read and omits it for a mutation. See the
    // `dontLog` doc comment.
    const shouldLog = options.dontLog === undefined ? options.readOnly !== true : !options.dontLog
    // Before the spawn, as lazygit's pre-spawn `logCmdObj` call site is (cmd_obj_runner.go:250-252;
    // `logCmdObj` itself is :201-203): the point is to see what is running, not what has run. The
    // argv is prefixed with `git` and *not* with `--no-pager`, so the line matches what lazygit's
    // `CmdObj.ToString()` shows for the same command (its builder prepends only `git`,
    // git_commands/git_command_builder.go:141).
    if (shouldLog) this.log.logCommand(formatCommandLine(["git", ...commandArgs]), true)
    // One writer per command, so two commands' output can never share a heading. See Step 3a.
    const writer = this.log.outputWriter()
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
    const acceptedExitCodes = options.acceptedExitCodes ?? [0]
    const accepted = acceptedExitCodes.includes(exitCode)
    if (shouldLog) {
      if (options.streamOutput === true) {
        // lazygit's cmdWriter receives both streams interleaved as they arrive
        // (cmd_obj_runner.go:229-230,257). githunk buffers the whole command instead of
        // streaming it, so stdout and stderr can only be concatenated after the fact, not
        // interleaved — for push/pull this also means the block's *order* differs from lazygit's,
        // not just its timing: progress (stderr) and the summary (stdout) land as two runs rather
        // than interleaved lines. The `\n` between them is required, not cosmetic: without it,
        // whenever stdout does not itself end in a newline, its last line and stderr's first line
        // concatenate into one row instead of two. When stdout does already end in a newline (as
        // git output almost always does) this adds one blank separator row between the blocks —
        // `outputWriter().write` (command-log.ts) only collapses a *trailing* run of newlines, and
        // this one is not trailing whenever stderr is non-empty — a small price for never gluing
        // stdout's last line to stderr's first the way the bare concatenation used to.
        writer.write(`${stdout}\n${stderr}`)
      } else if (!accepted) {
        // githunk's one deviation from lazygit here, which raises an error popup instead and writes
        // nothing. githunk has no popup — a failed mutation surfaces as a pane bottomTitle — and
        // PRD 6.7 requires that command failures remain inspectable. Prefer stderr, since that is
        // where a failure is conventionally reported; fall back to stdout so a command that reports
        // failure there does not log an empty block.
        writer.write(stderr.length > 0 ? stderr : stdout)
      }
    }
    if (!accepted) {
      throw new GitCommandError(record)
    }

    return { exitCode, stdout, stderr, record }
  }
}
