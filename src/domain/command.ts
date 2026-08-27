export type CommandRecord = {
  readonly id: number
  readonly cwd: string
  readonly args: readonly string[]
  readonly startedAt: string
  readonly durationMs: number
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
}

/**
 * The roles lazygit's command log paints in. `action` is `LogAction`'s yellow label; `command` and
 * `internal` are `LogCommand`'s two cases — the default text colour for a string you could paste
 * into a shell, magenta for one you could not (pkg/gui/command_log_panel.go:41,51-56).
 * `output-heading` and `output` are the `prefixWriter`'s magenta `Git output:` and the raw output
 * under it (pkg/gui/extras_panel.go:97). `intro`, `tip-label` and `tip` are the startup header's
 * cyan line and its yellow/green random tip (pkg/gui/command_log_panel.go:75,81-82).
 */
export type CommandLogStyle =
  | "action"
  | "command"
  | "internal"
  | "output-heading"
  | "output"
  | "intro"
  | "tip-label"
  | "tip"

export type CommandLogSpan = {
  readonly style: CommandLogStyle
  readonly text: string
}

/**
 * One *logical* line of the log. The pane lets OpenTUI wrap it, so a single line can occupy several
 * visual rows; `src/ui/panes/command-log-text.ts` maps back through `lineInfo.lineSources`.
 */
export type CommandLogLine = {
  readonly id: number
  readonly spans: readonly CommandLogSpan[]
}

/**
 * lazygit's `CmdObj.ToString()` (pkg/commands/oscommands/cmd_obj.go:64-75): join the argv with
 * spaces, wrapping an argument in double quotes only when it contains a space. Quotes and
 * backslashes inside an argument are left alone, so the result is not always something a shell
 * would parse back identically — lazygit accepts that (its own comment says so) because the string
 * is for reading, and matching it is what parity means here.
 */
export function formatCommandLine(argv: readonly string[]): string {
  return argv.map((arg) => (arg.includes(" ") ? `"${arg}"` : arg)).join(" ")
}
