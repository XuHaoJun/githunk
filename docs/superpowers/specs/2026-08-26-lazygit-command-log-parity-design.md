# Lazygit Command Log Parity Design

**Status:** Approved design
**Date:** 2026-08-26
**Reference:** vendored `learn-projects/lazygit/`
**Scope:** Replace githunk's `CommandRecord`-list command log with lazygit's action/command stream, and make what reaches the log match lazygit's `DontLog()` set

## 1. Goal

Make the lower-right command log read exactly like lazygit's `extras` view:

- an append-only stream of yellow action labels and indented command strings, not a list of formatted `CommandRecord`s;
- only user-driven writes reach it — every loader and query is suppressed, as is the background fetch;
- lazygit's colours, indentation, quoting, wrapping, header, random tip, autoscroll state machine, keybindings, window sizing and default visibility.

This is a deliberate breaking change. `CommandLog.records()` is removed, `AppModel.commandLog` changes type, the persisted `commandLogVisible` default flips to `true`, `DEFAULT_LOG_HEIGHT` changes from 8 to 10, and `@` stops being a three-way cycle. Callers and tests migrate together; no compatibility shims are kept.

## 2. Current State and the Gap

`src/app/command-log.ts` is a `CommandRecord[]` append list. `src/ui/panes/command-log-pane.ts:24-33` formats each record as an ISO timestamp, the argv with every argument `JSON.stringify`-quoted, an `exit N  Xms` line, and full `stdout:`/`stderr:` blocks, all in one colour.

lazygit's log is a different thing. `pkg/gui/command_log_panel.go:25-68` defines two write kinds — `LogAction`, a yellow un-indented label, and `LogCommand(cmdStr, commandLine)`, indented two spaces in the default text colour when the string is something you could paste into a shell and magenta when it is not. Command output only ever reaches the panel for streamed commands, behind a magenta `Git output:` prefix (`pkg/gui/extras_panel.go:96-119`). There is no timestamp, exit code or duration anywhere.

The larger gap is *what* gets logged. lazygit calls `DontLog()` on 80 command objects — every loader and query (`pkg/commands/git_commands/status.go:98,135,140`; `commit_loader.go:294,571,605`; `branch.go:69,82,111,127,169,180,235,241,294,311,348`; `stash_loader.go:36,71`; `file_loader.go:133,213,228`; `commit_file_loader.go:38`; `config.go:83`; `blame.go:32`) plus the background fetch (`sync.go:81`). githunk uses `dontLog` exactly once (`src/git/commit-status.ts:27`), so its 10-second working-tree refresh buries the user's own commands under `status`, `log`, `for-each-ref`, `diff` and `stash list`. This, more than colour or format, is why the pane does not read like lazygit's.

## 3. Data Model

`src/domain/command.ts` gains the display types:

```ts
export type CommandLogStyle =
  | "action" | "command" | "internal" | "output-heading" | "output" | "intro" | "tip-label" | "tip"

export type CommandLogSpan = { readonly style: CommandLogStyle; readonly text: string }

/** One logical line. The pane wraps it to its own width. */
export type CommandLogLine = { readonly id: number; readonly spans: readonly CommandLogSpan[] }
```

`CommandRecord` stays as `GitRunner.run`'s return value and `GitCommandError`'s payload; it is no longer retained by the log.

`src/app/command-log.ts` becomes an append-only line list whose write API mirrors lazygit's:

| githunk | lazygit |
| --- | --- |
| `logAction(action)` | `LogAction` (`command_log_panel.go:25-44`) |
| `logCommand(cmdStr, commandLine)` | `LogCommand` (`command_log_panel.go:46-68`) |
| `logOutput(text)` | `getCmdWriter` / `prefixWriter` (`extras_panel.go:96-119`) |
| `logIntro(text)` / `logTip(label, tip)` | `printCommandLogHeader` (`command_log_panel.go:70-85`) |
| `lines()` | the gocui view's line buffer |
| `nextId()` | — (id counter, moved off `GitRunner`) |

`records()` is removed. lazygit retains only strings (`gui.GuiLog = append(gui.GuiLog, cmdStr)`), and keeping whole `stdout` for every command was costing memory proportional to the largest patch the app had ever produced for content the pane no longer renders.

Choosing spans per logical line, rather than accumulating an ANSI string and reparsing it through `src/ui/panes/ansi-text.ts`, is the faithful choice rather than a deviation: gocui parses each `Fprint` incrementally into its own attributed line buffer and never reparses what is already there. A growing-string design would be `O(total)` per append, which lazygit is not.

### 3.1 Write semantics, copied

`logCommand` indents embedded newlines: `"  " + cmdStr.replaceAll("\n", "\n  ")` (`command_log_panel.go:57`), so a multi-line command string has every line indented two spaces. `commandLine === false` selects the `internal` style; `true` selects `command`.

Command strings are built by a new `formatCommandLine(argv)` that copies `CmdObj.ToString()` (`cmd_obj.go:64-75`): join with spaces, wrapping an argument in double quotes **only if it contains a space**. This replaces the current `JSON.stringify`-per-argument, which quotes everything and escapes backslashes.

`outputWriter()` returns a per-command writer whose first `write` emits the magenta `Git output:`
heading and whose later writes do not — a direct copy of `getCmdWriter()` handing out a fresh
`prefixWriter` per command (`extras_panel.go:96-119`). The state is per writer, not per log,
because that is where lazygit keeps it: two commands writing output each get their own heading,
which a flag on the log cannot express once writes interleave.

## 4. What Reaches the Log

### 4.1 The `dontLog` sweep

lazygit marks its 80 read paths one at a time. githunk does not need to, because it already
distinguishes reads structurally: every read in `src/git/` passes `readOnly: true`, and every
mutation omits it. Auditing all 65 `run()` call sites outside `runner.ts` confirms the split is
exact — the `readOnly` set is `status.ts`, `commits.ts`, `branches.ts:41,45,72,101,182`,
`stash.ts:19,31`, `diff.ts`, `config.ts:86`, `refs-snapshot.ts:25,26`, `tags.ts`,
`worktrees.ts:176,209`, `submodules.ts:109`, `ref-log.ts`, `reflog.ts`, `base-inference.ts`,
`branch-review.ts:28-31,45`, `commit-mutations.ts:54`, `editor.ts:148` and `commit-status.ts:27`;
the non-`readOnly` set is exactly the mutations (`mutations.ts:35,42,49,50,83`,
`commit-mutations.ts:40,48`, `stash.ts:59,63,68`, `branches.ts:174,179,184,193,199,205,264,268`,
`sync.ts:68,75,81,89,95`).

So the sweep is one rule in `GitRunner.run`: **`readOnly: true` implies `dontLog`**, with an
explicit `dontLog` still able to override in either direction. This yields the same set lazygit's
76 `DontLog()` call sites yield (a naive `grep -c` finds 80; 4 of those are the declaration and its
own comments, `cmd_obj.go:19,118,125,130`), and makes it an invariant rather than a thing each new
loader has to remember. `commit-status.ts:27`'s existing explicit `dontLog: true` becomes redundant
but stays, as documentation of intent.

Two paths need more than the rule:

- **Background fetch.** `git fetch` writes refs, so it is not `readOnly`, and lazygit suppresses
  the background one while logging the foreground one — `FetchBackgroundCmdObj` uses
  `DontLog().FailOnCredentialRequest()` (`sync.go:77-84`) against `FetchCmdObj` (`sync.go:65-70`).
  `src/git/sync.ts`'s `fetch(runner, remote?)` gains a `{ background?: boolean }` option that sets
  `dontLog`; `AppController.fetch` threads it; `create-app.ts:327-337` passes
  `{ background: true }`. The foreground `fetch` action keeps logging.
- **`gh`.** `createGhRunner` currently logs unconditionally, and its doc comment
  (`github.ts:126-129`) says that is the point. But `gh pr list` is a background query — that same
  comment notes only the background refresh drives it — so under lazygit's rule it must not appear.
  `createGhRunner` stops logging and the comment is rewritten to say why.

`RefsWatcher`'s 2-second poll goes through `refs-snapshot.ts:25,26`, both `readOnly`, so the rule
already covers it. After the sweep an idle githunk writes nothing to the log.

### 4.2 Action labels

lazygit calls `LogAction` from its UI controllers, because that is the layer where one user intent becomes N git commands. githunk's equivalent layer is `AppController`, whose mutation methods map one-to-one onto user intents (`stageFile()` runs `git add`); `src/ui/root-view.ts` corresponds to lazygit's keybinding table and views, not to its controllers. `AppController` is also unit-testable without a renderer, which the label assertions need.

`AppController` gains a private `logAction(label)` that forwards to `this.runner?.log.logAction(label)`, called as the first statement of each mutation. Labels live in a new `src/app/log-actions.ts`, copied verbatim from `pkg/i18n/english.go:2128-2254`:

| `AppController` method | Label | lazygit call site |
| --- | --- | --- |
| `stageFile` | `Stage file` | `files_controller.go:625` -> `:544` |
| `unstageFile` | `Unstage file` | `files_controller.go:625` -> `:559` |
| `toggleAllFiles` | `Stage all files` / `Unstage all files` | `files_controller.go:960` -> `:544,559`, chosen by the same `shouldStage` test |
| `discardFile` | `Discard all changes in selected file(s)` | `files_controller.go:1744`; `english.go:2173` |
| `applySelection`, `discardSelection` | `Apply patch` | `staging_controller.go:239-265`; `DiscardSelection` (`:213`) reaches the same `applySelection`, so lazygit labels both identically; `english.go:2215` |
| `commit` | `Commit` | `english.go:2192` |
| `amend` | `Amend commit` | `amend_helper.go:22` |
| `push` | `Push` | `sync_controller.go:197` |
| `pull` | `Pull` | `sync_controller.go:119` |
| `fetch`, `fetchRemote` | `Fetch` | `files_controller.go:1541` (a hardcoded string in lazygit, not an `Actions` entry) |
| `switchLocalBranch`, `switchLocal`, `checkoutRemoteTracking` | `Checkout branch` | `branches_controller.go:417,516` |
| `createBranch` | `Create branch` | `english.go:2142` |
| `deleteBranch` | `Delete local branch` | `english.go:2137` |
| `renameBranch` | `Rename branch` | `english.go:2141` |
| `chooseUpstream` | `Set branch upstream` | `english.go:2210` |
| `createStash` | `Stash all changes` / `Stash staged changes` | `files_controller.go:1516`; `english.go:2196,2198`, chosen by `StashCreateOptions` |
| `applyStash` | `Apply stash` | `stash_controller.go:127` |
| `popStash` | `Pop stash` | `stash_controller.go:141` |
| `dropStash` | `Drop stash` | `stash_controller.go:169` |
| edit-file (`src/git/editor.ts` path) | `Open file` | `files_helper.go:78` |

`switchLocal` delegates to `switchLocalBranch`; only the outermost method logs, so one keypress never produces two labels.

githunk-only actions that run no git command — `markFileReviewed`, `markFocusedFileReviewed`, `setBranchBase`, `switchMode`, `setWorkingTreeScope` — emit no label. This is githunk's own scoping choice, not lazygit's rule: lazygit labels its main-pane copy-to-clipboard even though it runs zero git commands (`Actions.CopySelectedTextToClipboard`, `patch_explorer_controller.go:343-351`; `english.go:2204`; same shape at `basic_commits_controller.go:294`). Whether githunk's own main-pane copy path should get a matching label is a separate, deferred product decision — see `src/app/log-actions.ts`'s header comment.

### 4.3 Command output

`GitRunner.run` calls `log.logCommand(formatCommandLine(args), true)` before spawning, unless §4.1's rule suppresses it. `createGhRunner` no longer logs at all, per §4.1.

Streamed output is copied for the commands lazygit streams. lazygit's `Git output:` block appears only for commands built with a credential strategy or `StreamOutput()` (`cmd_obj_runner.go:234-246`), which in practice is push, pull and foreground fetch (`sync.go:44,110,124,132`). githunk writes those commands' combined output through `logOutput`.

**Deviation.** githunk additionally calls `logOutput(stderr)` when a non-streamed command exits non-zero. lazygit does not: it raises an error popup instead. githunk has no error popup — a failed mutation surfaces as a pane `bottomTitle` string — and PRD §6.7 requires that "command failures must remain inspectable". This is githunk's own design constraint, so the deviation is retained and recorded in the parity matrix.

## 5. Rendering

Styles, copied from `command_log_panel.go` and `theme/theme.go:11`:

| Style | Colour | lazygit |
| --- | --- | --- |
| `action` | `ANSI_YELLOW` | `style.FgYellow` (`command_log_panel.go:41`) |
| `command` | `DEFAULT_FOREGROUND` | `theme.DefaultTextColor` = `style.FgDefault` (`theme.go:11`) |
| `internal` | `ANSI_MAGENTA` | `style.FgMagenta` (`command_log_panel.go:55`) |
| `output` | `DEFAULT_FOREGROUND`; its `Git output:` heading `ANSI_MAGENTA` | `style.FgMagenta` (`extras_panel.go:97`) |
| `intro` | `ANSI_CYAN` | `style.FgCyan` (`command_log_panel.go:75`) |
| `tip-label` | `ANSI_YELLOW` | `style.FgYellow` (`command_log_panel.go:81`) |
| `tip` | `ANSI_GREEN` | `style.FgGreen` (`command_log_panel.go:82`) |

lazygit sets `Wrap = true` on the view (`views.go:150`), and gocui wraps at character boundaries. githunk sets `wrapMode: "char"` on the `TextRenderable` and lets OpenTUI do the wrapping, rather than wrapping in its own pure function. Wrapping is the widget's job because it already knows where every row breaks; reimplementing that against a cached row map would duplicate state the widget owns.

**An earlier draft of this section justified the choice by claiming nothing in githunk measures East Asian width. That was false** — `isWide` has been in `src/ui/author-style.ts` all along — and the related claim that highlight columns count code points is false too: `addHighlight` indexes **display cells**, established by probing it with `"ab tip: "` (8 cells / 8 code points), `"🎲 tip: "` (8 cells / 7 code points) and `"中 tip: "` (8 cells / 7 code points) — the last two diverge, and `end: 7` stopped short of the trailing space in both. Span boundaries are therefore measured in cells, through that one shared `isWide`. The decision to let OpenTUI wrap stands; only its stated reason was wrong.

Colour then follows `src/ui/panes/diff-text.ts` exactly, in a new `src/ui/panes/command-log-text.ts`:

- the text goes in whole and unstyled through `setPlainPaneText`, per the `pane-text.ts` cost rule;
- `text.lineInfo.lineSources` maps each visual row back to its logical line, cached per wrap width, as `diff-text.ts:104-108` does — this is what makes wrapping the widget's problem rather than ours;
- only rows within `MARGIN_ROWS` of the viewport carry highlights, repainted incrementally on scroll (`diff-text.ts:120-133`), driven from the same `onLifecyclePass` hook (`diff-text.ts:138-152`);
- **every line but one has a single span**, so its rows are painted `{ start: 0, end: ROW_END_COLS }` and no column arithmetic happens at all. The sole multi-span line is `Random tip: <tip>`; its first row is painted by code-point offset and any continuation row takes the `tip` style whole.

Change detection keeps the existing shape — `lines()` returns the live array, so identity cannot detect an append; the pane compares the line count and the identity of the last line.

The pane title becomes `Command log` (`english.go:1928`).

## 6. Autoscroll

lazygit's state machine, copied from `extras_panel.go:48-94` and `command_log_controller.go:29-33`, with the flag living on the pane as `view.Autoscroll` does on the view:

- `logAction` and `logCommand` set autoscroll on (`command_log_panel.go:38,62`), so a command that runs while the user is reading scrollback does yank the viewport back to the bottom. That is lazygit's behaviour and is copied, not softened;
- `logOutput` does **not** touch the flag. lazygit's `prefixWriter` writes straight to the view (`extras_panel.go:109-119`) and never assigns `Autoscroll`; it scrolls only because the `logCommand` that preceded it already turned the flag on. The header and random-tip writes likewise leave it alone (`command_log_panel.go:70-85`);
- **every** explicit scroll turns it off, downward ones included — `scrollUpExtra` *and* `scrollDownExtra` both assign `Autoscroll = false`, as do `pageUpExtrasPanel`, `pageDownExtrasPanel` and `goToExtrasPanelTop` (`extras_panel.go:49,57,65,73,81`). So holding `j` to the bottom leaves autoscroll off; only the two cases below turn it back on;
- `>` goto bottom turns it on — `goToExtrasPanelBottom` is the one scroll handler that assigns `true` (`extras_panel.go:88-89`);
- losing focus turns it on (`command_log_controller.go:29-33`);
- while the flag is off, the viewport holds still — until the next `logAction`/`logCommand`, per the first bullet.

Two current behaviours are removed: `update()` unconditionally assigning `text.scrollY = text.maxScrollY` (`command-log-pane.ts:102`), and the wheel handler that swallows scroll events with `preventDefault` (`command-log-pane.ts:74-81`).

## 7. Keybindings

New `command-log` context bindings, copied from `keybindings.go:249-295`:

| Keys | Action | lazygit |
| --- | --- | --- |
| wheel up / wheel down | scroll, autoscroll off / off | `keybindings.go:249-258` |
| `k` `↑` / `j` `↓` | scroll, autoscroll off / off | `keybindings.go:259-269` |
| `,` / `.` | page up / page down, autoscroll off | `keybindings.go:270-279` |
| `<` / `>` | goto top (off) / goto bottom (on) | `keybindings.go:280-289` |
| left click | focus the command log | `keybindings.go:290-295` |

`,` `.` `<` `>` already exist as global bindings (`src/ui/bindings.ts:300-303`); they gain `command-log` context entries so the pane handles them with the correct autoscroll side effect. Scrolling down with `j`/`↓`/wheel does **not** re-enable autoscroll, matching `scrollDownExtra` (`extras_panel.go:56-61`) — only `>` and losing focus do.

## 8. The `@` Menu

`@` opens a menu instead of cycling. `src/ui/action-menu.ts` is a new pane: a titled box listing items as `key  label`, driven through the existing `modal` binding context, with `j`/`k` navigation, `enter` to activate the highlighted item, `escape` to dismiss, and each item's own key as a direct accelerator.

`@` opens the `Command log` menu (`extras_panel.go:12-38`) with two items, labels verbatim from `english.go:1949-1950`:

- `t` — `Toggle show/hide command log`. Copies `extras_panel.go:19-29`: if the log is shown *and* focused, pop focus back to the parent side context first, then flip visibility and persist it.
- `f` — `Focus command log`. Copies `handleFocusCommandLog` (`extras_panel.go:40-46`): force the log visible, then focus it.

`FocusManager.handleKey`'s `@` branch (`src/ui/focus.ts:46-59`) is deleted. `COMMAND_LOG_FOCUS_ID` stays in the `h`/`l`/tab cycle only while the log is visible, as today.

## 9. Sizing and Default Visibility

`getExtrasWindowSize` (`window_arrangement_helper.go:403-417`) is copied:

```
focused            -> fill the available space   (lazygit: baseSize 1000)
terminal height<40 -> 1 content row              (lazygit: baseSize 1)
otherwise          -> the configured size        (lazygit: Gui.CommandLogSize, default 8)
frame              -> +2 in every case
```

githunk's `logHeight` is already a total including the border, so:

- `DEFAULT_LOG_HEIGHT` changes from 8 to 10, making the default content area 8 rows as lazygit's is. The current 8 yields 6.
- terminal height below 40 clamps `logHeight` to `MIN_LOG_HEIGHT`, which is already 3 = 1 + 2.
- `focus === "command-log"` sets `logHeight` to the full `logCapacity`. `computeLayout` already receives `focus`, so this is local to `src/ui/layout.ts`.

The draggable splitter is **not** a deviation. lazygit's `commandLogSize` is itself a user setting (`user_config.go:191`); githunk's drag sets the same value with the mouse and stores it in `.git/githunk/ui-state-v1.json` instead of a YAML config. The dragged value substitutes for the constant in the third branch only; the focused and short-terminal branches override it exactly as they override lazygit's constant. `root-view.ts` persists the requested `logHeight`, not the computed geometry, so a focused expansion is never written back.

Default visibility flips to shown, copying `ShowCommandLog: true` (`user_config.go:901`) and `gui.ShowExtrasWindow = userConfig.Gui.ShowCommandLog && !GetAppState().HideCommandLog` (`gui.go:523`): `defaultUiState().commandLogVisible` becomes `true`, and the `logVisible` default in `RootView` follows. A persisted `false` still wins, matching lazygit's `HideCommandLog`.

## 10. Header and Random Tip

On startup the log is seeded, copying `printCommandLogHeader` (`command_log_panel.go:70-85`):

1. an `intro` line, `You can hide/focus this panel by pressing '@'` — `CommandLogHeader` (`english.go:1951`) formatted with the `ExtrasMenu` key;
2. a blank line, from the format string's trailing `\n` plus `Fprintln`;
3. when tips are enabled, `Random tip: <tip>` — a `tip-label` span, `": "`, then a `tip` span (`command_log_panel.go:78-83`). Enabled by default, copying `ShowRandomTip: true` (`user_config.go:909`).

Subsequent writes each start on a new line with no blank separator, because `LogAction` and `LogCommand` prefix `"\n"` rather than suffixing it (`command_log_panel.go:41,65`).

lazygit's tip catalogue is parameterised on its own keybindings and features (`command_log_panel.go:90-199`). A tip naming a key githunk does not bind, or a feature githunk does not have, would instruct the user to press nothing. The catalogue is therefore the subset whose feature and key both exist, each copied verbatim with githunk's key substituted the way lazygit substitutes its own:

Keybinding tips (7) — this section was originally written before the amend tip's rationale was
corrected; it is superseded by the block comment at `src/app/command-log-tips.ts:36-63`, which is
the source of record. Reproduced here for section 13:

- "In flat file view, merge conflicts are sorted to the top. To switch to flat file view press the backtick key" (`command_log_panel.go:105-108`; githunk's `buildFlatTreeFromFiles`, `src/ui/file-tree.ts:237-253`, sorts merge conflicts to the top exactly as `pkg/gui/filetree/build_tree.go:138` does, and `toggle-file-tree` binds the same default key, backtick, `user_config.go:1100`)
- `You can view the individual files of a stash entry by pressing '<enter>'` (`command_log_panel.go:124-127`; githunk binds `enter` to `stash-inspect`, `bindings.ts:393`)
- `You can page through the items of a panel using ',' and '.'` (`:149-153`; `bindings.ts:300-301`)
- `You can jump to the top/bottom of a panel using '<' and '>'` (`:154-157`; `bindings.ts:302-303`)
- `To collapse/expand a directory, press '<enter>'` (`:158-161`; githunk's `enter` calls `toggleFileTreeCollapsedPath` on a directory row, `root-view.ts:1376-1379`, copying `files_controller.go:715`)
- `You can amend the last commit with your new file changes by pressing 'A' in the files panel` (`:166-169`; **not** excluded, unlike the adjacent `:162-165` amend-to-commit tip below — githunk's `A` is *not* global in effect: `commitAttemptAvailable` (`root-view.ts:2184-2195`) permits it only when focus is Files or Main, so "press `A` in the files panel" is exactly true, reaching `git commit --amend -F -` via `actionAmend`. Same default key as lazygit's, `user_config.go:1090`)
- `You can now navigate the side panels with 'l' and 'h'` (`:170-174`; `bindings.ts:293`)

General-advice tips (6), verbatim and key-free (`command_log_panel.go:178-184`):

- the `git commit` / saving your game one;
- separating refactor commits from feature commits;
- experimenting on a throwaway branch;
- reading your own diff before requesting review;
- recovering an earlier state from the reflog;
- the stash as a place for debugging snippets.

Excluded, with the reason: force push, filter-commits-by-path, interactive rebase, undo/redo, reset options, push tag, diffing menu, drop commit, merge options, revert commit, bisect, custom commands, delta, bare-repo flags and the escape-a-mode tip's `quitOnTopLevelReturn` clause all name features githunk does not implement; the amend-to-commit tip (`Commits.AmendToCommit`, `:162-165`) is genuinely false of githunk — pressing `A` while a commit is selected in the commits panel does not amend that commit, since `commitAttemptAvailable` never permits `A` from the commits panel and githunk has no way to target an older commit for amending; the "join the team" and "raise an issue" tips point at lazygit's own project. The one remaining tip that githunk gains a feature for gets added at that time.

## 11. Testing

Pure unit tests, no renderer:

- `formatCommandLine` — the space-only quoting rule from `CmdObj.ToString()`, including arguments with quotes, backslashes and empty strings.
- `CommandLog` write API — span styles per kind, the two-space indent applied to every line of a multi-line command string, `Git output:` written once per command.
- `commandLogRowHighlights(lines, lineSources, row)` — the pure row-to-highlight mapping behind the painter: a single-span row spans the full width, a `Random tip` first row splits at the label's code-point boundary, a continuation row takes the trailing span's style, and a row past the end yields nothing.
- the autoscroll state machine — each input from §6 against the flag and viewport.
- `computeLayout` — the three sizing branches from §9, tested directly against `computeLayout` per the repo convention.
- `defaultUiState()` visibility, and a persisted `false` overriding it.

Integration:

- `tests/git/sync.integration.test.ts:27` currently asserts on `runner.log.records().at(-1)?.args`; it moves to asserting the last `command` line's text.
- a new acceptance test drives stage → commit through the shell harness and asserts the log contains `Stage file`, `  git add …`, `Commit`, `  git commit …` in order, **and** that no `status`, `log`, `for-each-ref` or `diff` line appears — the §4.1 sweep is the change most likely to regress silently.
- a test that a failing command's stderr appears under `Git output:` (§4.3 deviation) and that a succeeding one's stdout does not.

## 12. Files Touched

`src/domain/command.ts`, `src/domain/repository.ts`, `src/app/command-log.ts`, `src/app/log-actions.ts` (new), `src/app/command-log-tips.ts` (new), `src/app/controller.ts`, `src/app/create-app.ts`, `src/git/runner.ts`, `src/git/sync.ts`, `src/git/github.ts`, `src/ui/panes/command-log-pane.ts`, `src/ui/panes/command-log-text.ts` (new), `src/ui/panes/command-log-scroll.ts` (new), `src/ui/action-menu.ts` (new), `src/ui/bindings.ts`, `src/ui/focus.ts`, `src/ui/layout.ts`, `src/ui/ui-state-store.ts`, `src/ui/root-view.ts`, `docs/lazygit-compatibility-v0.1.md`, `docs/release-checklist-v0.1.md`.

The 14 read paths listed in §4.1 are **not** touched: the `readOnly`-implies-`dontLog` rule covers them without an edit.

## 13. Parity Matrix Update

Row 13 ("Lower-right review / command-log area") splits. The command log's content, colours, autoscroll, keybindings, `@` menu, sizing and default visibility become `compatible`. Two things stay recorded as githunk extensions: the draggable horizontal splitter as the input method for lazygit's `commandLogSize`, and the §4.3 failure-output block. The random-tip subset is recorded with the excluded-tips list from §10.
