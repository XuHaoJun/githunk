# Lazygit Command Log Parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace githunk's `CommandRecord`-list command log with lazygit's action/command stream, and make what reaches the log match lazygit's `DontLog()` set.

**Architecture:** `CommandLog` becomes an append-only list of styled logical lines with lazygit's write API (`logAction` / `logCommand` / `logOutput` / `logIntro` / `logTip`). `GitRunner` logs the command it is about to run and treats `readOnly: true` as implying `dontLog`, which reproduces lazygit's 80 `DontLog()` calls as one rule. `AppController` emits lazygit's action labels before each mutation. The pane lets OpenTUI wrap and paints colour per visual row through `text.lineInfo.lineSources`, following `src/ui/panes/diff-text.ts`.

**Tech Stack:** Bun, TypeScript (`strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`), `@opentui/core` pinned to `0.5.6`, `bun:test`.

**Spec:** `docs/superpowers/specs/2026-08-26-lazygit-command-log-parity-design.md`

## Global Constraints

- **No new runtime dependencies.** `@opentui/core@0.5.6` is the only one.
- **`bun run check` (`tsc --noEmit && bun test`) must pass at the end of every task.** Never commit red.
- **`strict` TypeScript with `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`.** Use the existing `...(x === undefined ? {} : { x })` spread idiom for optional fields rather than loosening the compiler. Indexed access yields `T | undefined`; handle it or use `!` only where an invariant is stated in a comment.
- **Prefer `readonly` fields and `readonly T[]` parameters.**
- **`src/domain` and `src/git` never import from `src/ui`. `src/ui` never spawns git.**
- **Every parity behaviour carries a `file:line` citation into `learn-projects/lazygit` in the code comment *and* the commit message.** Run `git submodule update --init` if `learn-projects/lazygit` is empty.
- **Commit prefixes:** `feat:` / `fix:` / `refactor:` / `perf:` / `test:` / `docs:`, lowercase summary, body explaining *why lazygit does it that way* with citations.
- **`panes/pane-text.ts` is the only file allowed to touch OpenTUI internals.** New painting code goes through `paneTextBuffer`.
- **Commit message trailer:** end every commit body with `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`.

## File Structure

**Created:**

| File | Responsibility |
| --- | --- |
| `src/app/log-actions.ts` | The action-label strings, copied from `pkg/i18n/english.go:2128-2254`. Data only. |
| `src/app/command-log-tips.ts` | The random-tip catalogue and `randomTip(pick)`. Data plus one pure function. |
| `src/ui/panes/command-log-text.ts` | Installs the log text and paints colour per visual row. Mirrors `diff-text.ts`. |
| `src/ui/panes/command-log-scroll.ts` | `autoscrollAfter(current, input)` — lazygit's `view.Autoscroll` transitions as a pure function. |
| `src/ui/action-menu.ts` | A titled, keyed, actionable modal menu. `renderActionMenuLines` is the pure half. |
| `tests/domain/command-line.test.ts` | `formatCommandLine`. |
| `tests/app/command-log.test.ts` | The `CommandLog` write API. |
| `tests/app/log-actions.test.ts` | Labels emitted per `AppController` mutation. |
| `tests/app/command-log-tips.test.ts` | Tip catalogue invariants. |
| `tests/ui/command-log-text.test.ts` | `commandLogRowHighlights`. |
| `tests/ui/command-log-scroll.test.ts` | The autoscroll state machine. |
| `tests/ui/action-menu.test.ts` | `renderActionMenuLines`. |
| `tests/acceptance/command-log.integration.test.ts` | End-to-end: labels present, loader commands absent. |

**Modified:**

| File | Change |
| --- | --- |
| `src/domain/command.ts` | Adds `CommandLogStyle` / `CommandLogSpan` / `CommandLogLine` / `formatCommandLine`. |
| `src/domain/repository.ts:70` | `commandLog` retyped to `readonly CommandLogLine[]`. |
| `src/app/command-log.ts` | Rewritten as the styled line stream. |
| `src/app/controller.ts` | `log.records()` → `log.lines()` (about 20 sites); action labels; `fetch` background flag. |
| `src/app/create-app.ts` | Header seeding; `{ background: true }` on the background fetch; `createGhRunner` call. |
| `src/git/runner.ts` | `readOnly` implies `dontLog`; `logCommand` before spawn; `streamOutput`; failure output. |
| `src/git/sync.ts` | `fetch` takes `{ background?: boolean }`; push/pull/fetch pass `streamOutput`. |
| `src/git/github.ts` | `createGhRunner` stops logging. |
| `src/ui/panes/command-log-pane.ts` | Consumes `CommandLogLine[]`; `wrapMode: "char"`; autoscroll; title. |
| `src/ui/bindings.ts` | `command-log` context bindings; `command-log` action becomes the menu. |
| `src/ui/focus.ts` | `handleKey`'s `@` branch removed. |
| `src/ui/layout.ts` | `DEFAULT_LOG_HEIGHT` 10; focused-fill and short-terminal branches. |
| `src/ui/ui-state-store.ts` | `commandLogVisible` defaults to `true`. |
| `src/ui/root-view.ts` | Action menu wiring, autoscroll dispatch, `logVisible` default. |
| `tests/git/runner.test.ts` | `records()` assertions → `lines()`. |
| `tests/git/sync.integration.test.ts:27` | `records()` assertion → `lines()`. |
| `tests/ui/command-log-pane.test.ts` | `tailCommandLogLines` test deleted with the function. |
| `docs/lazygit-compatibility-v0.1.md` | Row 13 split. |

---

### Task 1: Display types and `formatCommandLine`

**Files:**
- Modify: `src/domain/command.ts`
- Test: `tests/domain/command-line.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `CommandLogStyle`, `CommandLogSpan` (`{ readonly style: CommandLogStyle; readonly text: string }`), `CommandLogLine` (`{ readonly id: number; readonly spans: readonly CommandLogSpan[] }`), `formatCommandLine(argv: readonly string[]): string`.

- [ ] **Step 1: Write the failing test**

Create `tests/domain/command-line.test.ts`:

```ts
import { describe, expect, test } from "bun:test"
import { formatCommandLine } from "../../src/domain/command"

/**
 * lazygit's `CmdObj.ToString()` (pkg/commands/oscommands/cmd_obj.go:64-75) is deliberately not
 * shell-correct: it wraps an argument in double quotes when it contains a space and otherwise
 * leaves it exactly as it is. These tests pin that, including the cases where it is "wrong",
 * because being wrong the same way lazygit is wrong is the requirement.
 */
describe("formatCommandLine", () => {
  test("joins the argv with spaces and quotes nothing that has no space", () => {
    expect(formatCommandLine(["git", "add", "--", "a.ts"])).toBe("git add -- a.ts")
  })

  test("quotes only the arguments that contain a space", () => {
    expect(formatCommandLine(["git", "add", "--", "my file.ts"])).toBe(`git add -- "my file.ts"`)
    expect(formatCommandLine(["git", "commit", "-F", "-"])).toBe("git commit -F -")
  })

  test("does not escape quotes or backslashes, as ToString does not", () => {
    expect(formatCommandLine(["git", "commit", "-m", `say "hi" now`])).toBe(`git commit -m "say "hi" now"`)
    expect(formatCommandLine(["git", "log", String.raw`--format=%B\n`])).toBe(String.raw`git log --format=%B\n`)
  })

  test("keeps an empty argument as an empty token", () => {
    expect(formatCommandLine(["git", "commit", "-m", ""])).toBe("git commit -m ")
  })

  test("returns an empty string for an empty argv", () => {
    expect(formatCommandLine([])).toBe("")
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/domain/command-line.test.ts`
Expected: FAIL — `formatCommandLine is not a function` (or a TS resolution error on the import).

- [ ] **Step 3: Write minimal implementation**

Append to `src/domain/command.ts`:

```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/domain/command-line.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Typecheck and commit**

Run: `bun run typecheck`
Expected: no output, exit 0.

```bash
git add src/domain/command.ts tests/domain/command-line.test.ts
git commit -m "$(cat <<'EOF'
feat: add command log line types and lazygit's command formatter

The command log pane currently builds its argv text with
JSON.stringify per argument (src/ui/panes/command-log-pane.ts:20-25), which
quotes every argument and escapes backslashes. lazygit's CmdObj.ToString()
(pkg/commands/oscommands/cmd_obj.go:64-75) quotes an argument only when it
contains a space and escapes nothing, and says in its own comment that the
result is not always what you would type into a terminal. Matching that is the
requirement, so the tests pin the cases where it is deliberately not
shell-correct.

CommandLogStyle enumerates the roles lazygit paints: LogAction's yellow label
and LogCommand's default-colour/magenta pair (pkg/gui/command_log_panel.go:41,
51-56), the prefixWriter's magenta `Git output:` heading over unstyled output
(pkg/gui/extras_panel.go:97), and the startup header's cyan line with its
yellow/green tip (pkg/gui/command_log_panel.go:75,81-82).

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: `CommandLog` becomes the styled line stream

This task removes `CommandLog.records()`, so it must also migrate every consumer or the build goes red. That is why the model retype, the controller's ~20 call sites and the pane's `update` signature are all here. The pane still renders in one colour at the end of this task; Task 5 adds colour.

**Files:**
- Modify: `src/app/command-log.ts` (rewritten)
- Modify: `src/domain/repository.ts:70`
- Modify: `src/git/runner.ts:57,67,127-137`
- Modify: `src/git/github.ts:126-170`
- Modify: `src/app/create-app.ts:75`
- Modify: `src/app/controller.ts` (every `log.records()`)
- Modify: `src/ui/panes/command-log-pane.ts`
- Modify: `tests/git/runner.test.ts:26,27,50,51,60`
- Modify: `tests/git/sync.integration.test.ts:27`
- Delete: `tests/ui/command-log-pane.test.ts`
- Test: `tests/app/command-log.test.ts`

**Interfaces:**
- Consumes: `CommandLogLine`, `CommandLogSpan`, `CommandLogStyle` from Task 1.
- Produces: `CommandLog` with `lines(): readonly CommandLogLine[]`, `logAction(action: string): void`, `logCommand(cmdStr: string, commandLine: boolean): void`, `logOutput(text: string): void`, `logIntro(text: string): void`, `logTip(label: string, tip: string): void`. `AppModel.commandLog: readonly CommandLogLine[]`. `CommandLogPaneHandle.update(lines: readonly CommandLogLine[]): void`.

- [ ] **Step 1: Write the failing test**

Create `tests/app/command-log.test.ts`:

```ts
import { describe, expect, test } from "bun:test"
import { CommandLog } from "../../src/app/command-log"
import type { CommandLogLine } from "../../src/domain/command"

function texts(lines: readonly CommandLogLine[]): readonly string[] {
  return lines.map((line) => line.spans.map((span) => span.text).join(""))
}

function styles(lines: readonly CommandLogLine[]): readonly string[] {
  return lines.map((line) => line.spans.map((span) => span.style).join("+"))
}

describe("CommandLog", () => {
  test("starts empty", () => {
    expect(new CommandLog().lines()).toEqual([])
  })

  /** lazygit `LogAction` (pkg/gui/command_log_panel.go:25-44): yellow, not indented. */
  test("logAction adds one unindented yellow-role line", () => {
    const log = new CommandLog()
    log.logAction("Stage file")
    expect(texts(log.lines())).toEqual(["Stage file"])
    expect(styles(log.lines())).toEqual(["action"])
  })

  /**
   * lazygit `LogCommand` (pkg/gui/command_log_panel.go:46-68): two-space indent, and every embedded
   * newline is indented too via `strings.ReplaceAll(cmdStr, "\n", "\n  ")`.
   */
  test("logCommand indents by two spaces, including embedded newlines", () => {
    const log = new CommandLog()
    log.logCommand("git add -- a.ts", true)
    log.logCommand("pick abc\npick def", false)
    expect(texts(log.lines())).toEqual(["  git add -- a.ts", "  pick abc", "  pick def"])
  })

  test("logCommand picks the command role when it is shell-runnable and internal when it is not", () => {
    const log = new CommandLog()
    log.logCommand("git push", true)
    log.logCommand("Restoring file to previous state", false)
    expect(styles(log.lines())).toEqual(["command", "internal"])
  })

  /**
   * lazygit's `prefixWriter` writes `style.FgMagenta.Sprintf("\n\n%s\n", Tr.GitOutput)` before the
   * first write for a command and never again (pkg/gui/extras_panel.go:97,100-119).
   */
  test("logOutput writes a blank line and the heading once per command", () => {
    const log = new CommandLog()
    log.logCommand("git push", true)
    log.logOutput("Enumerating objects: 3\n")
    log.logOutput("To github.com:o/r.git\n")
    expect(texts(log.lines())).toEqual([
      "  git push",
      "",
      "Git output:",
      "Enumerating objects: 3",
      "To github.com:o/r.git",
    ])
    expect(styles(log.lines())).toEqual(["command", "", "output-heading", "output", "output"])
  })

  test("logOutput writes the heading again for the next command", () => {
    const log = new CommandLog()
    log.logCommand("git push", true)
    log.logOutput("one\n")
    log.logCommand("git pull", true)
    log.logOutput("two\n")
    expect(texts(log.lines()).filter((text) => text === "Git output:")).toHaveLength(2)
  })

  test("logOutput ignores empty output and trims only trailing blank lines", () => {
    const log = new CommandLog()
    log.logCommand("git push", true)
    log.logOutput("")
    expect(texts(log.lines())).toEqual(["  git push"])
    log.logOutput("a\n\nb\n\n\n")
    expect(texts(log.lines())).toEqual(["  git push", "", "Git output:", "a", "", "b"])
  })

  /** lazygit `printCommandLogHeader` (pkg/gui/command_log_panel.go:70-85). */
  test("logIntro adds the cyan line and the blank line after it", () => {
    const log = new CommandLog()
    log.logIntro("You can hide/focus this panel by pressing '@'")
    expect(texts(log.lines())).toEqual(["You can hide/focus this panel by pressing '@'", ""])
    expect(styles(log.lines())).toEqual(["intro", ""])
  })

  test("logTip puts the label and the tip in one line as two spans", () => {
    const log = new CommandLog()
    log.logTip("Random tip", "Press '@' to hide this")
    expect(log.lines()).toHaveLength(1)
    expect(log.lines()[0]?.spans).toEqual([
      { style: "tip-label", text: "Random tip: " },
      { style: "tip", text: "Press '@' to hide this" },
    ])
  })

  test("logTip keeps a multi-line tip's later lines in the tip role", () => {
    const log = new CommandLog()
    log.logTip("Random tip", "first\nsecond")
    expect(texts(log.lines())).toEqual(["Random tip: first", "second"])
    expect(styles(log.lines())).toEqual(["tip-label+tip", "tip"])
  })

  test("gives every line a distinct id so the pane can detect an append", () => {
    const log = new CommandLog()
    log.logAction("Commit")
    log.logCommand("git commit -F -", true)
    const ids = log.lines().map((line) => line.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  test("lines() hands back the live list, so callers must not mutate it", () => {
    const log = new CommandLog()
    const first = log.lines()
    log.logAction("Push")
    expect(first).toBe(log.lines())
    expect(log.lines()).toHaveLength(1)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/app/command-log.test.ts`
Expected: FAIL — `log.logAction is not a function`.

- [ ] **Step 3: Rewrite `src/app/command-log.ts`**

Replace the whole file with:

```ts
import type { CommandLogLine, CommandLogSpan, CommandLogStyle } from "../domain/command"

/** `Tr.GitOutput` (pkg/i18n/english.go:1977). */
const GIT_OUTPUT_HEADING = "Git output:"

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
   * Cleared by each `logCommand` so the `Git output:` heading prints once per command, which is
   * what lazygit's `prefixWriter.prefixWritten` does (pkg/gui/extras_panel.go:103-117).
   */
  private outputHeadingWritten = false

  lines(): readonly CommandLogLine[] {
    return this.lineList
  }

  /**
   * lazygit `LogAction` (pkg/gui/command_log_panel.go:25-44). Yellow and not indented: an action
   * groups the commands logged under it, typically one but sometimes several.
   */
  logAction(action: string): void {
    for (const text of action.split("\n")) this.push([{ style: "action", text }])
  }

  /**
   * lazygit `LogCommand` (pkg/gui/command_log_panel.go:46-68). Indented two spaces under its
   * action, in the default text colour when `commandLine` — something the user could paste into a
   * shell — and magenta when not, "to communicate that" in lazygit's words.
   */
  logCommand(cmdStr: string, commandLine: boolean): void {
    this.outputHeadingWritten = false
    const style: CommandLogStyle = commandLine ? "command" : "internal"
    // `"  " + strings.ReplaceAll(cmdStr, "\n", "\n  ")` (command_log_panel.go:57).
    for (const text of `  ${cmdStr.replaceAll("\n", "\n  ")}`.split("\n")) this.push([{ style, text }])
  }

  /**
   * lazygit's `getCmdWriter` / `prefixWriter` (pkg/gui/extras_panel.go:96-119): a magenta
   * `\n\nGit output:\n` before the first write for a command, then the output itself unstyled.
   *
   * lazygit streams this while the command runs. `GitRunner` buffers, so githunk writes it once the
   * command has finished; the resulting log text is the same, it just arrives all at once.
   */
  logOutput(text: string): void {
    if (text.length === 0) return
    if (!this.outputHeadingWritten) {
      this.outputHeadingWritten = true
      // The `\n\n` of the prefix: one line ends, one blank line, then the heading.
      this.push([])
      this.push([{ style: "output-heading", text: GIT_OUTPUT_HEADING }])
    }
    // Trailing blank lines only: git's output almost always ends in a newline, and an empty final
    // row under the heading reads as a rendering bug. Interior blanks are the command's own.
    for (const line of text.replace(/\n+$/, "").split("\n")) this.push([{ style: "output", text: line }])
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/app/command-log.test.ts`
Expected: PASS, 12 tests.

- [ ] **Step 5: Retype the model**

In `src/domain/repository.ts`, change the import and line 70:

```ts
// was: import type { CommandRecord } from "./command"
import type { CommandLogLine } from "./command"
```

```ts
  readonly commandLog: readonly CommandLogLine[]
```

If `CommandRecord` is still used elsewhere in that file, keep both names on the import.

- [ ] **Step 6: Point `GitRunner` at the new API**

In `src/git/runner.ts`:

Replace the id bookkeeping in the constructor — `CommandLog` no longer tracks record ids, and a
runner's records are its own:

```ts
    // was: this.nextId = this.log.records().reduce((max, record) => Math.max(max, record.id), 0) + 1
    this.nextId = 1
```

Then, still in `run()`, replace the `log.append(record)` line:

```ts
    // was: if (options.dontLog !== true) this.log.append(record)
    if (options.dontLog !== true) this.log.logCommand(formatCommandLine(["git", ...commandArgs]), true)
```

and add the import:

```ts
import { formatCommandLine, type CommandRecord } from "../domain/command"
```

Task 3 moves this call to *before* the spawn and adds the `readOnly` rule; keeping it here for now
is what makes this task's build green on its own.

- [ ] **Step 7: Stop `createGhRunner` logging**

In `src/git/github.ts`, replace the doc comment and signature at lines 125-130 and delete the
logging block at 153-167:

```ts
/**
 * A `gh` runner. `gh pr list` is a background query — only the background refresh drives it — and
 * lazygit keeps queries out of the command log entirely (80 `DontLog()` calls, e.g.
 * pkg/commands/git_commands/status.go:98). So this deliberately does not log, and the log stays
 * what lazygit's is: the user's own actions.
 */
export function createGhRunner(cwd: string): GhRunner {
```

Delete `let fallbackId = 1_000_000` and the whole `if (log !== undefined) { … }` block, and drop the
now-unused `CommandLog` and `CommandRecord` imports if nothing else in the file uses them.

In `src/app/create-app.ts:75`:

```ts
  const ghRunner = options.background?.enabled === true ? createGhRunner(options.repositoryRoot) : undefined
```

- [ ] **Step 8: Migrate the controller's `records()` calls**

Every `this.runner?.log.records()` in `src/app/controller.ts` becomes `this.runner?.log.lines()`.
There are about 20; do them mechanically:

```bash
sed -i 's/log\.records()/log.lines()/g' src/app/controller.ts
grep -c 'log\.lines()' src/app/controller.ts
```

Expected: a count around 20, and `grep -rn 'log\.records()' src/` returns nothing.

- [ ] **Step 9: Make the pane consume lines**

In `src/ui/panes/command-log-pane.ts`: delete `escapeArg`, `formatRecord` and
`tailCommandLogLines` (lines 20-49), change the `CommandRecord` import to `CommandLogLine`, and
replace the handle's `update` and the `createCommandLogPane` signature:

```ts
export type CommandLogPaneHandle = {
  // …unchanged members…
  update(lines: readonly CommandLogLine[]): void
}
```

```ts
export function createCommandLogPane(renderer: CliRenderer, lines: readonly CommandLogLine[]): CommandLogPaneHandle {
```

```ts
    update(nextLines: readonly CommandLogLine[]) {
      // `CommandLog.lines()` hands back the same array it appends to, so identity cannot detect a
      // new line. The count plus the newest line's identity can, and skipping an unchanged log is
      // what keeps it off the cost of every layout pass and refresh.
      if (rendered !== undefined && rendered.count === nextLines.length && rendered.newest === nextLines[nextLines.length - 1]) return
      rendered = { count: nextLines.length, newest: nextLines[nextLines.length - 1] }
      setPlainPaneText(text, nextLines.map((line) => line.spans.map((span) => span.text).join("")).join("\n"))
      text.scrollY = text.maxScrollY
      syncVerticalScrollbar(bar, text)
    },
```

and retype the `rendered` cache:

```ts
  let rendered: { readonly count: number; readonly newest: CommandLogLine | undefined } | undefined
```

Leave the placeholder text: change `content: "No commands recorded"` to `content: ""` and drop the
`nextLines.length === 0 ? "No commands recorded" : …` conditional — Task 13 seeds a header, so an
empty log is a transient state, and lazygit shows no placeholder.

- [ ] **Step 10: Migrate the tests**

Delete the obsolete pane test:

```bash
git rm tests/ui/command-log-pane.test.ts
```

In `tests/git/runner.test.ts`, replace the four `log.records()` assertions:

```ts
    // line 26-27
    expect(log.lines()).toHaveLength(1)
    expect(log.lines()[0]?.spans.map((span) => span.text).join("")).toBe("  git rev-parse --show-toplevel")
```

```ts
    // line 50-51: a rejected exit still logs the command it ran
    expect(log.lines()).toHaveLength(1)
    expect(log.lines()[0]?.spans.map((span) => span.text).join("")).toBe("  git rev-parse --verify missing-ref")
```

```ts
    // line 60
    expect(log.lines()).toHaveLength(1)
```

The `stderr` assertion on line 51 moves to Task 3, which is where failure output starts reaching the
log; drop it here.

In `tests/git/sync.integration.test.ts:27`:

```ts
        expect(runner.log.lines().at(-1)?.spans.map((span) => span.text).join("")).toBe(`  git pull origin ${branch}`)
```

- [ ] **Step 11: Run the gate**

Run: `bun run check`
Expected: `tsc --noEmit` silent, all tests pass. If `tsc` reports an unused import in
`src/git/github.ts` or `src/domain/repository.ts`, remove it.

- [ ] **Step 12: Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
refactor: make the command log a styled line stream

CommandLog was a CommandRecord list and the pane formatted each record into an
ISO timestamp, a JSON-quoted argv, `exit N Xms` and whole stdout/stderr blocks
(src/ui/panes/command-log-pane.ts:24-33). lazygit's extras view is not that
shape: it is an append-only stream of styled lines, written by LogAction and
LogCommand (pkg/gui/command_log_panel.go:25-68), and it shows no timestamp,
exit code or duration at all.

So CommandLog now holds logical lines carrying their own spans, with lazygit's
write API. lazygit keeps a plain gui.GuiLog []string plus gocui's attributed
line buffer (command_log_panel.go:40-41,64-65); one list of spanned lines is
the same shape — append-only, never reparsed. records() goes away with it:
retaining every command's whole stdout cost memory proportional to the largest
patch the session had produced, for content the pane no longer renders.

createGhRunner stops logging. Its comment said logging was the point, but
`gh pr list` is a background query and lazygit keeps queries out of the log
(80 DontLog() calls, e.g. git_commands/status.go:98).

The pane still paints in one colour; that is the next commit.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: `readOnly` implies `dontLog`, plus streamed and failed output

**Files:**
- Modify: `src/app/command-log.ts` (replace `logOutput` with `outputWriter`)
- Modify: `src/git/runner.ts:4-30` (options), `:70-145` (`run`)
- Modify: `src/git/sync.ts:67-95`
- Modify: `tests/app/command-log.test.ts`, `tests/git/commit-mutations.integration.test.ts`, `tests/acceptance/review-workflow.integration.test.ts`
- Modify: `src/app/controller.ts:534-536`
- Modify: `src/app/create-app.ts:327-337`
- Test: `tests/git/runner.test.ts`

**Interfaces:**
- Consumes: `CommandLog.logCommand` / `logOutput` from Task 2, `formatCommandLine` from Task 1.
- Produces: `GitRunOptions.streamOutput?: boolean`. `fetch(runner, remote?, options?: FetchOptions)` where `FetchOptions = { readonly background?: boolean }`. `AppController.fetch(remote?: string, options?: { readonly background?: boolean })`. `CommandLogOutputWriter` and `CommandLog.outputWriter(): CommandLogOutputWriter`, replacing `CommandLog.logOutput` and its per-log heading flag.

- [ ] **Step 1: Write the failing tests**

Add to `tests/git/runner.test.ts`, inside the existing `describe("GitRunner", …)`:

```ts
  /**
   * lazygit marks each of its 80 read paths DontLog() by hand
   * (pkg/commands/git_commands/status.go:98,135,140; commit_loader.go:294,571,605;
   * stash_loader.go:36,71; file_loader.go:133,213,228; config.go:83). githunk gets the same set
   * from one rule, because `readOnly` already marks exactly the reads.
   */
  test("a readOnly command is not logged", async () => {
    await runner.run(["rev-parse", "--show-toplevel"], { readOnly: true })
    expect(log.lines()).toEqual([])
  })

  test("a readOnly command can opt back in with an explicit dontLog: false", async () => {
    await runner.run(["rev-parse", "--show-toplevel"], { readOnly: true, dontLog: false })
    expect(log.lines()).toHaveLength(1)
  })

  test("a write can opt out with an explicit dontLog, as the background fetch does", async () => {
    await runner.run(["rev-parse", "--show-toplevel"], { dontLog: true })
    expect(log.lines()).toEqual([])
  })

  test("logs the command before it runs, so a slow command is visible while it runs", async () => {
    const seen: number[] = []
    const promise = runner.run(["rev-parse", "--show-toplevel"])
    seen.push(log.lines().length)
    await promise
    seen.push(log.lines().length)
    expect(seen).toEqual([1, 1])
  })

  /**
   * lazygit writes command output into the panel only for the commands it streams — the ones with a
   * credential strategy, i.e. push/pull/fetch (cmd_obj_runner.go:234-246,
   * git_commands/sync.go:44,110,124,132) — behind `prefixWriter`'s magenta `Git output:`
   * (extras_panel.go:96-98).
   */
  test("streamOutput puts the output under a Git output: heading", async () => {
    await runner.run(["rev-parse", "--show-toplevel"], { streamOutput: true })
    const texts = log.lines().map((line) => line.spans.map((span) => span.text).join(""))
    expect(texts[0]).toBe("  git rev-parse --show-toplevel")
    expect(texts[1]).toBe("")
    expect(texts[2]).toBe("Git output:")
    expect(texts[3]).toBe(repo.path)
  })

  /**
   * githunk's one deliberate deviation. lazygit raises an error popup for a non-streamed failure
   * and writes nothing to the log; githunk has no popup — a failed mutation shows as a pane
   * bottomTitle — and PRD 6.7 requires command failures stay inspectable.
   */
  test("a failed command's stderr lands under the same heading", async () => {
    await expect(runner.run(["rev-parse", "--verify", "missing-ref"])).rejects.toThrow()
    const texts = log.lines().map((line) => line.spans.map((span) => span.text).join(""))
    expect(texts[0]).toBe("  git rev-parse --verify missing-ref")
    expect(texts[2]).toBe("Git output:")
    expect(texts.slice(3).join("\n")).toContain("fatal")
  })

  test("a succeeding command's stdout stays out of the log", async () => {
    await runner.run(["rev-parse", "--show-toplevel"])
    const texts = log.lines().map((line) => line.spans.map((span) => span.text).join(""))
    expect(texts).toEqual(["  git rev-parse --show-toplevel"])
  })

  test("an accepted non-zero exit is not a failure and logs no output", async () => {
    await runner.run(["rev-parse", "--verify", "--quiet", "missing-ref"], { acceptedExitCodes: [0, 1], dontLog: false })
    const texts = log.lines().map((line) => line.spans.map((span) => span.text).join(""))
    expect(texts).toEqual(["  git rev-parse --verify --quiet missing-ref"])
  })
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/git/runner.test.ts`
Expected: FAIL — "a readOnly command is not logged" gets 1 line instead of 0; the `streamOutput`
tests fail to compile (`streamOutput` is not in `GitRunOptions`).

- [ ] **Step 3: Add the option and the rule**

In `src/git/runner.ts`, extend the `dontLog` doc comment and add `streamOutput`:

```ts
  /**
   * Keeps the command out of the Command Log pane, or forces it in. lazygit's `DontLog()`
   * (pkg/commands/oscommands/cmd_obj.go:118-128), which it sets on 80 commands by hand — every
   * loader and query, plus the background fetch (git_commands/sync.go:81).
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
   * pkg/commands/git_commands/sync.go:44,110,124,132) — via `getCmdWriter`
   * (pkg/gui/extras_panel.go:96-98).
   */
  readonly streamOutput?: boolean
```

Then rewrite the top of `run()` and the tail after the record is built:

```ts
  async run(args: readonly string[], options: GitRunOptions = {}): Promise<GitResult> {
    const commandArgs = [...args]
    // `readOnly` marks exactly githunk's reads — all 65 call sites outside this file were audited —
    // so it is what decides whether the command is logged, unless the caller says otherwise. See
    // the `dontLog` doc comment.
    const shouldLog = options.dontLog === undefined ? options.readOnly !== true : !options.dontLog
    // Before the spawn, as lazygit's `logCmdObj` is (cmd_obj_runner.go:196-203): the point is to
    // see what is running, not what has run. The argv is prefixed with `git` and *not* with
    // `--no-pager`, so the line matches what lazygit's `CmdObj.ToString()` shows for the same
    // command (its builder prepends only `git`, git_cmd_obj_builder.go:57-59).
    if (shouldLog) this.log.logCommand(formatCommandLine(["git", ...commandArgs]), true)
    // One writer per command, so two commands' output can never share a heading. See Step 3a.
    const writer = this.log.outputWriter()
    const startedAt = new Date()
```

Delete the `if (options.dontLog !== true) this.log.logCommand(…)` line Task 2 left after the record,
and replace the accepted-exit-code tail:

```ts
    const acceptedExitCodes = options.acceptedExitCodes ?? [0]
    const accepted = acceptedExitCodes.includes(exitCode)
    if (shouldLog) {
      if (options.streamOutput === true) {
        // lazygit's cmdWriter receives both streams (cmd_obj_runner.go:230,258).
        writer.write(`${stdout}${stderr}`)
      } else if (!accepted) {
        // githunk's one deviation from lazygit here, which raises an error popup instead and writes
        // nothing. githunk has no popup — a failed mutation surfaces as a pane bottomTitle — and
        // PRD 6.7 requires that command failures remain inspectable.
        writer.write(stderr)
      }
    }
    if (!accepted) {
      throw new GitCommandError(record)
    }

    return { exitCode, stdout, stderr, record }
  }
```

- [ ] **Step 3a: Make the `Git output:` heading per-command, not per-log**

Task 2 built `logOutput(text)` with an `outputHeadingWritten` flag on the `CommandLog`, cleared by
`logCommand`, and a comment claiming that is what lazygit's `prefixWriter.prefixWritten` does. It is
not. `getCmdWriter()` constructs a **fresh** `prefixWriter` per command
(`pkg/gui/extras_panel.go:96-97`), so `prefixWritten` is per-command state: two commands writing
output each get their own heading. A flag on the log only behaves the same while commands never
interleave, and `logCommand(A) → logCommand(B) → logOutput(A) → logOutput(B)` files both commands'
output under one heading.

Replace the flag with a writer, copying `getCmdWriter` and `prefixWriter` directly. In
`src/app/command-log.ts`, delete the `outputHeadingWritten` field, its assignment in `logCommand`,
and the whole `logOutput` method, and add:

```ts
/**
 * lazygit's `prefixWriter` (pkg/gui/extras_panel.go:100-119): the first write emits the magenta
 * `Git output:` heading, later writes do not. One of these per command, exactly as `getCmdWriter()`
 * hands out a fresh one per command (`:96-97`) — so two commands' output can never end up under a
 * single heading.
 */
export type CommandLogOutputWriter = {
  write(text: string): void
}
```

```ts
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
```

Migrate `tests/app/command-log.test.ts`'s three `logOutput` tests to `outputWriter()`. Two of them
keep asserting exactly what they assert now, through one writer. The third — "writes the heading
again for the next command" — becomes the stronger claim the new shape actually supports, and must
fail against the old flag-based code:

```ts
  test("two interleaved commands each get their own heading", () => {
    const log = new CommandLog()
    log.logCommand("git push", true)
    const push = log.outputWriter()
    log.logCommand("git pull", true)
    const pull = log.outputWriter()
    push.write("from push\n")
    pull.write("from pull\n")
    expect(texts(log.lines()).filter((text) => text === "Git output:")).toHaveLength(2)
  })
```

Run that test against the Task 2 code first and confirm it reports 1 heading, not 2 — that is the
RED proving the defect was real, and it belongs in your report.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/git/runner.test.ts tests/app/command-log.test.ts`
Expected: PASS.

- [ ] **Step 5: Mark the streamed commands and the background fetch**

In `src/git/sync.ts`, add the options type above `fetch` and rewrite the three functions' `run`
calls:

```ts
export type FetchOptions = {
  /**
   * lazygit's `FetchBackgroundCmdObj` is `DontLog().FailOnCredentialRequest()` while the foreground
   * `FetchCmdObj` is neither (pkg/commands/git_commands/sync.go:65-84): a fetch every 60 seconds
   * would bury the commands the user actually ran.
   */
  readonly background?: boolean
}

export async function fetch(runner: CommandRunner, remote?: string, options: FetchOptions = {}): Promise<void> {
  await runner.run(
    remote === undefined ? ["fetch"] : ["fetch", remote],
    options.background === true ? { dontLog: true } : { streamOutput: true },
  )
}
```

In `pull` (lines 71-82) and `push` (lines 85-96), add `{ streamOutput: true }` to each `run` call —
lazygit builds all four with `PromptOnCredentialRequest`, which routes them through `runAndStream`
(`sync.go:110,124,132`, `cmd_obj_runner.go:38-40`):

```ts
    await runner.run(["pull", options.upstream.remote, options.upstream.branch], { streamOutput: true })
```
```ts
  await runner.run(["pull"], { streamOutput: true })
```
```ts
    await runner.run(["push", "--set-upstream", options.upstream.remote, options.upstream.branch], { streamOutput: true })
```
```ts
  await runner.run(["push"], { streamOutput: true })
```

- [ ] **Step 6: Thread the background flag through the controller**

In `src/app/controller.ts:534-536`:

```ts
  async fetch(remote?: string, options: { readonly background?: boolean } = {}): Promise<void> {
    if (!this.ensureWorkingTreeMutation()) return
    await this.runMutation(() => this.requireRunnerOperation((runner) => fetchSync(runner, remote, options)))
  }
```

In `src/app/create-app.ts`, the background refresher's `fetch` (line 328):

```ts
          // lazygit's background fetch is DontLog() while its foreground one is not
          // (pkg/commands/git_commands/sync.go:65-84).
          await controller.fetch(undefined, { background: true })
```

Leave `create-app.ts:264`'s foreground `controller.fetch()` alone.

- [ ] **Step 6a: Fix the assertions this task moves the ground under**

Three test sites, all consequences of this task rather than new work:

1. `tests/acceptance/review-workflow.integration.test.ts:255-256` pins
   `commandLog.at(-1)` to `"  git fetch missing-remote"`. That was true while the command was logged
   *after* it ran; now the command is logged before the spawn and its failure output after, so the
   last line is output. Assert on the command line's presence and on the `Git output:` heading
   following it, rather than on `at(-1)`.
2. `tests/git/commit-mutations.integration.test.ts:52` dropped its hook-stderr-in-log assertion in
   Task 2 on the grounds that failure output was not yet implemented. It is now: re-assert that the
   failing hook's `hook failed` reaches the log under `Git output:`, alongside the existing
   assertion that it reaches `GitCommandError.record.stderr`.
3. While you are in that file, `tests/git/commit-mutations.integration.test.ts:44-51` wraps the
   rejection in a `try` whose own `throw new Error("expected GitCommandError")` is caught by its own
   `catch`, so the test fails by the wrong assertion with a misleading message. Replace it with
   `await expect(...).rejects.toBeInstanceOf(GitCommandError)` plus a separate `.rejects.toMatchObject`
   for the stderr.

- [ ] **Step 7: Run the gate**

Run: `bun run check`
Expected: all green. `tests/git/sync.integration.test.ts` still passes: its assertion is on the
`pull` command line, which is unaffected by `streamOutput`.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
feat: log only what lazygit logs

lazygit marks 80 command objects DontLog() one at a time — every loader and
query (git_commands/status.go:98,135,140; commit_loader.go:294,571,605;
branch.go:69-348; stash_loader.go:36,71; file_loader.go:133,213,228;
config.go:83) plus the background fetch (sync.go:81). githunk used dontLog
once, so a 10-second working-tree refresh buried the user's own commands under
status, log, for-each-ref and diff.

Auditing all 65 run() call sites outside this file shows githunk already
separates the two structurally: every read passes readOnly: true and every
mutation omits it, with no exceptions either way. So readOnly now implies
dontLog. That yields the same set lazygit's 80 calls yield and makes it an
invariant a new loader cannot forget; an explicit dontLog still overrides in
either direction, which is how the background fetch opts out.

The command is logged before the spawn, as logCmdObj is
(cmd_obj_runner.go:196-203) — the point is seeing what is running. The argv is
prefixed with `git` and not `--no-pager`, matching what CmdObj.ToString() shows
given a builder that prepends only `git` (git_cmd_obj_builder.go:57-59).

Output follows lazygit for streamed commands: push, pull and foreground fetch
carry a credential strategy, which routes them through runAndStream and into
the prefixWriter's magenta `Git output:` (cmd_obj_runner.go:38-40,234-246;
sync.go:44,110,124,132; extras_panel.go:96-98). githunk buffers rather than
streams, so the block arrives at once; the text is the same.

One deviation: a non-streamed command that fails also writes its stderr under
that heading. lazygit raises an error popup instead and logs nothing, but
githunk has no popup — a failed mutation shows as a pane bottomTitle — and PRD
6.7 requires command failures stay inspectable.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Colour the log

**Files:**
- Create: `src/ui/panes/command-log-text.ts`
- Modify: `src/ui/panes/command-log-pane.ts`
- Test: `tests/ui/command-log-text.test.ts`

**Interfaces:**
- Consumes: `CommandLogLine`, `CommandLogStyle` from Task 1; `paneTextBuffer`, `PaneStyleDefinition` from `src/ui/panes/pane-text.ts`.
- Produces: `commandLogRowHighlights(lines, lineSources, row): readonly CommandLogRowHighlight[]` where `CommandLogRowHighlight = { readonly start: number; readonly end: number; readonly style: CommandLogStyle }`, and `installCommandLogText(text: TextRenderable, lines: readonly CommandLogLine[]): void`.

- [ ] **Step 1: Write the failing test**

Create `tests/ui/command-log-text.test.ts`:

```ts
import { describe, expect, test } from "bun:test"
import { ROW_END_COLS, commandLogRowHighlights } from "../../src/ui/panes/command-log-text"
import type { CommandLogLine } from "../../src/domain/command"

function line(id: number, ...spans: readonly (readonly [string, CommandLogLine["spans"][number]["style"]])[]): CommandLogLine {
  return { id, spans: spans.map(([text, style]) => ({ text, style })) }
}

/**
 * The pane lets OpenTUI wrap and paints per *visual* row, so `lineSources` — OpenTUI's visual row →
 * logical line map (as src/ui/panes/diff-text.ts:104-108 uses it) — is the input. A single-span
 * line paints whole, which is why wide characters never need measuring here.
 */
describe("commandLogRowHighlights", () => {
  const lines: readonly CommandLogLine[] = [
    line(1, ["You can hide/focus this panel by pressing '@'", "intro"]),
    line(2),
    line(3, ["Random tip: ", "tip-label"], ["press '@' to hide this panel", "tip"]),
    line(4, ["Stage file", "action"]),
    line(5, ["  git add -- a.ts", "command"]),
  ]

  test("paints a single-span row across the whole row", () => {
    expect(commandLogRowHighlights(lines, [0, 1, 2, 3, 4], 0)).toEqual([
      { start: 0, end: ROW_END_COLS, style: "intro" },
    ])
    expect(commandLogRowHighlights(lines, [0, 1, 2, 3, 4], 3)).toEqual([
      { start: 0, end: ROW_END_COLS, style: "action" },
    ])
  })

  test("paints a blank line as nothing", () => {
    expect(commandLogRowHighlights(lines, [0, 1, 2, 3, 4], 1)).toEqual([])
  })

  test("splits the tip row at the label's code-point boundary", () => {
    expect(commandLogRowHighlights(lines, [0, 1, 2, 3, 4], 2)).toEqual([
      { start: 0, end: 12, style: "tip-label" },
      { start: 12, end: ROW_END_COLS, style: "tip" },
    ])
  })

  test("paints a continuation row of a single-span line in that line's style", () => {
    // Row 5 and row 6 both wrapped out of logical line index 4.
    expect(commandLogRowHighlights(lines, [0, 1, 2, 3, 4, 4], 5)).toEqual([
      { start: 0, end: ROW_END_COLS, style: "command" },
    ])
  })

  test("paints a continuation row of the tip line in the trailing span's style", () => {
    expect(commandLogRowHighlights(lines, [0, 1, 2, 2, 3, 4], 3)).toEqual([
      { start: 0, end: ROW_END_COLS, style: "tip" },
    ])
  })

  test("yields nothing for a row past the end of the map or the lines", () => {
    expect(commandLogRowHighlights(lines, [0, 1, 2, 3, 4], 9)).toEqual([])
    expect(commandLogRowHighlights(lines, [0, 1, 2, 3, 4, 5], 5)).toEqual([])
  })

  test("counts the label in code points, not UTF-16 units", () => {
    const emoji: readonly CommandLogLine[] = [line(1, ["🎲 tip: ", "tip-label"], ["go", "tip"])]
    expect(commandLogRowHighlights(emoji, [0], 0)).toEqual([
      { start: 0, end: 8, style: "tip-label" },
      { start: 8, end: ROW_END_COLS, style: "tip" },
    ])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/ui/command-log-text.test.ts`
Expected: FAIL — cannot resolve `../../src/ui/panes/command-log-text`.

- [ ] **Step 3: Write `src/ui/panes/command-log-text.ts`**

```ts
import type { TextRenderable } from "@opentui/core"
import type { CommandLogLine, CommandLogStyle } from "../../domain/command"
import { ANSI_CYAN, ANSI_GREEN, ANSI_MAGENTA, ANSI_YELLOW, DEFAULT_FOREGROUND } from "../theme"
import { paneTextBuffer, type PaneStyleDefinition, type PaneTextBuffer } from "./pane-text"

/**
 * Paints the command log's colours, following src/ui/panes/diff-text.ts: the text goes in whole and
 * unstyled (see ./pane-text for why that is the cheap route), OpenTUI owns wrapping and scrolling,
 * and only the rows near the viewport carry highlights.
 *
 * lazygit sets `Wrap = true` on the extras view (pkg/gui/views.go:150) and gocui wraps at character
 * boundaries; the pane sets `wrapMode: "char"` to match. Letting the widget wrap is what keeps this
 * file free of column arithmetic: nothing in githunk measures East Asian width, and every log line
 * but the random tip carries a single span, so its rows paint whole.
 */

/** Column bound for "to the end of the row"; the native buffer clamps it to the real width. */
export const ROW_END_COLS = 1_000_000

/** Rows painted beyond the viewport on each side, as in diff-text.ts:23. */
const MARGIN_ROWS = 32

/**
 * lazygit's colours. `command` is `theme.DefaultTextColor`, which is `style.FgDefault`
 * (pkg/theme/theme.go:11) — the terminal's own foreground, not a fixed white.
 */
const STYLE_DEFINITIONS: Readonly<Record<CommandLogStyle, PaneStyleDefinition>> = {
  // `style.FgYellow.Sprint(action)` (pkg/gui/command_log_panel.go:41).
  action: { fg: ANSI_YELLOW },
  command: { fg: DEFAULT_FOREGROUND },
  // "if we're not dealing with a direct command that could be run on the command line, we style it
  // differently to communicate that" (pkg/gui/command_log_panel.go:52-56).
  internal: { fg: ANSI_MAGENTA },
  // `style.FgMagenta.Sprintf("\n\n%s\n", Tr.GitOutput)` (pkg/gui/extras_panel.go:97).
  "output-heading": { fg: ANSI_MAGENTA },
  output: { fg: DEFAULT_FOREGROUND },
  // `style.FgCyan.Sprint(introStr)` (pkg/gui/command_log_panel.go:75).
  intro: { fg: ANSI_CYAN },
  // `style.FgYellow.Sprint(Tr.RandomTip)` / `style.FgGreen.Sprint(tip)` (:81-82).
  "tip-label": { fg: ANSI_YELLOW },
  tip: { fg: ANSI_GREEN },
}

export type CommandLogRowHighlight = {
  readonly start: number
  readonly end: number
  readonly style: CommandLogStyle
}

/**
 * The highlights one *visual* row needs. `lineSources` is OpenTUI's visual row → logical line map.
 *
 * A row belonging to a single-span line paints whole, so wrapping and character width are the
 * widget's problem, not this function's. The only multi-span line is `Random tip: <tip>`: its first
 * row splits at the label's code-point boundary, and any row it wrapped onto takes the trailing
 * span's style — the label cannot reach a continuation row, being the first thing on the line.
 */
export function commandLogRowHighlights(
  lines: readonly CommandLogLine[],
  lineSources: readonly number[],
  row: number,
): readonly CommandLogRowHighlight[] {
  const source = lineSources[row]
  if (source === undefined) return []
  const line = lines[source]
  if (line === undefined || line.spans.length === 0) return []
  const last = line.spans[line.spans.length - 1]!
  if (line.spans.length === 1) return [{ start: 0, end: ROW_END_COLS, style: last.style }]
  if (lineSources[row - 1] === source) return [{ start: 0, end: ROW_END_COLS, style: last.style }]

  const highlights: CommandLogRowHighlight[] = []
  let column = 0
  for (const [index, span] of line.spans.entries()) {
    // Code points, not UTF-16 units: an astral character is one column's worth of text as far as
    // the buffer's column indexing is concerned.
    const width = [...span.text].length
    const isLast = index === line.spans.length - 1
    highlights.push({ start: column, end: isLast ? ROW_END_COLS : column + width, style: span.style })
    column += width
  }
  return highlights
}

type CommandLogTextState = {
  readonly buffer: PaneTextBuffer
  readonly styleIds: Readonly<Record<CommandLogStyle, number>>
  text: string
  lines: readonly CommandLogLine[]
  /** Visual row → logical line, cached per wrap width exactly as diff-text.ts:104-108 does. */
  rowSources: readonly number[] | undefined
  rowSourcesWidth: number
  appliedScrollY: number
  appliedHeight: number
  /** Inclusive row range currently carrying highlights, or undefined when none do. */
  painted: { from: number; to: number } | undefined
}

const states = new WeakMap<TextRenderable, CommandLogTextState>()
const hooked = new WeakSet<TextRenderable>()

function registerStyles(buffer: PaneTextBuffer): Readonly<Record<CommandLogStyle, number>> {
  const ids: Partial<Record<CommandLogStyle, number>> = {}
  for (const [name, definition] of Object.entries(STYLE_DEFINITIONS) as [CommandLogStyle, PaneStyleDefinition][]) {
    ids[name] = buffer.registerStyle(`githunk.commandLog.${name}`, definition)
  }
  return ids as Readonly<Record<CommandLogStyle, number>>
}

function paintWindow(text: TextRenderable, force: boolean): void {
  const state = states.get(text)
  if (state === undefined) return
  const height = Math.max(1, Math.floor(text.height))
  const scrollY = Math.max(0, Math.floor(text.scrollY))
  if (!force && state.painted !== undefined && state.appliedScrollY === scrollY && state.appliedHeight === height) return

  const width = Math.max(1, Math.floor(text.width))
  if (state.rowSources === undefined || state.rowSourcesWidth !== width) {
    state.rowSources = text.lineInfo.lineSources
    state.rowSourcesWidth = width
  }
  const sources = state.rowSources
  const from = Math.max(0, scrollY - MARGIN_ROWS)
  const to = Math.min(sources.length - 1, scrollY + height - 1 + MARGIN_ROWS)

  const paintRow = (row: number): void => {
    for (const highlight of commandLogRowHighlights(state.lines, sources, row)) {
      state.buffer.addHighlight(row, { start: highlight.start, end: highlight.end, styleId: state.styleIds[highlight.style] })
    }
  }

  // Rows already painted stay painted: a highlight costs ~46 µs to add, so scrolling by a row must
  // touch a row, not a screenful (diff-text.ts:120-133).
  const previous = state.painted
  if (previous === undefined || previous.to < from || previous.from > to) {
    state.buffer.clearAllHighlights()
    for (let row = from; row <= to; row++) paintRow(row)
  } else {
    for (let row = previous.from; row < from; row++) state.buffer.clearRow(row)
    for (let row = to + 1; row <= previous.to; row++) state.buffer.clearRow(row)
    for (let row = from; row < previous.from; row++) paintRow(row)
    for (let row = previous.to + 1; row <= to; row++) paintRow(row)
  }
  state.painted = { from, to }
  state.appliedScrollY = scrollY
  state.appliedHeight = height
}

/** Follows the viewport for the rest of the pane's life, as diff-text.ts:138-152 does. */
function hookLifecycle(text: TextRenderable): void {
  if (hooked.has(text)) return
  hooked.add(text)
  const host = text as unknown as { onLifecyclePass?: (() => void) | null }
  const previous = host.onLifecyclePass
  host.onLifecyclePass = () => {
    previous?.call(text)
    paintWindow(text, false)
  }
}

/**
 * Installs `lines` as the pane's text and colours the rows near the viewport. Re-installing the
 * same lines only refreshes the paint description, which is what makes a no-op refresh free.
 *
 * If a future OpenTUI stops exposing the buffer, the log degrades to uncoloured rather than
 * unrendered — the same trade `installDiffText` makes.
 */
export function installCommandLogText(text: TextRenderable, lines: readonly CommandLogLine[]): void {
  const full = lines.map((line) => line.spans.map((span) => span.text).join("")).join("\n")
  const buffer = paneTextBuffer(text)
  if (buffer === undefined) {
    text.content = full
    return
  }
  let state = states.get(text)
  if (state === undefined) {
    state = {
      buffer,
      styleIds: registerStyles(buffer),
      text: "",
      lines,
      rowSources: undefined,
      rowSourcesWidth: -1,
      appliedScrollY: -1,
      appliedHeight: -1,
      painted: undefined,
    }
    states.set(text, state)
    hookLifecycle(text)
  }
  state.lines = lines
  const changed = state.text !== full
  if (changed) {
    state.text = full
    buffer.setText(full)
    state.rowSources = undefined
    // setText drops the buffer's highlights with the text it styled.
    state.painted = undefined
  }
  paintWindow(text, changed)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/ui/command-log-text.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Use it from the pane**

In `src/ui/panes/command-log-pane.ts`: swap the import of `setPlainPaneText` for
`installCommandLogText`, set the wrap mode, and fix the title.

```ts
import { installCommandLogText } from "./command-log-text"
```

```ts
    titleColor: DEFAULT_FOREGROUND,
    // `Tr.ExtrasTitle` / `Tr.CommandLog` (pkg/i18n/english.go:1928,1946) — lowercase "log".
    title: "Command log",
```

```ts
  const text = new TextRenderable(renderer, {
    id: "command-log-text",
    content: "",
    fg: DEFAULT_FOREGROUND,
    selectable: false,
    // lazygit sets `Wrap = true` on the extras view (pkg/gui/views.go:150); gocui wraps at
    // character boundaries, which is `"char"` here. Letting OpenTUI wrap is also what lets
    // command-log-text.ts colour rows without measuring character width.
    wrapMode: "char",
    width: "100%",
  })
```

and in `update`:

```ts
      installCommandLogText(text, nextLines)
```

- [ ] **Step 6: Run the gate**

Run: `bun run check`
Expected: all green.

- [ ] **Step 7: Smoke it**

Run: `bun run start` in this repository, press `@` to show the log, then press `s` on a file in the
Files pane. Confirm the command line appears indented and in the terminal's default foreground, and
that a failure (e.g. `git push` with no remote) shows a magenta `Git output:` heading.

Record the observation in the commit body. If the app cannot be driven here, say so instead of
claiming the smoke passed — `docs/release-checklist-v0.1.md` distinguishes `Automated` from
`Manual smoke observed` from `Not tested`.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
feat: colour the command log like lazygit's extras view

lazygit paints the log in five roles: LogAction's yellow label, LogCommand's
default-foreground and magenta pair (pkg/gui/command_log_panel.go:41,51-56),
the prefixWriter's magenta `Git output:` over unstyled output
(pkg/gui/extras_panel.go:97), and the startup header's cyan line with a
yellow/green random tip (command_log_panel.go:75,81-82). `command` is
theme.DefaultTextColor, i.e. style.FgDefault (pkg/theme/theme.go:11) — the
terminal's own foreground, not a fixed white.

Rendering follows src/ui/panes/diff-text.ts: the text goes in whole and
unstyled through the buffer's setText, because assigning TextRenderable.content
costs chunks x lines in OpenTUI 0.5.6, and colour arrives as line-indexed
highlights on the rows near the viewport only.

The pane sets wrapMode "char" rather than wrapping itself, matching gocui's
character-boundary wrap behind lazygit's Wrap = true (pkg/gui/views.go:150).
That is also what keeps column arithmetic out of this file: nothing in githunk
measures East Asian width, and every log line except `Random tip: <tip>`
carries a single span, so its rows paint { start: 0, end: ROW_END }.

Title corrected to "Command log" (pkg/i18n/english.go:1928).

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Autoscroll

**Files:**
- Create: `src/ui/panes/command-log-scroll.ts`
- Modify: `src/ui/panes/command-log-pane.ts`
- Test: `tests/ui/command-log-scroll.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `CommandLogScrollInput` (the union below) and `autoscrollAfter(current: boolean, input: CommandLogScrollInput): boolean`. `CommandLogPaneHandle` gains `autoscroll: boolean` (get/set) and `applyScrollInput(input: CommandLogScrollInput): void`. `src/app/command-log.ts` exports `CommandLogWriteKind` and `CommandLog.lastWriteKind()`. `src/domain/repository.ts` gains `AppModel.commandLogWriteKind?: CommandLogWriteKind`.
- Note: `CommandLogWriteKind` is a subset of `CommandLogScrollInput`, deliberately — the domain does not need to name a scroll or a resize.

- [ ] **Step 1: Write the failing test**

Create `tests/ui/command-log-scroll.test.ts`:

```ts
import { describe, expect, test } from "bun:test"
import { autoscrollAfter, type CommandLogScrollInput } from "../../src/ui/panes/command-log-scroll"

/**
 * lazygit's `view.Autoscroll` for the extras view. The surprising half is that scrolling *down*
 * clears it too (`scrollDownExtra`, pkg/gui/extras_panel.go:56-61), so holding `j` to the bottom
 * does not re-arm it — only `>` and losing focus do.
 */
describe("autoscrollAfter", () => {
  const clears: readonly CommandLogScrollInput[] = ["scroll-up", "scroll-down", "page-up", "page-down", "goto-top"]
  const arms: readonly CommandLogScrollInput[] = ["append-entry", "goto-bottom", "focus-lost"]
  const leaves: readonly CommandLogScrollInput[] = ["append-output", "append-header", "resize"]

  for (const input of clears) {
    test(`${input} clears autoscroll`, () => {
      expect(autoscrollAfter(true, input)).toBe(false)
      expect(autoscrollAfter(false, input)).toBe(false)
    })
  }

  for (const input of arms) {
    test(`${input} arms autoscroll`, () => {
      expect(autoscrollAfter(false, input)).toBe(true)
      expect(autoscrollAfter(true, input)).toBe(true)
    })
  }

  for (const input of leaves) {
    test(`${input} leaves autoscroll alone`, () => {
      expect(autoscrollAfter(false, input)).toBe(false)
      expect(autoscrollAfter(true, input)).toBe(true)
    })
  }

  test("scrolling up then a new command re-arms it, because LogAction assigns true", () => {
    let state = autoscrollAfter(true, "scroll-up")
    expect(state).toBe(false)
    state = autoscrollAfter(state, "append-entry")
    expect(state).toBe(true)
  })

  test("holding j to the bottom leaves it off, unlike goto-bottom", () => {
    let state = true
    for (let index = 0; index < 5; index++) state = autoscrollAfter(state, "scroll-down")
    expect(state).toBe(false)
    expect(autoscrollAfter(state, "goto-bottom")).toBe(true)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/ui/command-log-scroll.test.ts`
Expected: FAIL — cannot resolve `../../src/ui/panes/command-log-scroll`.

- [ ] **Step 3: Write `src/ui/panes/command-log-scroll.ts`**

```ts
/**
 * lazygit's `view.Autoscroll` for the extras view, as a pure transition.
 *
 * The handlers are all in pkg/gui/extras_panel.go and they are blunt: every scroll handler assigns
 * `Autoscroll = false` — `scrollUpExtra` (:49), `scrollDownExtra` (:57), `pageUpExtrasPanel` (:65),
 * `pageDownExtrasPanel` (:73), `goToExtrasPanelTop` (:81) — except `goToExtrasPanelBottom`, which
 * assigns `true` (:89). So scrolling *down* to the bottom by hand does not re-arm it; `>` does. The
 * other two ways it comes back on are a new log entry (`LogAction`/`LogCommand`,
 * pkg/gui/command_log_panel.go:38,62) and losing focus
 * (pkg/gui/controllers/command_log_controller.go:29-33).
 */
export type CommandLogScrollInput =
  /** `LogAction` or `LogCommand`, both of which assign `Autoscroll = true`. */
  | "append-entry"
  /**
   * The `prefixWriter`'s output. It writes straight to the view
   * (pkg/gui/extras_panel.go:109-119) and never assigns `Autoscroll`; it scrolls only because the
   * `logCommand` before it already armed the flag.
   */
  | "append-output"
  /** `printCommandLogHeader` (pkg/gui/command_log_panel.go:70-85), likewise. */
  | "append-header"
  | "scroll-up"
  | "scroll-down"
  | "page-up"
  | "page-down"
  | "goto-top"
  | "goto-bottom"
  | "focus-lost"
  /** Not a lazygit concept; a resize must not change what the user was reading. */
  | "resize"

export function autoscrollAfter(current: boolean, input: CommandLogScrollInput): boolean {
  switch (input) {
    case "append-entry":
    case "goto-bottom":
    case "focus-lost":
      return true
    case "scroll-up":
    case "scroll-down":
    case "page-up":
    case "page-down":
    case "goto-top":
      return false
    case "append-output":
    case "append-header":
    case "resize":
      return current
    default: {
      const unhandled: never = input
      return unhandled
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/ui/command-log-scroll.test.ts`
Expected: PASS, 14 tests.

- [ ] **Step 5: Wire it into the pane**

In `src/ui/panes/command-log-pane.ts`:

Add to the handle type:

```ts
export type CommandLogPaneHandle = {
  // …unchanged members…
  /** lazygit's `view.Autoscroll` (pkg/gui/extras_panel.go). */
  autoscroll: boolean
  /** Applies one of lazygit's autoscroll transitions and re-pins the viewport if it is armed. */
  applyScrollInput(input: CommandLogScrollInput): void
}
```

Import it and hold the flag next to `rendered`:

```ts
import { autoscrollAfter, type CommandLogScrollInput } from "./command-log-scroll"
```

```ts
  // `gui.Views.Extras.Autoscroll = true` at startup (pkg/gui/views.go:149).
  let autoscroll = true
```

**Delete the wheel-swallowing block at lines 74-81** — the `onMouseEvent` override that calls
`event.preventDefault()` on a scroll. lazygit binds the wheel to `scrollUpExtra`/`scrollDownExtra`
(`keybindings.go:249-258`), so the log must scroll.

Replace `update`'s unconditional bottom-pinning:

```ts
    update(nextLines: readonly CommandLogLine[]) {
      if (rendered !== undefined && rendered.count === nextLines.length && rendered.newest === nextLines[nextLines.length - 1]) return
      rendered = { count: nextLines.length, newest: nextLines[nextLines.length - 1] }
      installCommandLogText(text, nextLines)
      // Only when armed. lazygit's autoscroll is a view flag, not a property of writing
      // (pkg/gui/extras_panel.go:48-94); the caller decides whether an append armed it, because
      // only the caller knows whether it was an entry or the output under one.
      if (autoscroll) text.scrollY = text.maxScrollY
      syncVerticalScrollbar(bar, text)
    },
```

Make `resize` stop pinning unconditionally too:

```ts
    resize(width: number, height: number) {
      text.width = Math.max(1, Math.floor(width) - 2)
      text.height = Math.max(1, Math.floor(height) - 2)
      if (autoscroll) text.scrollY = text.maxScrollY
      syncVerticalScrollbar(bar, text)
    },
```

Add the accessors and the transition entry point:

```ts
    get autoscroll() {
      return autoscroll
    },
    set autoscroll(value: boolean) {
      autoscroll = value
    },
    applyScrollInput(input: CommandLogScrollInput) {
      autoscroll = autoscrollAfter(autoscroll, input)
      if (autoscroll) {
        text.scrollY = text.maxScrollY
        syncVerticalScrollbar(bar, text)
        box.requestRender()
      }
    },
```

`get`/`set` in an object literal typed as `CommandLogPaneHandle` satisfies the mutable `autoscroll`
member; do not mark it `readonly` in the type.

- [ ] **Step 6: Arm autoscroll from the write paths**

In `src/ui/root-view.ts`, the `update(model)` path currently calls `this.commandLog.update(...)`
(line ~590) whenever the log is visible. A new line arriving is an `append-entry` unless it is
output under a command, and the view cannot tell them apart from the line list alone — but it does
not need to: `CommandLog` knows. Add a read-only accessor there instead.

In `src/app/command-log.ts`, record which kind of write happened last:

```ts
export type CommandLogWriteKind = "append-entry" | "append-output" | "append-header"
```

```ts
  /**
   * Which autoscroll transition the most recent write implies. lazygit assigns `Autoscroll = true`
   * in `LogAction` and `LogCommand` (pkg/gui/command_log_panel.go:38,62) and nowhere else — not in
   * the `prefixWriter` (pkg/gui/extras_panel.go:109-119), not in the header
   * (command_log_panel.go:70-85) — so the pane has to know which one it just received. Starts as
   * `"append-header"`, because the first write is the startup header.
   */
  private lastWrite: CommandLogWriteKind = "append-header"

  lastWriteKind(): CommandLogWriteKind {
    return this.lastWrite
  }
```

Set it as the first statement of each writer: `"append-entry"` in `logAction` and `logCommand`,
`"append-output"` in `logOutput`, `"append-header"` in `logIntro` and `logTip`. `logOutput`'s early
return for empty text comes *before* the assignment, so a no-op write changes nothing.

Then in `src/ui/root-view.ts`, where the log is updated on a model change:

```ts
    if (this.focusManager.logVisible) {
      const grew = model.commandLog.length > this.renderedCommandLogLength
      this.renderedCommandLogLength = model.commandLog.length
      if (grew) this.commandLog.applyScrollInput(this.commandLogWriteKind())
      this.commandLog.update(model.commandLog)
    }
```

Add the field and the accessor to `RootView`:

```ts
  private renderedCommandLogLength = 0
  /**
   * Which autoscroll transition the log's newest lines imply. `RootView` has no reference to the
   * `CommandLog`, only to the snapshot it produced, so `AppModel` carries the kind.
   */
  private commandLogWriteKind(): CommandLogScrollInput {
    return this.model.commandLogWriteKind ?? "append-entry"
  }
```

and add the field to the model. In `src/domain/repository.ts`, beside `commandLog`:

```ts
  /**
   * The autoscroll transition the log's most recent write implies — lazygit assigns
   * `Autoscroll = true` in `LogAction`/`LogCommand` (pkg/gui/command_log_panel.go:38,62) and not in
   * the `prefixWriter` or the header (pkg/gui/extras_panel.go:109-119,
   * command_log_panel.go:70-85), so the pane needs to know which one it just received.
   */
  readonly commandLogWriteKind?: CommandLogWriteKind
```

and in `src/app/controller.ts`, wherever `commandLog:` is assigned, add the sibling. Because there
are ~20 of those, extract a helper next to them and use it:

```ts
  /** The log snapshot every state assignment shares. */
  private commandLogSnapshot(): Pick<AppModel, "commandLog" | "commandLogWriteKind"> {
    const log = this.runner?.log
    if (log === undefined) return { commandLog: this.currentState.commandLog }
    return { commandLog: log.lines(), commandLogWriteKind: log.lastWriteKind() }
  }
```

Then replace each `commandLog: this.runner?.log.lines() ?? this.currentState.commandLog` with
`...this.commandLogSnapshot()`:

```bash
sed -i 's/commandLog: this\.runner?\.log\.lines() ?? this\.currentState\.commandLog/...this.commandLogSnapshot()/g' src/app/controller.ts
grep -c '\.\.\.this\.commandLogSnapshot()' src/app/controller.ts
```

Expected: the same count Task 2 Step 8 reported. Fix the two or three sites that used a different
spelling (`runner?.log.lines() ?? []` in the initial-state builder around line 241) by hand.

`exactOptionalPropertyTypes` is why `commandLogSnapshot` returns the field absent rather than
`undefined` in the no-runner branch.

- [ ] **Step 7: Arm autoscroll on focus loss**

In `src/ui/root-view.ts`'s `applyFocus` (around line 3485), where the pane's focus is set:

```ts
    // lazygit re-arms autoscroll when the command log loses focus
    // (pkg/gui/controllers/command_log_controller.go:29-33).
    const wasFocused = this.commandLogFocused
    this.commandLogFocused = active === "command-log"
    if (wasFocused && !this.commandLogFocused) this.commandLog.applyScrollInput("focus-lost")
    this.commandLog.setFocused(this.commandLogFocused)
```

with `private commandLogFocused = false` on the class.

- [ ] **Step 8: Run the gate**

Run: `bun run check`
Expected: all green.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
feat: give the command log lazygit's autoscroll

The pane pinned itself to the bottom on every update
(src/ui/panes/command-log-pane.ts:102) and swallowed wheel events with
preventDefault (:74-81), so scrolling back through the log was impossible: the
next refresh yanked it down again.

lazygit keeps a view flag instead. Every scroll handler assigns
Autoscroll = false — scrollUpExtra (extras_panel.go:49), scrollDownExtra (:57),
pageUpExtrasPanel (:65), pageDownExtrasPanel (:73), goToExtrasPanelTop (:81) —
except goToExtrasPanelBottom, which assigns true (:89). So holding `j` to the
bottom by hand leaves it off; only `>` re-arms it, or losing focus
(controllers/command_log_controller.go:29-33), or a new entry, because
LogAction and LogCommand both assign true (command_log_panel.go:38,62).

The prefixWriter does not: it writes straight to the view
(extras_panel.go:109-119) and scrolls only because the logCommand before it
armed the flag. Nor does printCommandLogHeader (command_log_panel.go:70-85).
That distinction is why AppModel carries a commandLogWriteKind: the view sees
only the snapshot, so the log tells it which kind of write just landed.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: `command-log` context keybindings

**Files:**
- Modify: `src/ui/bindings.ts:397-399`
- Modify: `src/ui/root-view.ts` (the `next`/`previous`/`page-*`/`goto-*` cases in `handleAction`, and the pane's mouse handlers)
- Test: `tests/ui/bindings.test.ts`

**Interfaces:**
- Consumes: `CommandLogPaneHandle.applyScrollInput` from Task 5.
- Produces: no new exports. `command-log` context bindings for `,` `.` `<` `>` `end` `home`.

- [ ] **Step 1: Write the failing test**

Add to `tests/ui/bindings.test.ts` (follow the file's existing helpers for building a model and a
`UiState`; the assertions below assume a `resolve(registry, key, { context, model, ui })` shape like
the file's other tests):

```ts
  /**
   * lazygit binds all of these on the extras view (pkg/gui/keybindings.go:249-295). They exist
   * globally in githunk already, but the command log needs its own entries so the handler can apply
   * the matching autoscroll transition rather than just moving the viewport.
   */
  test("the command log binds paging and jump keys in its own context", () => {
    for (const [key, action] of [[",", "page-previous"], [".", "page-next"], ["<", "goto-top"], [">", "goto-bottom"]] as const) {
      const binding = resolve(registry, key, { context: "command-log", model, ui })
      expect(binding?.action).toBe(action)
      expect(binding?.contexts).toContain("command-log")
    }
  })

  test("the command log still binds j/k and the arrows", () => {
    expect(resolve(registry, "j", { context: "command-log", model, ui })?.action).toBe("next")
    expect(resolve(registry, "k", { context: "command-log", model, ui })?.action).toBe("previous")
    expect(resolve(registry, "down", { context: "command-log", model, ui })?.action).toBe("next")
    expect(resolve(registry, "up", { context: "command-log", model, ui })?.action).toBe("previous")
  })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/ui/bindings.test.ts`
Expected: FAIL — the resolved bindings for `,` `.` `<` `>` have no `contexts`, because they resolve
to the global entries at `src/ui/bindings.ts:300-303`.

- [ ] **Step 3: Add the bindings**

In `src/ui/bindings.ts`, replace the `// ---- command log ----` block (lines 397-399):

```ts
  // ---- command log ----
  // lazygit binds these on the extras view (pkg/gui/keybindings.go:249-295). They duplicate the
  // global entries above so that the handler can apply lazygit's autoscroll transition, which
  // differs per key: every scroll clears the flag except goto-bottom, which sets it
  // (pkg/gui/extras_panel.go:49,57,65,73,81,89).
  { keys: ["j", "down"], action: "next", description: "down", contexts: ["command-log"] },
  { keys: ["k", "up"], action: "previous", description: "up", contexts: ["command-log"] },
  { keys: ["."], action: "page-next", description: "page down", contexts: ["command-log"] },
  { keys: [","], action: "page-previous", description: "page up", contexts: ["command-log"] },
  { keys: [">", "end"], action: "goto-bottom", description: "go to bottom", contexts: ["command-log"] },
  { keys: ["<", "home"], action: "goto-top", description: "go to top", contexts: ["command-log"] },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/ui/bindings.test.ts`
Expected: PASS.

- [ ] **Step 5: Apply the transitions in `handleAction`**

In `src/ui/root-view.ts`, the `next` / `previous` / `page-next` / `page-previous` / `goto-top` /
`goto-bottom` cases already branch on focus to scroll the log. Add the transition to each branch,
and let `applyScrollInput` do the bottom-pinning for `goto-bottom`:

```ts
      case "next":
        if (this.focusManager.active === "command-log") {
          this.commandLog.scrollBy(1)
          this.commandLog.applyScrollInput("scroll-down")
          return
        }
        // …existing list handling…
```

Mirror that for `previous` (`"scroll-up"`), `page-next` (`"page-down"`, scrolling by the pane
height), `page-previous` (`"page-up"`), `goto-top` (`"goto-top"`, then `scrollTo(0)`) and
`goto-bottom` (`"goto-bottom"` alone — the transition pins the viewport). The `page-*` delta is the
pane's visible height, matching lazygit's `PageDelta()` (`extras_panel.go:67,75`).

Where the existing cases scroll the log without a `command-log` branch, add one; where they already
have one, keep the scroll call and add the transition line beneath it.

- [ ] **Step 6: Apply the transitions on the mouse**

In `src/ui/root-view.ts`'s mouse-scroll dispatch (around line 3123 and 3336 where a hit resolves to
`command-log`), add the transition next to the scroll:

```ts
          if (hit.id === "command-log") {
            this.commandLog.scrollBy(delta)
            this.commandLog.applyScrollInput(delta < 0 ? "scroll-up" : "scroll-down")
            return
          }
```

Left click on the log focuses it, which it already does (root-view.ts:3336-3339); lazygit binds the
same (`keybindings.go:290-295`). No change there.

- [ ] **Step 7: Run the gate**

Run: `bun run check`
Expected: all green. `tests/ui/hints-bar.test.ts` may need its expected hint string updated if it
asserts the `command-log` context's hints; the new bindings add `page down`, `page up`,
`go to bottom` and `go to top` to that context's hint list.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
feat: bind paging and jump keys in the command log

lazygit binds the wheel, PrevItem/NextItem, PrevPage/NextPage and
GotoTop/GotoBottom on the extras view (pkg/gui/keybindings.go:249-289), plus
left click to focus it (:290-295). githunk bound only j/k and the arrows
(src/ui/bindings.ts:398-399), so `,` `.` `<` `>` fell through to the global
entries and moved the wrong pane.

They are context entries rather than a widened global because the autoscroll
side effect differs per key: every scroll handler clears the flag, including the
downward ones, and only goToExtrasPanelBottom sets it
(pkg/gui/extras_panel.go:49,57,65,73,81,89). The page delta is the pane's
visible height, matching PageDelta() (extras_panel.go:67,75).

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: An actionable menu component

**Files:**
- Create: `src/ui/action-menu.ts`
- Test: `tests/ui/action-menu.test.ts`

**Interfaces:**
- Consumes: `DEFAULT_BACKGROUND`, `DEFAULT_FOREGROUND` from `src/ui/theme.ts`; `Dimensions` from `src/ui/boxlayout.ts`.
- Produces: `ActionMenuItem = { readonly key: string; readonly label: string; readonly onPress: () => void }`, `renderActionMenuLines(items: readonly ActionMenuItem[], selectedIndex: number): readonly string[]`, `ActionMenuHandle` with `box`, `isOpen(): boolean`, `openMenu(title: string, items: readonly ActionMenuItem[]): void`, `close(): void`, `handleKey(name: string): boolean`, `layout(host: Dimensions, terminalHeight: number): void`, and `createActionMenu(renderer: CliRenderer): ActionMenuHandle`.

- [ ] **Step 1: Write the failing test**

Create `tests/ui/action-menu.test.ts`:

```ts
import { describe, expect, test } from "bun:test"
import { renderActionMenuLines, type ActionMenuItem } from "../../src/ui/action-menu"

const noop = (): void => {}

const items: readonly ActionMenuItem[] = [
  { key: "t", label: "Toggle show/hide command log", onPress: noop },
  { key: "f", label: "Focus command log", onPress: noop },
]

/**
 * lazygit's menus list each item's own accelerator beside its label
 * (pkg/gui/extras_panel.go:12-38 builds the command log one). The cursor marker follows githunk's
 * existing list panes rather than gocui's inverse-video selection, which OpenTUI would style
 * differently anyway.
 */
describe("renderActionMenuLines", () => {
  test("renders one line per item with its key", () => {
    expect(renderActionMenuLines(items, 0)).toEqual([
      "> t  Toggle show/hide command log",
      "  f  Focus command log",
    ])
  })

  test("moves the cursor marker to the selected item", () => {
    expect(renderActionMenuLines(items, 1)).toEqual([
      "  t  Toggle show/hide command log",
      "> f  Focus command log",
    ])
  })

  test("pads the key column to the widest key", () => {
    const wide: readonly ActionMenuItem[] = [
      { key: "t", label: "Short", onPress: noop },
      { key: "esc", label: "Long", onPress: noop },
    ]
    expect(renderActionMenuLines(wide, 0)).toEqual([
      "> t    Short",
      "  esc  Long",
    ])
  })

  test("renders nothing for no items", () => {
    expect(renderActionMenuLines([], 0)).toEqual([])
  })

  test("marks no row when the selection is out of range", () => {
    expect(renderActionMenuLines(items, 9)).toEqual([
      "  t  Toggle show/hide command log",
      "  f  Focus command log",
    ])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/ui/action-menu.test.ts`
Expected: FAIL — cannot resolve `../../src/ui/action-menu`.

- [ ] **Step 3: Write `src/ui/action-menu.ts`**

```ts
import { BoxRenderable, TextRenderable, type CliRenderer } from "@opentui/core"
import type { Dimensions } from "./boxlayout"
import { DEFAULT_BACKGROUND, DEFAULT_FOREGROUND } from "./theme"

/**
 * A titled, keyed, actionable menu — lazygit's `types.CreateMenuOptions` / `types.MenuItem`
 * (pkg/gui/extras_panel.go:12-38 builds the command log's). githunk already had a *read-only*
 * keybinding menu (./keybinding-menu.ts); this is the one whose items do something.
 *
 * Each item carries its own accelerator, as lazygit's `MenuItem.Keys` does, so `t` and `f` work
 * without moving a cursor first. `j`/`k` plus `enter` work too, and `escape` dismisses.
 */

export type ActionMenuItem = {
  /** The item's own accelerator, e.g. `"t"`. lazygit's `MenuItem.Keys`. */
  readonly key: string
  readonly label: string
  readonly onPress: () => void
}

export function renderActionMenuLines(items: readonly ActionMenuItem[], selectedIndex: number): readonly string[] {
  const keyWidth = items.reduce((widest, item) => Math.max(widest, item.key.length), 0)
  return items.map((item, index) =>
    `${index === selectedIndex ? ">" : " "} ${item.key.padEnd(keyWidth, " ")}  ${item.label}`,
  )
}

export type ActionMenuHandle = {
  readonly box: BoxRenderable
  isOpen(): boolean
  openMenu(title: string, items: readonly ActionMenuItem[]): void
  close(): void
  /** Returns true when the key was consumed, so the caller stops dispatching it. */
  handleKey(name: string): boolean
  layout(host: Dimensions, terminalHeight: number): void
}

export function createActionMenu(renderer: CliRenderer): ActionMenuHandle {
  const box = new BoxRenderable(renderer, {
    id: "action-menu",
    border: true,
    borderColor: DEFAULT_FOREGROUND,
    focusedBorderColor: DEFAULT_FOREGROUND,
    titleColor: DEFAULT_FOREGROUND,
    title: "",
    bottomTitle: "Escape to close",
    position: "absolute",
    overflow: "hidden",
    backgroundColor: DEFAULT_BACKGROUND,
  })
  const text = new TextRenderable(renderer, {
    id: "action-menu-text",
    content: "",
    fg: DEFAULT_FOREGROUND,
    selectable: false,
    wrapMode: "none",
    width: "100%",
    height: "100%",
  })
  box.add(text)
  box.visible = false

  let items: readonly ActionMenuItem[] = []
  let selectedIndex = 0
  let open = false

  const paint = (): void => {
    text.content = renderActionMenuLines(items, selectedIndex).join("\n")
  }

  return {
    box,
    isOpen: () => open,
    openMenu(title: string, nextItems: readonly ActionMenuItem[]) {
      open = true
      items = nextItems
      selectedIndex = 0
      box.title = title
      box.visible = true
      paint()
    },
    close() {
      open = false
      items = []
      selectedIndex = 0
      box.visible = false
    },
    handleKey(name: string): boolean {
      if (!open) return false
      if (name === "escape") {
        this.close()
        return true
      }
      if (name === "j" || name === "down") {
        selectedIndex = items.length === 0 ? 0 : (selectedIndex + 1) % items.length
        paint()
        return true
      }
      if (name === "k" || name === "up") {
        selectedIndex = items.length === 0 ? 0 : (selectedIndex - 1 + items.length) % items.length
        paint()
        return true
      }
      // An item's own key fires it wherever the cursor is, as lazygit's MenuItem.Keys do.
      const pressed = name === "return" || name === "enter"
        ? items[selectedIndex]
        : items.find((item) => item.key === name)
      if (pressed === undefined) return false
      // Closed before the handler runs: an item may itself open a panel or move focus, and it must
      // not have to fight a menu that is still up.
      this.close()
      pressed.onPress()
      return true
    },
    layout(host: Dimensions, terminalHeight: number) {
      if (!open) {
        box.visible = false
        return
      }
      const hostWidth = Math.max(1, host.x1 - host.x0 + 1)
      const hostHeight = Math.max(1, host.y1 - host.y0 + 1)
      const longest = items.reduce((widest, item) => Math.max(widest, item.key.length + item.label.length + 4), 0)
      const width = Math.max(20, Math.min(72, Math.min(hostWidth - 4, longest + 4)))
      const height = Math.max(3, Math.min(terminalHeight - 4, items.length + 2))
      box.left = host.x0 + Math.floor((hostWidth - width) / 2)
      box.top = host.y0 + Math.floor((hostHeight - height) / 2)
      box.width = width
      box.height = height
      box.visible = true
    },
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/ui/action-menu.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Run the gate and commit**

Run: `bun run check`
Expected: all green. The component is not wired up yet, which is fine — it is exercised by its test.

```bash
git add src/ui/action-menu.ts tests/ui/action-menu.test.ts
git commit -m "$(cat <<'EOF'
feat: add an actionable menu component

githunk had only a read-only keybinding menu (src/ui/keybinding-menu.ts).
lazygit's `@` opens a real menu whose items do something —
types.CreateMenuOptions with two MenuItems carrying their own accelerators
(pkg/gui/extras_panel.go:12-38) — so parity needs one of those.

Each item's key fires it wherever the cursor is, as MenuItem.Keys does, with
j/k plus enter and escape as well. The menu closes before the handler runs,
because an item may itself move focus or open a panel and should not have to
fight a menu that is still up — which is exactly what the command log's toggle
item does (extras_panel.go:19-29 pops the context first).

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: `@` opens the command log menu

**Files:**
- Modify: `src/ui/focus.ts:40-59`
- Modify: `src/ui/bindings.ts:292`
- Modify: `src/ui/root-view.ts` (the `command-log` action case, `modalInputActive`, `handleModalKey`, the layout pass, `toggleCommandLog`)
- Test: `tests/ui/focus.test.ts`

**Interfaces:**
- Consumes: `createActionMenu`, `ActionMenuItem` from Task 7.
- Produces: `FocusManager.handleKey` no longer handles `@`. `RootView` gains `private readonly actionMenu: ActionMenuHandle` and `private openCommandLogMenu(): void`.

- [ ] **Step 1: Write the failing test**

In `tests/ui/focus.test.ts`, replace whatever asserts the three-way `@` cycle with:

```ts
  /**
   * lazygit's `@` opens a menu (pkg/gui/keybindings.go:171-174 →
   * pkg/gui/extras_panel.go:12-38); it never toggles directly. FocusManager therefore knows nothing
   * about `@` any more — RootView owns the menu.
   */
  test("FocusManager does not handle @", () => {
    const manager = new FocusManager()
    expect(manager.handleKey("@")).toBe(false)
    expect(manager.logVisible).toBe(false)
    expect(manager.active).toBe("main")
  })

  test("still handles the numbered focus keys", () => {
    const manager = new FocusManager()
    expect(manager.handleKey("2")).toBe(true)
    expect(manager.active).toBe("files")
  })

  /** `handleFocusCommandLog` forces the window visible before focusing (extras_panel.go:40-46). */
  test("focusing the command log requires it to be visible", () => {
    const manager = new FocusManager()
    manager.focus("command-log")
    expect(manager.active).toBe("main")
    manager.logVisible = true
    manager.focus("command-log")
    expect(manager.active).toBe("command-log")
  })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/ui/focus.test.ts`
Expected: FAIL — `handleKey("@")` returns `true` and flips `logVisible`.

- [ ] **Step 3: Strip `@` from `FocusManager`**

In `src/ui/focus.ts`, replace `handleKey` (lines 40-59) with:

```ts
  handleKey(key: string): boolean {
    const numbered = focusIdForKey(key)
    if (numbered === undefined) return false
    this.focus(numbered)
    return true
  }
```

lazygit's `@` opens a menu rather than cycling (`keybindings.go:171-174`), and `RootView` owns
menus, so the cycle has no home here.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/ui/focus.test.ts`
Expected: PASS.

- [ ] **Step 5: Relabel the binding**

In `src/ui/bindings.ts:292`:

```ts
  // `Tr.OpenCommandLogMenu` (pkg/i18n/english.go:1853) behind Universal.ExtrasMenu, default "@"
  // (pkg/config/user_config.go:1072, pkg/gui/keybindings.go:171-174).
  { keys: ["@"], action: "command-log", description: "log", menuDescription: "view command log options" },
```

- [ ] **Step 6: Wire the menu into `RootView`**

Add the field and construction beside `keybindingMenu` (around line 463):

```ts
  private readonly actionMenu: ActionMenuHandle
```
```ts
    this.actionMenu = createActionMenu(renderer)
    this.root.add(this.actionMenu.box)
```

Replace the `command-log` action case (line 948):

```ts
      case "command-log": this.openCommandLogMenu(); return
```

Add the opener, copying `handleCreateExtrasMenuPanel` and `handleFocusCommandLog` item for item:

```ts
  /**
   * lazygit's `@` menu (pkg/gui/extras_panel.go:12-38). Labels are `Tr.CommandLog`,
   * `Tr.ToggleShowCommandLog` and `Tr.FocusCommandLog` verbatim
   * (pkg/i18n/english.go:1946,1949-1950).
   */
  private openCommandLogMenu(): void {
    this.actionMenu.openMenu("Command log", [
      {
        key: "t",
        label: "Toggle show/hide command log",
        onPress: () => {
          // "if the log is shown and focused, pop the context first" — extras_panel.go:20-23.
          if (this.focusManager.logVisible && this.focusManager.active === "command-log") {
            this.focusManager.focus(this.focusManager.lastSide)
          }
          this.focusManager.logVisible = !this.focusManager.logVisible
          // `gui.c.GetAppState().HideCommandLog = !show; SaveAppStateAndLogError()`
          // (extras_panel.go:26-27).
          this.persistUiState()
          this.applyFocus()
          this.recomputeLayout()
        },
      },
      {
        key: "f",
        label: "Focus command log",
        onPress: () => {
          // `SetShowExtrasWindow(true)` then push the context — extras_panel.go:40-46.
          this.focusManager.logVisible = true
          this.focusManager.focus("command-log")
          this.persistUiState()
          this.applyFocus()
          this.recomputeLayout()
        },
      },
    ])
    this.recomputeLayout()
  }
```

Use whatever the class already calls to persist UI state (the method that writes
`commandLogHeight`/`commandLogVisible`, around line 3454) in place of `persistUiState()`; if that
work happens only on exit, drop the two calls and note it in the commit body.

Delete `toggleCommandLog` (line 3477) and its only caller at line 3300 — that caller is the
horizontal splitter's double-click or similar; replace it with `this.openCommandLogMenu()` so the
gesture reaches the same place lazygit's `@` does.

- [ ] **Step 7: Make the menu modal and lay it out**

In `modalInputActive()` (line 599), add `this.actionMenu.isOpen() ||`.

In `handleModalKey` (line 1026), handle it first — before the `menuOpen` branch:

```ts
    if (this.actionMenu.isOpen()) {
      if (this.actionMenu.handleKey(key.name ?? "")) this.recomputeLayout()
      return
    }
```

In the layout pass (line 3585, beside the keybinding menu's positioning):

```ts
    const menuHost = windows.main ?? windows.hints
    if (menuHost !== undefined) this.actionMenu.layout(menuHost, this.geometry.terminalHeight)
    else this.actionMenu.close()
```

- [ ] **Step 8: Run the gate**

Run: `bun run check`
Expected: all green. `tests/ui/bindings.test.ts` and `tests/ui/hints-bar.test.ts` may assert the old
`menuDescription` for `@`; update those strings.

- [ ] **Step 9: Smoke it**

Run: `bun run start`, press `@`, confirm a "Command log" menu with `t` and `f`; press `t` to hide the
log, `@` then `t` to bring it back, `@` then `f` to focus it. Record what you observed.

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
feat: make @ open the command log menu

githunk's @ cycled hidden -> shown -> focused -> hidden inside FocusManager
(src/ui/focus.ts:46-59). lazygit's @ opens a menu
(pkg/gui/keybindings.go:171-174 -> pkg/gui/extras_panel.go:12-38) with two
items: `t` Toggle show/hide command log and `f` Focus command log
(pkg/i18n/english.go:1949-1950).

The two handlers are copied rather than approximated. `t` pops the context
first when the log is both shown and focused, so hiding a focused log does not
leave focus pointing at a window that is gone (extras_panel.go:20-23), and it
persists the choice as lazygit persists HideCommandLog (:26-27). `f` forces the
window visible before focusing, since you can ask to focus a hidden log
(:41-44).

FocusManager loses its @ branch entirely: menus belong to RootView, and there
is nothing left for it to cycle.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 9: Window sizing

**Files:**
- Modify: `src/ui/layout.ts:7-13,121-123,155-159`
- Test: `tests/ui/layout.test.ts`

**Interfaces:**
- Consumes: the `FocusId` type already imported by `src/ui/layout.ts:2`.
- Produces: `DEFAULT_LOG_HEIGHT` changes from `8` to `10`; new `MIN_HEIGHT_FOR_FULL_LOG = 40`. `computeLayout`'s `logHeight` gains the focused-fill and short-terminal branches.

- [ ] **Step 1: Write the failing test**

Add to `tests/ui/layout.test.ts`:

```ts
  /**
   * `getExtrasWindowSize` (pkg/gui/controllers/helpers/window_arrangement_helper.go:403-417):
   * focused -> 1000 ("my way of saying 'fill the available space'"), terminal height < 40 -> 1,
   * otherwise Gui.CommandLogSize (default 8, pkg/config/user_config.go:918) — and +2 for the frame
   * in every case. githunk's logHeight is a total including the border, so those are 8+2 and 1+2.
   */
  test("an unfocused log takes the configured height plus its frame", () => {
    const geometry = computeLayout({ width: 200, height: 60 }, { logVisible: true, focus: "files" })
    expect(geometry.logHeight).toBe(DEFAULT_LOG_HEIGHT)
    expect(DEFAULT_LOG_HEIGHT).toBe(10)
  })

  test("a focused log fills the space the main pane can spare", () => {
    const geometry = computeLayout({ width: 200, height: 60 }, { logVisible: true, focus: "command-log" })
    const bodyHeight = 60 - 1
    expect(geometry.logHeight).toBe(bodyHeight - SPLITTER_SIZE - MIN_MAIN_HEIGHT)
    expect(geometry.logHeight).toBeGreaterThan(DEFAULT_LOG_HEIGHT)
  })

  test("a terminal shorter than 40 rows gives the log one content row", () => {
    const geometry = computeLayout({ width: 200, height: 39 }, { logVisible: true, focus: "files" })
    expect(geometry.logHeight).toBe(MIN_LOG_HEIGHT)
    expect(MIN_LOG_HEIGHT).toBe(3)
  })

  test("focus still wins in a short terminal, as baseSize 1000 beats baseSize 1", () => {
    const geometry = computeLayout({ width: 200, height: 39 }, { logVisible: true, focus: "command-log" })
    expect(geometry.logHeight).toBeGreaterThan(MIN_LOG_HEIGHT)
  })

  test("a dragged height substitutes for lazygit's constant, and is still clamped", () => {
    const tall = computeLayout({ width: 200, height: 60 }, { logVisible: true, focus: "files", logHeight: 20 })
    expect(tall.logHeight).toBe(20)
    const overflowing = computeLayout({ width: 200, height: 60 }, { logVisible: true, focus: "files", logHeight: 500 })
    expect(overflowing.logHeight).toBe(59 - SPLITTER_SIZE - MIN_MAIN_HEIGHT)
  })

  test("a hidden log has no height whatever the focus says", () => {
    expect(computeLayout({ width: 200, height: 60 }, { logVisible: false, focus: "command-log" }).logHeight).toBe(0)
  })
```

Add `DEFAULT_LOG_HEIGHT`, `MIN_LOG_HEIGHT`, `SPLITTER_SIZE` and `MIN_MAIN_HEIGHT` to the file's
existing import from `../../src/ui/layout` if they are not already there.

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/ui/layout.test.ts`
Expected: FAIL — `DEFAULT_LOG_HEIGHT` is 8, the focused log is 8, and the 39-row terminal is 8.

- [ ] **Step 3: Change the constants**

In `src/ui/layout.ts`, replace lines 10 and 13's neighbourhood:

```ts
/**
 * `Gui.CommandLogSize`, default 8 (pkg/config/user_config.go:918), plus the 2-row frame
 * `getExtrasWindowSize` adds (window_arrangement_helper.go:415-417). githunk's `logHeight` is a
 * total including the border, so the default content area is 8 rows as lazygit's is.
 */
export const DEFAULT_LOG_HEIGHT = 10
```

and add beside `MIN_HEIGHT_FOR_TALL_SQUASHED`:

```ts
/**
 * Below this, `getExtrasWindowSize` drops the log to a single content row
 * (window_arrangement_helper.go:409-410) rather than letting it eat a short terminal.
 */
export const MIN_HEIGHT_FOR_FULL_LOG = 40
```

- [ ] **Step 4: Add the branches**

Replace lines 155-159:

```ts
  const logCapacity = bodyHeight - SPLITTER_SIZE - MIN_MAIN_HEIGHT
  // `getExtrasWindowSize` (window_arrangement_helper.go:403-417). The third branch takes the
  // requested height where lazygit takes its `commandLogSize` constant — which is itself a user
  // setting (pkg/config/user_config.go:191), so githunk's draggable splitter is the same knob with
  // a different input, not a divergence.
  const logHeight = !logVisible || mainWidth === 0 || logCapacity < MIN_LOG_HEIGHT
    ? 0
    : focus === COMMAND_LOG_FOCUS_ID
      ? logCapacity
      : terminalHeight < MIN_HEIGHT_FOR_FULL_LOG
        ? MIN_LOG_HEIGHT
        : clamp(requestedLog, MIN_LOG_HEIGHT, logCapacity)
```

Compare against the literal `"command-log"`, not against `COMMAND_LOG_FOCUS_ID`. `src/ui/focus.ts:12`
already imports `SideWindow` from this file; that import is type-only and erases, but importing a
*value* back the other way would turn the pair into a genuine runtime cycle. `FocusId` already
includes the literal, so `tsc` still catches a typo. Leave the existing
`import type { FocusId } from "./focus"` alone and note the reason:

```ts
  // Compared as a literal rather than through focus.ts's COMMAND_LOG_FOCUS_ID: focus.ts imports
  // from this file, and a value import back would make that a runtime cycle rather than a
  // type-only one. `FocusId` still makes a typo a compile error.
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test tests/ui/layout.test.ts`
Expected: PASS.

- [ ] **Step 6: Run the gate**

Run: `bun run check`
Expected: all green. `tests/ui/ui-state-store.integration.test.ts` may pin `DEFAULT_LOG_HEIGHT`'s
value; update it to 10. Existing layout tests that assumed a hidden log are unaffected.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
feat: size the command log the way lazygit sizes extras

getExtrasWindowSize has three branches plus a frame
(pkg/gui/controllers/helpers/window_arrangement_helper.go:403-417): the focused
window gets baseSize 1000, "my way of saying 'fill the available space'"; a
terminal under 40 rows gets 1; anything else gets Gui.CommandLogSize, default 8
(pkg/config/user_config.go:918). Every branch then adds frameSize 2.

githunk had none of that, and its DEFAULT_LOG_HEIGHT of 8 was a total including
the border, so the content area was 6 rows where lazygit's is 8. Hence 10.
MIN_LOG_HEIGHT was already 3, which is lazygit's short-terminal 1 + 2 exactly.

The third branch reads the requested height rather than a constant. That is not
a divergence: commandLogSize is itself a user setting
(pkg/config/user_config.go:191), so githunk's draggable splitter is the same
knob with a mouse instead of a YAML file. The focused and short-terminal
branches override it just as they override lazygit's constant, and root-view
persists the requested height rather than the computed geometry, so a focused
expansion is never written back.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 10: The log is shown by default

**Files:**
- Modify: `src/ui/ui-state-store.ts:13-19`
- Modify: `src/ui/root-view.ts:362`
- Test: `tests/ui/ui-state-store.integration.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `defaultUiState().commandLogVisible === true`.

- [ ] **Step 1: Write the failing test**

Add to `tests/ui/ui-state-store.integration.test.ts`:

```ts
  /**
   * `Gui.ShowCommandLog: true` (pkg/config/user_config.go:901), and
   * `gui.ShowExtrasWindow = userConfig.Gui.ShowCommandLog && !GetAppState().HideCommandLog`
   * (pkg/gui/gui.go:523) — so shown unless the user hid it, and the persisted choice wins.
   */
  test("the command log is shown by default", () => {
    expect(defaultUiState().commandLogVisible).toBe(true)
    expect(defaultUiState().commandLogHeight).toBe(DEFAULT_LOG_HEIGHT)
  })

  test("a persisted hidden log still wins, as HideCommandLog does", async () => {
    const store = new UiStateStore(runner)
    await store.save({ sidePanelRatio: 0.4, commandLogHeight: 12, commandLogVisible: false })
    expect((await store.load()).commandLogVisible).toBe(false)
  })
```

Match the file's existing helpers for constructing `runner` and calling `save`; if the store's
persist method has a different name, use that.

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/ui/ui-state-store.integration.test.ts`
Expected: FAIL — `commandLogVisible` is `false`.

- [ ] **Step 3: Flip the defaults**

In `src/ui/ui-state-store.ts:13-19`:

```ts
export function defaultUiState(): UiState {
  return {
    sidePanelRatio: DEFAULT_SIDE_PANEL_RATIO,
    commandLogHeight: DEFAULT_LOG_HEIGHT,
    // `Gui.ShowCommandLog: true` (pkg/config/user_config.go:901). A persisted `false` still wins,
    // which is lazygit's `HideCommandLog` app-state flag (pkg/gui/gui.go:523).
    commandLogVisible: true,
  }
}
```

In `src/ui/root-view.ts:362`:

```ts
    // Shown unless the caller says otherwise, matching `Gui.ShowCommandLog: true`
    // (pkg/config/user_config.go:901).
    this.focusManager.logVisible = options.logVisible ?? true
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/ui/ui-state-store.integration.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the gate**

Run: `bun run check`
Expected: several UI tests may now see a visible log where they assumed a hidden one — in particular
`tests/ui/layout.test.ts`, `tests/ui/focus.test.ts`, `tests/ui/mouse-parity.integration.test.ts` and
`tests/acceptance/review-workflow.integration.test.ts`. For each failure, decide deliberately:

- a test about the log's own behaviour should pass `logVisible: true` explicitly and keep asserting;
- a test about something else should pass `logVisible: false` explicitly, so its geometry is stated
  rather than inherited.

Do not change a production default to make a test pass.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
feat: show the command log by default

lazygit ships Gui.ShowCommandLog: true (pkg/config/user_config.go:901) and
computes the window's visibility as
ShowCommandLog && !GetAppState().HideCommandLog (pkg/gui/gui.go:523): shown
out of the box, hidden only if the user hid it. githunk defaulted to hidden
(src/ui/ui-state-store.ts:17, src/ui/root-view.ts:362), so a first run showed
none of the log this branch has been rebuilding.

A persisted false still wins, which is exactly what HideCommandLog is.

Tests that assumed a hidden log now state their geometry explicitly rather
than inheriting it, so a future default change cannot silently retarget them.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 11: Action labels

**Files:**
- Create: `src/app/log-actions.ts`
- Modify: `src/app/controller.ts` (20 mutation methods)
- Test: `tests/app/log-actions.test.ts`

**Interfaces:**
- Consumes: `CommandLog.logAction` from Task 2.
- Produces: `LOG_ACTIONS` (a frozen record of label strings) and `AppController`'s private `logAction(action: string): void`.

- [ ] **Step 1: Write the failing test**

Create `tests/app/log-actions.test.ts`:

```ts
import { describe, expect, test } from "bun:test"
import { AppController } from "../../src/app/controller"
import { CommandLog } from "../../src/app/command-log"
import { LOG_ACTIONS } from "../../src/app/log-actions"
import { GitRunner } from "../../src/git/runner"
import type { GitMutations } from "../../src/git/mutations"
import type { WorkingTreeSnapshot } from "../../src/domain/repository"

function snapshot(): WorkingTreeSnapshot {
  return {
    repositoryRoot: "/tmp/repo",
    branch: "main",
    upstream: "origin/main",
    reviewTarget: { kind: "working-tree", scope: "all" },
    files: [],
    patches: [{ label: "UNSTAGED", text: "" }],
  }
}

/** No git runs: every method under test is stubbed, so only the label reaches the log. */
function stubMutations(): GitMutations {
  const noop = async (): Promise<void> => {}
  return {
    stageFile: noop,
    unstageFile: noop,
    discardFile: noop,
    applySelection: noop,
    discardSelection: noop,
  } as unknown as GitMutations
}

function harness(): { readonly controller: AppController; readonly log: CommandLog } {
  const log = new CommandLog()
  const controller = new AppController({
    repositoryRoot: "/tmp/repo",
    runner: new GitRunner({ cwd: "/tmp/repo", log }),
    load: async () => snapshot(),
    mutations: stubMutations(),
    commitMutations: { commit: async () => {}, amend: async () => {}, currentMessage: async () => "" } as never,
  })
  return { controller, log }
}

function actions(log: CommandLog): readonly string[] {
  return log.lines()
    .filter((line) => line.spans.some((span) => span.style === "action"))
    .map((line) => line.spans.map((span) => span.text).join(""))
}

/**
 * lazygit calls LogAction from its UI controllers, the layer where one user intent becomes N git
 * commands (pkg/gui/controllers/files_controller.go:544,559; stash_controller.go:127,141,169;
 * sync_controller.go:167,197). githunk's equivalent layer is AppController — its mutation methods
 * map one-to-one onto user intents, and unlike root-view they run without a renderer.
 */
describe("action labels", () => {
  test("stageFile logs Stage file", async () => {
    const { controller, log } = harness()
    await controller.refresh()
    await controller.stageFile("a.ts")
    expect(actions(log)).toContain(LOG_ACTIONS.stageFile)
    expect(LOG_ACTIONS.stageFile).toBe("Stage file")
  })

  test("unstageFile logs Unstage file", async () => {
    const { controller, log } = harness()
    await controller.refresh()
    await controller.unstageFile("a.ts")
    expect(actions(log)).toContain("Unstage file")
  })

  test("discardFile logs lazygit's plural label verbatim", async () => {
    const { controller, log } = harness()
    await controller.refresh()
    await controller.discardFile("a.ts")
    expect(actions(log)).toContain("Discard all changes in selected file(s)")
  })

  test("commit and amend log their own labels", async () => {
    const { controller, log } = harness()
    await controller.refresh()
    await controller.commit("m")
    await controller.amend("m")
    expect(actions(log)).toEqual(["Commit", "Amend commit"])
  })

  /** The guard runs first: a read-only target must not log an action it will not perform. */
  test("a blocked mutation logs nothing", async () => {
    const { controller, log } = harness()
    await controller.refresh()
    await controller.switchMode("branch")
    await controller.stageFile("a.ts")
    expect(actions(log)).toEqual([])
  })

  test("every label is one of lazygit's strings, with no trailing punctuation", () => {
    for (const label of Object.values(LOG_ACTIONS)) {
      expect(label.length).toBeGreaterThan(0)
      expect(label).not.toMatch(/[.:]$/)
      expect(label[0]).toBe(label[0]?.toUpperCase())
    }
  })
})
```

If `switchMode("branch")` is not enough to make `ensureWorkingTreeMutation` fail in this harness,
use whatever the existing `tests/app/controller.test.ts` does to reach a branch target.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/app/log-actions.test.ts`
Expected: FAIL — cannot resolve `../../src/app/log-actions`.

- [ ] **Step 3: Write `src/app/log-actions.ts`**

```ts
/**
 * lazygit's action labels, copied verbatim from its `Actions` translations
 * (pkg/i18n/english.go:2128-2254). An action groups the commands logged under it — "typically
 * there's only one command under an action but there may be more"
 * (pkg/gui/command_log_panel.go:14-24).
 *
 * Only actions that reach git get one. githunk's own review actions (marking a file reviewed,
 * changing the compare base) run no command, and lazygit labels nothing that runs no command.
 */
export const LOG_ACTIONS = {
  /** files_controller.go:625 -> :544 */
  stageFile: "Stage file",
  /** files_controller.go:625 -> :559 */
  unstageFile: "Unstage file",
  /** files_controller.go:960 -> :544 */
  stageAllFiles: "Stage all files",
  /** files_controller.go:960 -> :559 */
  unstageAllFiles: "Unstage all files",
  /** files_controller.go:1744; english.go:2173 */
  discardAllChangesInFile: "Discard all changes in selected file(s)",
  /**
   * staging_controller.go:239-265; english.go:2215. Both staging and discarding a selection:
   * `DiscardSelection` (:213) routes through `applySelectionAndRefresh(true)` into the same
   * `applySelection`, so lazygit labels the two identically. (:332 is `editHunk`, a feature
   * githunk does not have.)
   */
  applyPatch: "Apply patch",
  /** english.go:2192 */
  commit: "Commit",
  /** amend_helper.go:22; english.go:2151 */
  amendCommit: "Amend commit",
  /** sync_controller.go:197; english.go:2193 */
  push: "Push",
  /** sync_controller.go:167; english.go:2194 */
  pull: "Pull",
  /** files_controller.go:1541 — a hardcoded string in lazygit, not an `Actions` entry. */
  fetch: "Fetch",
  /** branches_controller.go:417,516; english.go:2134 */
  checkoutBranch: "Checkout branch",
  /** english.go:2142 */
  createBranch: "Create branch",
  /** english.go:2137 */
  deleteLocalBranch: "Delete local branch",
  /** english.go:2141 */
  renameBranch: "Rename branch",
  /** english.go:2210 */
  setBranchUpstream: "Set branch upstream",
  /** files_controller.go:1516; english.go:2196 */
  stashAllChanges: "Stash all changes",
  /** files_controller.go:1516; english.go:2198 */
  stashStagedChanges: "Stash staged changes",
  /** stash_controller.go:127; english.go:2218 */
  applyStash: "Apply stash",
  /** stash_controller.go:141; english.go:2217 */
  popStash: "Pop stash",
  /** stash_controller.go:169; english.go:2219 */
  dropStash: "Drop stash",
  /** files_helper.go:78; english.go:2195 */
  openFile: "Open file",
} as const
```

- [ ] **Step 4: Add the emitter and the calls**

In `src/app/controller.ts`, add the private method next to `runMutation`:

```ts
  /**
   * lazygit's `LogAction`, called from its UI controllers — the layer where one user intent becomes
   * N git commands (pkg/gui/controllers/files_controller.go:544,559;
   * pkg/gui/controllers/stash_controller.go:127,141,169;
   * pkg/gui/controllers/sync_controller.go:167,197). This controller is githunk's equivalent: its
   * mutation methods map one-to-one onto user intents, where `root-view.ts` corresponds to
   * lazygit's keybinding table and views.
   *
   * Always after the guard, so a mutation the target refuses logs nothing.
   */
  private logAction(action: string): void {
    this.runner?.log.logAction(action)
  }
```

Then insert one call per mutation, immediately after its guard:

| Line (before edits) | Method | Inserted call |
| --- | --- | --- |
| 493 | `switchLocalBranch` | `this.logAction(LOG_ACTIONS.checkoutBranch)` |
| 497 | `createBranch` | `this.logAction(LOG_ACTIONS.createBranch)` |
| 500 | `createStash` | see below |
| 504 | `applyStash` | `this.logAction(LOG_ACTIONS.applyStash)` |
| 508 | `popStash` | `this.logAction(LOG_ACTIONS.popStash)` |
| 518 | `dropStash` | `this.logAction(LOG_ACTIONS.dropStash)` |
| 534 | `fetch` | `this.logAction(LOG_ACTIONS.fetch)` — but only when not background; see below |
| 538 | `pull` | `this.logAction(LOG_ACTIONS.pull)` |
| 566 | `push` | `this.logAction(LOG_ACTIONS.push)` |
| 585 | `deleteBranch` | `this.logAction(LOG_ACTIONS.deleteLocalBranch)` |
| 589 | `renameBranch` | `this.logAction(LOG_ACTIONS.renameBranch)` |
| 593 | `fetchRemote` | `this.logAction(LOG_ACTIONS.fetch)` |
| 635 | `checkoutRemoteTracking` | `this.logAction(LOG_ACTIONS.checkoutBranch)` |
| 864 | `commit` | `this.logAction(LOG_ACTIONS.commit)` |
| 869 | `amend` | `this.logAction(LOG_ACTIONS.amendCommit)` |
| 882 | `stageFile` | `this.logAction(LOG_ACTIONS.stageFile)` |
| 887 | `unstageFile` | `this.logAction(LOG_ACTIONS.unstageFile)` |
| 892 | `applySelection` | `this.logAction(LOG_ACTIONS.applyPatch)` |
| 897 | `discardSelection` | `this.logAction(LOG_ACTIONS.applyPatch)` |
| 902 | `discardFile` | `this.logAction(LOG_ACTIONS.discardAllChangesInFile)` |
| 908 | `toggleAllFiles` | see below |

`chooseUpstream` (line 556) delegates to `pull` or `push`, and `switchLocal` (line 490) delegates to
`switchLocalBranch`. Neither logs, so one keypress never produces two labels. `chooseUpstream` does
add its own label first, because setting the upstream is a distinct intent lazygit labels
separately:

```ts
  async chooseUpstream(remote: string, branch: string): Promise<void> {
    const choice = this.currentState.upstreamChoice
    if (choice === undefined) return
    this.logAction(LOG_ACTIONS.setBranchUpstream)
    const upstream = { remote, branch }
```

`createStash` picks its label from the options, as `handleStashSave`'s caller does
(`files_controller.go:1509-1516`):

```ts
  async createStash(message: string, options: StashCreateOptions): Promise<void> {
    if (!this.ensureWorkingTreeMutation()) return
    this.logAction(options.stagedOnly === true ? LOG_ACTIONS.stashStagedChanges : LOG_ACTIONS.stashAllChanges)
    await this.runMutation(…)
```

Use whichever field of `StashCreateOptions` means "staged only"; if there is no such field, log
`LOG_ACTIONS.stashAllChanges` unconditionally and say so in the commit body.

`toggleAllFiles` already computes `shouldStage`; the label goes right after it, matching
`toggleStaged`'s two `LogAction` sites (`files_controller.go:544,559`):

```ts
      const shouldStage = files.some((file) => file.untracked || file.worktreeStatus !== ".")
      this.logAction(shouldStage ? LOG_ACTIONS.stageAllFiles : LOG_ACTIONS.unstageAllFiles)
```

`fetch` must not label the background pass — lazygit's background fetch is `DontLog()` entirely
(`sync.go:81`), which means no action label either:

```ts
  async fetch(remote?: string, options: { readonly background?: boolean } = {}): Promise<void> {
    if (!this.ensureWorkingTreeMutation()) return
    if (options.background !== true) this.logAction(LOG_ACTIONS.fetch)
    await this.runMutation(() => this.requireRunnerOperation((runner) => fetchSync(runner, remote, options)))
  }
```

Add the import:

```ts
import { LOG_ACTIONS } from "./log-actions"
```

- [ ] **Step 5: Label the editor path**

`Open file` (`files_helper.go:78`) is driven from `src/ui/root-view.ts`'s `actionEdit`, not from
`AppController`, because opening an editor is not a git mutation. Log it where the edit is invoked —
in `src/app/create-app.ts`, at the `onEditFile` wiring:

```ts
      // `LogAction(Tr.Actions.OpenFile)` (pkg/gui/controllers/helpers/files_helper.go:78).
      options.runner.log.logAction(LOG_ACTIONS.openFile)
```

immediately before the call that opens the editor.

- [ ] **Step 6: Run tests to verify they pass**

Run: `bun test tests/app/log-actions.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 7: Run the gate**

Run: `bun run check`
Expected: all green.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
feat: label every mutation the way lazygit labels it

lazygit's log is two interleaved kinds of line: a yellow action naming what the
user asked for, then the commands it ran (pkg/gui/command_log_panel.go:14-24).
githunk had only the commands, so the log read as a transcript rather than as a
history of intents.

LogAction has 151 call sites in lazygit, all in its UI controllers — the layer
where one intent becomes N git commands (files_controller.go:544,559;
stash_controller.go:127,141,169; sync_controller.go:167,197). AppController is
githunk's equivalent layer: its mutation methods map one-to-one onto intents,
where root-view.ts corresponds to lazygit's keybinding table and views. It is
also the layer that runs without a renderer, which is what lets the labels be
unit-tested.

Labels are copied verbatim from Actions (english.go:2128-2254), including the
plural "Discard all changes in selected file(s)" (:2173) and the fact that
"Fetch" is a hardcoded string in lazygit rather than an Actions entry
(files_controller.go:1541).

Each call sits after its guard, so a mutation a read-only target refuses logs
nothing. Delegating methods stay silent — switchLocal defers to
switchLocalBranch, chooseUpstream to pull/push — so one keypress never produces
two labels. toggleAllFiles picks between Stage all files and Unstage all files
from the same shouldStage test lazygit uses (files_controller.go:534-559), and
the background fetch labels nothing, since lazygit's is DontLog() outright
(sync.go:81).

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 12: Startup header and random tip

**Files:**
- Create: `src/app/command-log-tips.ts`
- Modify: `src/app/create-app.ts`
- Test: `tests/app/command-log-tips.test.ts`

**Interfaces:**
- Consumes: `CommandLog.logIntro` / `logTip` from Task 2; `GITHUNK_BINDINGS` / `BindingRegistry` from `src/ui/bindings.ts` for the test only.
- Produces: `COMMAND_LOG_HEADER`, `RANDOM_TIP_LABEL`, `COMMAND_LOG_TIP_KEYS`, `COMMAND_LOG_TIPS: readonly string[]`, `randomTip(pick?: (count: number) => number): string`, `seedCommandLog(log: CommandLog, options?: { readonly showRandomTip?: boolean; readonly pick?: (count: number) => number }): void`.

- [ ] **Step 1: Write the failing test**

Create `tests/app/command-log-tips.test.ts`:

```ts
import { describe, expect, test } from "bun:test"
import { CommandLog } from "../../src/app/command-log"
import {
  COMMAND_LOG_HEADER,
  COMMAND_LOG_TIPS,
  COMMAND_LOG_TIP_KEYS,
  RANDOM_TIP_LABEL,
  randomTip,
  seedCommandLog,
} from "../../src/app/command-log-tips"
import { BindingRegistry, GITHUNK_BINDINGS } from "../../src/ui/bindings"

function texts(log: CommandLog): readonly string[] {
  return log.lines().map((line) => line.spans.map((span) => span.text).join(""))
}

describe("command log header", () => {
  /** `CommandLogHeader` formatted with `Universal.ExtrasMenu` (english.go:1951, user_config.go:1072). */
  test("names the key that hides and focuses the panel", () => {
    expect(COMMAND_LOG_HEADER).toBe("You can hide/focus this panel by pressing '@'")
  })

  test("seeds the intro, its blank line, and a tip", () => {
    const log = new CommandLog()
    seedCommandLog(log, { showRandomTip: true, pick: () => 0 })
    expect(texts(log)).toEqual([COMMAND_LOG_HEADER, "", `${RANDOM_TIP_LABEL}: ${COMMAND_LOG_TIPS[0]}`])
  })

  /** `Gui.ShowRandomTip` (user_config.go:909) is on by default but can be off. */
  test("omits the tip when tips are off", () => {
    const log = new CommandLog()
    seedCommandLog(log, { showRandomTip: false })
    expect(texts(log)).toEqual([COMMAND_LOG_HEADER, ""])
  })

  test("the seeded header does not arm autoscroll", () => {
    const log = new CommandLog()
    seedCommandLog(log, { showRandomTip: true, pick: () => 0 })
    expect(log.lastWriteKind()).toBe("append-header")
  })
})

describe("random tips", () => {
  test("picks within range and returns a tip", () => {
    expect(randomTip(() => 0)).toBe(COMMAND_LOG_TIPS[0])
    expect(COMMAND_LOG_TIPS).toContain(randomTip())
  })

  test("has no empty or duplicated tips", () => {
    expect(new Set(COMMAND_LOG_TIPS).size).toBe(COMMAND_LOG_TIPS.length)
    for (const tip of COMMAND_LOG_TIPS) expect(tip.trim().length).toBeGreaterThan(0)
  })

  /**
   * The catalogue is the subset of lazygit's (command_log_panel.go:90-199) whose feature *and*
   * keybinding exist in githunk — a tip naming a key githunk does not bind would tell the user to
   * press nothing. This test is what keeps that true: rebinding a key breaks it rather than
   * silently making a tip lie.
   */
  test("every key a tip names is still bound to the action the tip describes", () => {
    const registry = new BindingRegistry(GITHUNK_BINDINGS)
    for (const [key, expected] of Object.entries(COMMAND_LOG_TIP_KEYS)) {
      const bound = registry.bindings.some((binding) => binding.action === expected.action && binding.keys.includes(expected.key))
      expect(bound).toBe(true)
      expect(COMMAND_LOG_TIPS.some((tip) => tip.includes(`'${expected.label}'`))).toBe(true)
    }
    // Every pinned key must actually be referenced by a tip; an orphan entry means a tip was
    // dropped without its key, and the loop above would not notice.
    expect(Object.keys(COMMAND_LOG_TIP_KEYS)).toHaveLength(8)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/app/command-log-tips.test.ts`
Expected: FAIL — cannot resolve `../../src/app/command-log-tips`.

- [ ] **Step 3: Write `src/app/command-log-tips.ts`**

```ts
import type { CommandLog } from "./command-log"

/**
 * lazygit's startup header for the command log (`printCommandLogHeader`,
 * pkg/gui/command_log_panel.go:70-85): a cyan line naming the key that hides and focuses the
 * panel, then — when `Gui.ShowRandomTip` is on, which it is by default
 * (pkg/config/user_config.go:909) — a yellow label and a green tip.
 */

/** `Tr.CommandLogHeader` (pkg/i18n/english.go:1951) formatted with `Universal.ExtrasMenu`, "@". */
export const COMMAND_LOG_HEADER = "You can hide/focus this panel by pressing '@'"

/** `Tr.RandomTip` (pkg/i18n/english.go:1952). */
export const RANDOM_TIP_LABEL = "Random tip"

/**
 * The keys the keybinding tips name. lazygit interpolates its own config values
 * (`config.Universal.PrevPage` and friends, command_log_panel.go:90-174); githunk's equivalents are
 * pinned here so `tests/app/command-log-tips.test.ts` fails if one is rebound, rather than the tip
 * quietly telling the user to press a key that does nothing.
 */
export const COMMAND_LOG_TIP_KEYS = {
  stashInspect: { key: "enter", label: "enter", action: "stash-inspect" },
  pagePrevious: { key: ",", label: ",", action: "page-previous" },
  pageNext: { key: ".", label: ".", action: "page-next" },
  gotoTop: { key: "<", label: "<", action: "goto-top" },
  gotoBottom: { key: ">", label: ">", action: "goto-bottom" },
  enterDirectory: { key: "enter", label: "enter", action: "inspect" },
  paneNext: { key: "l", label: "l", action: "pane-next" },
  panePrevious: { key: "h", label: "h", action: "pane-previous" },
} as const

/**
 * lazygit's tips, restricted to those whose feature and keybinding both exist in githunk.
 *
 * Excluded, and why: force push, filter-commits-by-path, interactive rebase, undo/redo, reset
 * options, push tag, the diffing menu, drop commit, merge options, revert commit, bisect, custom
 * commands, delta and the bare-repo flags all name features githunk does not implement; the
 * escape-a-mode tip depends on `quitOnTopLevelReturn`, which githunk has no equivalent of; the
 * amend tip names `Files.AmendLastCommit` in the files panel, where githunk's `A` is global; and
 * "join the team" and "raise an issue" point at lazygit's own project. A tip joins this list when
 * githunk gains the feature it names.
 */
export const COMMAND_LOG_TIPS: readonly string[] = [
  // command_log_panel.go:124-127
  `You can view the individual files of a stash entry by pressing '${COMMAND_LOG_TIP_KEYS.stashInspect.label}'`,
  // :149-153
  `You can page through the items of a panel using '${COMMAND_LOG_TIP_KEYS.pagePrevious.label}' and '${COMMAND_LOG_TIP_KEYS.pageNext.label}'`,
  // :154-157
  `You can jump to the top/bottom of a panel using '${COMMAND_LOG_TIP_KEYS.gotoTop.label}' and '${COMMAND_LOG_TIP_KEYS.gotoBottom.label}'`,
  // :158-161
  `To collapse/expand a directory, press '${COMMAND_LOG_TIP_KEYS.enterDirectory.label}'`,
  // :170-174
  `You can now navigate the side panels with '${COMMAND_LOG_TIP_KEYS.paneNext.label}' and '${COMMAND_LOG_TIP_KEYS.panePrevious.label}'`,
  // The general advice, verbatim and key-free (:178-184).
  "`git commit` is really just the programmer equivalent of saving your game. Always do it before embarking on an ambitious change!",
  "Try to separate commits that refactor code from commits that add new functionality: if they're squashed into one commit, it can be hard to spot what's new.",
  "If you ever want to experiment, it's easy to create a new branch off your current one and go nuts, then delete it afterwards",
  "Always read through the diff of your changes before assigning somebody to review your code. Better for you to catch any silly mistakes than your colleagues!",
  "If something goes wrong, you can always checkout a commit from your reflog to return to an earlier state",
  "The stash is a good place to save snippets of code that you always find yourself adding when debugging.",
]

/** `rand.Intn(len(tips))` (pkg/gui/command_log_panel.go:201-203). */
export function randomTip(pick: (count: number) => number = (count) => Math.floor(Math.random() * count)): string {
  const index = Math.min(Math.max(0, Math.floor(pick(COMMAND_LOG_TIPS.length))), COMMAND_LOG_TIPS.length - 1)
  return COMMAND_LOG_TIPS[index] ?? ""
}

export type SeedCommandLogOptions = {
  /** `Gui.ShowRandomTip`, default true (pkg/config/user_config.go:909). */
  readonly showRandomTip?: boolean
  readonly pick?: (count: number) => number
}

export function seedCommandLog(log: CommandLog, options: SeedCommandLogOptions = {}): void {
  log.logIntro(COMMAND_LOG_HEADER)
  if (options.showRandomTip === false) return
  log.logTip(RANDOM_TIP_LABEL, randomTip(options.pick))
}
```

- [ ] **Step 4: Seed the log at startup**

In `src/app/create-app.ts`, immediately after the runner's log is available and before the
controller is constructed — the controller's first state snapshot should already carry the header:

```ts
  // `printCommandLogHeader` runs at startup (pkg/gui/command_log_panel.go:70-85).
  seedCommandLog(options.runner.log)
```

with `import { seedCommandLog } from "./command-log-tips"`.

Seed it in the headless path too: the header is data, not a timer or a subprocess, and a test that
asserts on the log's first lines should see the same thing the app does.

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test tests/app/command-log-tips.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 6: Run the gate**

Run: `bun run check`
Expected: `tests/app/command-log.test.ts` still passes — it constructs its own `CommandLog` and never
seeds. Tests that assert on the whole of `controller.state.commandLog` will now see three extra
leading lines; adjust them to assert on a slice or a `toContain` rather than deleting the assertion.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
feat: seed the command log with lazygit's header and a random tip

printCommandLogHeader writes a cyan line naming the key that hides and focuses
the panel, then a yellow label and a green tip when Gui.ShowRandomTip is on,
which it is by default (pkg/gui/command_log_panel.go:70-85,
pkg/config/user_config.go:909). githunk showed an empty pane reading "No
commands recorded".

The tip catalogue is lazygit's (command_log_panel.go:90-199) restricted to tips
whose feature *and* keybinding exist in githunk, because lazygit interpolates
its own config keys and a tip naming a key githunk does not bind would tell the
user to press nothing. Excluded: force push, filter-commits-by-path,
interactive rebase, undo/redo, reset options, push tag, the diffing menu, drop
commit, merge options, revert commit, bisect, custom commands, delta and the
bare-repo flags name features githunk does not implement; the escape-a-mode tip
depends on quitOnTopLevelReturn; the amend tip names Files.AmendLastCommit in
the files panel where githunk's A is global; and "join the team" and "raise an
issue" point at lazygit's project. That leaves five keybinding tips and the six
key-free pieces of general advice, all verbatim.

The keys the tips name are pinned in COMMAND_LOG_TIP_KEYS and checked against
GITHUNK_BINDINGS by a test, so rebinding one breaks the build instead of making
a tip lie.

The header writes through logIntro/logTip, which do not arm autoscroll — lazygit
assigns Autoscroll only in LogAction and LogCommand
(command_log_panel.go:38,62), not in the header.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 13: Acceptance test and parity matrix

**Files:**
- Create: `tests/acceptance/command-log.integration.test.ts`
- Modify: `docs/lazygit-compatibility-v0.1.md:25`
- Test: the new acceptance file is the test.

**Interfaces:**
- Consumes: everything above; `tests/helpers/temp-repository.ts` and `tests/helpers/shell-harness.ts`.
- Produces: nothing.

- [ ] **Step 1: Write the failing test**

Create `tests/acceptance/command-log.integration.test.ts`, following the patterns in
`tests/acceptance/review-workflow.integration.test.ts` for building a temp repository and a headless
app:

```ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { createTempRepository, type TempRepository } from "../helpers/temp-repository"
import { CommandLog } from "../../src/app/command-log"
import { GitRunner } from "../../src/git/runner"
import { createApp } from "../../src/app/create-app"

describe("command log", () => {
  let repo: TempRepository
  let log: CommandLog

  beforeEach(async () => {
    repo = await createTempRepository()
    await repo.write("a.txt", "one\n")
    await repo.git(["add", "a.txt"])
    await repo.git(["commit", "-m", "first"])
    log = new CommandLog()
  })

  afterEach(async () => {
    await repo.cleanup()
  })

  function texts(): readonly string[] {
    return log.lines().map((line) => line.spans.map((span) => span.text).join(""))
  }

  /**
   * The whole point of the dontLog rule: lazygit's log shows what the user did, not what the app
   * asked git about. A 10-second refresh used to bury the former under the latter.
   */
  test("a refresh puts no loader command in the log", async () => {
    const app = await createApp({ repositoryRoot: repo.path, runner: new GitRunner({ cwd: repo.path, log }) })
    await app.refresh()
    const commands = texts().filter((text) => text.startsWith("  git "))
    expect(commands).toEqual([])
  })

  test("staging then committing logs each action above its command, in order", async () => {
    const app = await createApp({ repositoryRoot: repo.path, runner: new GitRunner({ cwd: repo.path, log }) })
    await repo.write("a.txt", "two\n")
    await app.refresh()
    await app.controller.stageFile("a.txt")
    await app.controller.commit("second\n")

    const meaningful = texts().filter((text) => text === "Stage file" || text === "Commit" || text.startsWith("  git "))
    expect(meaningful).toEqual([
      "Stage file",
      "  git add -- a.txt",
      "Commit",
      "  git commit -F -",
    ])
  })

  test("the header is the first thing in the log", async () => {
    await createApp({ repositoryRoot: repo.path, runner: new GitRunner({ cwd: repo.path, log }) })
    expect(texts()[0]).toBe("You can hide/focus this panel by pressing '@'")
    expect(texts()[1]).toBe("")
  })

  test("a failed command's output is inspectable, a successful one's is not", async () => {
    const app = await createApp({ repositoryRoot: repo.path, runner: new GitRunner({ cwd: repo.path, log }) })
    await app.refresh()
    await expect(app.controller.push()).rejects.toThrow()
    expect(texts()).toContain("Git output:")
    expect(texts().some((text) => text.length > 0 && !text.startsWith("  ") && text !== "Git output:" && text !== "Push")).toBe(true)
  })
})
```

Adjust the `createApp` call and the way mutations are reached to match what
`tests/acceptance/review-workflow.integration.test.ts` actually does — in particular whether the
headless app exposes `controller` directly. If `push` against a repository with no remote does not
reject, use a command that does (for example `app.controller.deleteBranch("no-such-branch")`).

- [ ] **Step 2: Run tests to verify they fail or pass**

Run: `bun test tests/acceptance/command-log.integration.test.ts`
Expected: PASS if Tasks 1-12 are complete. If any fails, that is a real regression in an earlier
task — fix the production code, not the assertion.

- [ ] **Step 3: Update the parity matrix**

In `docs/lazygit-compatibility-v0.1.md`, split row 13. Replace it with two rows and keep the
numbering scheme the file already uses:

```
| 13 | Command log content, colours, autoscroll, keybindings, `@` menu, sizing, default visibility | compatible | Action/command stream per `pkg/gui/command_log_panel.go:25-68`; `readOnly` implies `dontLog`, reproducing lazygit's 80 `DontLog()` calls; `getExtrasWindowSize` sizing per `window_arrangement_helper.go:403-417`; `@` menu per `extras_panel.go:12-38` | — |
| 13a | Lower-right review area and draggable splitter | githunk review extension | Review status shares the lower-right region; the horizontal splitter sets what lazygit configures as `gui.commandLogSize` (`user_config.go:191`) | Extension 2 and 3 of 3 |
| 13b | Failed-command output in the log | githunk review extension | lazygit raises an error popup and logs nothing for a non-streamed failure; githunk has no popup, so stderr goes under the same magenta `Git output:` heading (PRD §6.7) | — |
```

Also update the file's line 7 summary if it enumerates the three extensions, so it accounts for
row 13b.

- [ ] **Step 4: Record what was and was not observed**

In `docs/release-checklist-v0.1.md`, add the command log's rows using the file's existing
`Automated` / `Manual smoke observed` / `Not tested` vocabulary. Mark as `Automated` what this
plan's tests cover; mark as `Manual smoke observed` only what you actually ran in Task 4 Step 7 and
Task 8 Step 9; mark everything else `Not tested`. Do not upgrade a status you did not observe.

- [ ] **Step 5: Run the gate**

Run: `bun run check`
Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
test: pin the command log's parity end to end

The dontLog rule is the change most likely to regress silently: nothing fails
if a loader starts logging again, the log just fills with status and
for-each-ref until it is useless. So the acceptance test asserts the negative
directly — a refresh puts no command in the log at all — alongside the positive
that a stage-then-commit produces Stage file, its git add, Commit and its git
commit in that order (pkg/gui/command_log_panel.go:14-24).

Parity matrix row 13 splits. The log's content, colours, autoscroll,
keybindings, @ menu, sizing and default visibility are compatible. Two things
stay recorded as extensions: the lower-right review area with its draggable
splitter, which sets what lazygit configures as gui.commandLogSize
(pkg/config/user_config.go:191), and the failed-command output block, which
lazygit does not have because it raises an error popup instead.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```
