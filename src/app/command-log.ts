import type { CommandLogLine, CommandLogSpan, CommandLogStyle } from "../domain/command"

/** `Tr.GitOutput` (pkg/i18n/english.go:1977). */
const GIT_OUTPUT_HEADING = "Git output:"

/**
 * lazygit's `prefixWriter` (pkg/gui/extras_panel.go:100-119): the first write emits the magenta
 * `Git output:` heading, later writes do not. One of these per command, exactly as `getCmdWriter()`
 * hands out a fresh one per command (`:96-97`) — so two commands' output can never end up under a
 * single heading.
 */
export type CommandLogOutputWriter = {
  write(text: string): void
}

/**
 * The command log is lazygit's `extras` view: an append-only stream of styled lines, not a list of
 * command records.
 *
 * lazygit keeps two halves — a plain `gui.GuiLog []string` for its own assertions, and gocui's
 * attributed line buffer, written to with `fmt.Fprint` of pre-styled strings
 * (pkg/gui/command_log_panel.go:40-41,64-65). This holds both in one list of logical lines carrying
 * their own spans, which is the same shape: append-only, never reparsed. Accumulating an ANSI
 * string and reparsing it on each append would be O(total) per write, which gocui is not.
 *
 * Every write here is one or more *logical* lines. Wrapping is the pane's business, because only
 * the pane knows its width — see src/ui/panes/command-log-text.ts.
 */
export class CommandLog {
  private readonly lineList: CommandLogLine[] = []
  private lineId = 0
  /**
   * How many *arming* writes the log has taken, ever. lazygit assigns `Autoscroll = true` inside
   * `LogAction` and `LogCommand` (pkg/gui/command_log_panel.go:38,62) and nowhere else — not in the
   * per-command output writer (pkg/gui/extras_panel.go:109-119), not in the header
   * (command_log_panel.go:70-85) — so the flag is armed at write time, before anything can observe
   * it.
   *
   * githunk's view cannot observe writes, only the `AppModel` snapshots they land in, and one
   * controller action produces many snapshots but exactly one `view.update`
   * (src/app/create-app.ts:246). So "the kind of the most recent write" is lossy: a mutation logs
   * its command line and then its output, which makes the output the batch's last write and drops
   * the arm. A count is not lossy — the view arms whenever the count it sees exceeds the count it
   * last saw, which is idempotent, order-independent and immune to how many snapshots a batch
   * takes. Monotonic and never reset, because 42 `commandLogSnapshot()` call sites read it per
   * action and any consume-and-reset design would be drained by the wrong reader.
   */
  private arms = 0

  lines(): readonly CommandLogLine[] {
    return this.lineList
  }

  /** See `arms`: the number of writes that armed lazygit's `Autoscroll`, monotonic. */
  autoscrollArms(): number {
    return this.arms
  }

  /**
   * lazygit `LogAction` (pkg/gui/command_log_panel.go:25-44). Yellow and not indented: an action
   * groups the commands logged under it, typically one but sometimes several.
   */
  logAction(action: string): void {
    this.arms += 1
    for (const text of action.split("\n")) this.push([{ style: "action", text }])
  }

  /**
   * lazygit `LogCommand` (pkg/gui/command_log_panel.go:46-68). Indented two spaces under its
   * action, in the default text colour when `commandLine` — something the user could paste into a
   * shell — and magenta when not, "to communicate that" in lazygit's words.
   */
  logCommand(cmdStr: string, commandLine: boolean): void {
    this.arms += 1
    const style: CommandLogStyle = commandLine ? "command" : "internal"
    // `"  " + strings.ReplaceAll(cmdStr, "\n", "\n  ")` (command_log_panel.go:57).
    for (const text of `  ${cmdStr.replaceAll("\n", "\n  ")}`.split("\n")) this.push([{ style, text }])
  }

  /** lazygit's `getCmdWriter()` (pkg/gui/extras_panel.go:96-98): a fresh writer per command. */
  outputWriter(): CommandLogOutputWriter {
    let prefixWritten = false
    return {
      write: (text: string): void => {
        if (text.length === 0) return
        if (!prefixWritten) {
          prefixWritten = true
          // The `\n\n` of lazygit's prefix: one line ends, one blank line, then the heading.
          this.push([])
          this.push([{ style: "output-heading", text: GIT_OUTPUT_HEADING }])
        }
        // Trailing blank lines only: git's output almost always ends in a newline, and an empty
        // final row under the heading reads as a rendering bug. Interior blanks are the command's.
        for (const line of text.replace(/\n+$/, "").split("\n")) this.push([{ style: "output", text: line }])
      },
    }
  }

  /**
   * The cyan intro of `printCommandLogHeader` (pkg/gui/command_log_panel.go:70-76). The blank line
   * after it is `CommandLogHeader`'s own trailing `\n` plus `Fprintln`'s
   * (pkg/i18n/english.go:1951).
   */
  logIntro(text: string): void {
    this.push([{ style: "intro", text }])
    this.push([])
  }

  /**
   * `fmt.Fprintf(view, "%s: %s", FgYellow(Tr.RandomTip), FgGreen(tip))`
   * (pkg/gui/command_log_panel.go:78-83): one line, two colours, no trailing newline — the next
   * write supplies it, because `LogAction`/`LogCommand` prefix rather than suffix theirs.
   */
  logTip(label: string, tip: string): void {
    const [first, ...rest] = tip.split("\n")
    this.push([
      { style: "tip-label", text: `${label}: ` },
      { style: "tip", text: first ?? "" },
    ])
    for (const text of rest) this.push([{ style: "tip", text }])
  }

  private push(spans: readonly CommandLogSpan[]): void {
    this.lineList.push({ id: ++this.lineId, spans })
  }
}
