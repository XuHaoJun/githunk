# githunk v0.1 release checklist

Evidence is split between deterministic automated coverage and the recorded TUI smoke. Items marked **Not tested** are intentionally not claimed as complete.

## PRD §23 workflow

| PRD §23 criterion | Evidence | Status |
| --- | --- | --- |
| Open repository and identify review target | `tests/acceptance/review-workflow.integration.test.ts`: creates and clones a real repository, refreshes Working Tree, asserts `Working Tree — All` | Automated |
| Review coding-agent output | Same test: verifies real staged, unstaged, and untracked files and exact production patch sections | Automated |
| Copy exact patch/code selections | Same test compares production patch sections byte-for-byte with `git diff` output; selection/staging uses parsed production diff | Automated patch evidence; clipboard delivery Not tested |
| Track reviewed files | Same test marks `story.txt` reviewed and asserts persisted status | Automated |
| Invalidate a reviewed file after external change | Same test edits the file outside the controller, refreshes, and asserts `changed-after-review` plus invalidation count | Automated |
| Stage/unstage selected changes | Same test stages a parsed diff line, compares complete staged/unstaged patches with real Git diffs, explicitly reverses/unstages that line, then re-stages it | Automated |
| Commit/amend path | Same test commits selected staged content and amends it, asserting exact HEAD OIDs and subjects plus remaining unstaged content | Automated |
| Switch branches if needed | Same test transitions from Working Tree to Branch Review and back from commit drilldown | Automated |
| Checkout remote branch | Same test checks out `origin/main` through `checkoutRemoteTracking`, verifies local `main`, and queries `main@{upstream}` as `origin/main` | Automated |
| Pull/fetch/push | Same test creates a real remote-ahead commit for fetch/pull, then a local commit for push, and asserts local/remote OIDs plus successful command-log records | Automated |

## Additional PRD §23 criteria

| Criterion | Evidence | Status |
| --- | --- | --- |
| Right-pane selection does not copy left-pane content | Existing clipboard/selection unit coverage plus production patch exactness in acceptance test; no client paste performed | Automated isolation tests; client paste Not tested |
| SSH clipboard works in a documented terminal set | `docs/clipboard-compatibility-v0.1.md` records no SSH session | Not tested |
| Left/right and Main/Command Log regions are mouse-resizable | TUI smoke launched the real app and sent vertical and horizontal splitter drag input, but the non-interactive harness provided no geometry readback | Not tested; no resize claim |
| Recognizable keyboard muscle memory | TUI smoke exercised numeric pane navigation, Enter inspection, and `q` quit; the smoke predates this branch's `@` change (`case "command-log": this.openCommandLogMenu()`, `src/ui/root-view.ts:989`) from a toggle to a modal menu, so that part of the observation no longer describes current behaviour — see line 62 below for the menu's own (`Not tested`) status | Manual smoke observed |
| Working Tree and `base...HEAD` Branch Review are first-class | Acceptance asserts Working Tree state and aggregate Branch Review (`agent` vs `refs/remotes/origin/main`) with three commits | Automated |
| Active target and branch base always visible | Acceptance asserts `Working Tree — All`, `Stash — <ref>`, `agent vs refs/remotes/origin/main`, and `Commit — <oid>` labels after transitions | Automated |
| Reviewed files visibly invalidate after changes | Acceptance asserts `changed-after-review` and invalidation count | Automated |
| Remote branches browse and switch to tracking branches | Acceptance checks out `origin/main`, asserts created local tracking branch and current branch | Automated |

## Review shell UX manual checks

Introduced by the 2026-08 review-shell work (proportional layout, navigation keys,
hints bar, screen modes, draggable dividers). Automated coverage lives in
`tests/ui/acceptance/shell.integration.test.ts`; the following still need eyes on the real TUI:

- [ ] The hints bar in the bottom row changes with pane focus (`2` shows `stage: space`, `3` shows `checkout: space`, `5` shows `apply: space`).
- [ ] `?` opens the keybinding menu and `Esc` closes it.
- [ ] The vertical divider shows its hover affordance under the pointer and drags to resize the side region.
- [ ] Double-clicking the vertical divider collapses the side region; double-clicking again restores it.
- [ ] Side-region ratio and command-log geometry survive quitting and restarting githunk on the same repository.
- [ ] With `.git/githunk/ui-state-v1.json` present, `git status` stays clean (the state file lives under `.git/`, never in the worktree).
- [ ] On a branch with commits, the Commits pane (`4`) lists them instead of showing an empty pane.

## Command log parity (2026-08 lazygit command log parity plan)

Closes out the 13-task plan that rebuilt the lower-right command log to match lazygit's `extras`
view (`pkg/gui/command_log_panel.go`). `tests/acceptance/command-log.integration.test.ts` is the
end-to-end acceptance test; it drives a real `git` process through a headless `createApp`, the same
pattern `review-workflow.integration.test.ts` uses.

| Criterion | Evidence | Status |
| --- | --- | --- |
| A background refresh puts no loader command in the log (the `readOnly`-implies-`dontLog` rule, reproducing lazygit's 80 `DontLog()` calls) | `tests/acceptance/command-log.integration.test.ts`: "a refresh puts no loader command in the log" — asserted as a negative (`status`, `for-each-ref`, `log`, etc. never appear), which the test shows failing against a deliberately re-logged loader before confirming it passes on the real code | Automated |
| A real mutation logs its action above its command, in order (`pkg/gui/command_log_panel.go:14-24`) | Same file: "staging then committing logs each action above its command, in order" — `Stage file` / `  git add -- a.txt` / `Commit` / `  git commit -F -` against a real repository | Automated |
| The startup header is the first line of every session's log, guarding against a repeat of the Task 3 `src/main.ts` bootstrap-read regression (`src/main.ts` itself has no tests) | Same file: "the header is the first thing in the log"; seeding order additionally pinned by `tests/app/create-app.test.ts` (fails if `seedCommandLog` is deleted or moved after construction) | Automated |
| A failed command's stderr stays inspectable under `Git output:` (PRD §6.7); a successful command's output produces no such block | Same file: "a failed command's output is inspectable, a successful one's is not" — uses `deleteBranch` against a nonexistent branch, since `push()` against this environment's remote-less temp repository resolves `{ kind: "upstream-required" }` rather than rejecting | Automated |
| Command log title text (`Command log`), its green focus colour, the command line's ambient default-foreground colour, and the magenta `Git output:` heading over a default-foreground failure body | Task 4's own commit (`5fb335f`) records no smoke, tmux session or SGR capture, despite the plan mandating it; the only trace of that observation is a paraphrase inside `bb61913`'s body — the commit that wrote this line — and the underlying detail lives only in `.superpowers/`, which is gitignored and invisible to the repository — explicitly **not** confirmed in-repo, covered only by the unit/pane tests (`tests/ui/command-log-text.test.ts` pins the `output-heading`/`action`/`command`/`tip` style tags per span; `tests/ui/command-log-pane.test.ts` exercises pane construction and title) | Not tested |
| Command log action/intro/tip colours; live line wrapping in the running app | Task 4 report: nothing called `logAction`/`logIntro`/`logTip` at the point Task 4 ran (that wiring lands in later tasks), and nothing wrapped at the terminal widths driven — explicitly **not** observed live, covered only by the unit/pane tests (`tests/ui/command-log-text.test.ts`, `tests/ui/command-log-pane.test.ts`) | Not tested |
| `@` opens the Command log menu; `t` toggles, `f` focuses, `Escape` closes | Task 8 report, Concerns: "No interactive manual smoke test was possible in this environment (non-interactive shell, no TTY)" — `bun run start` was only confirmed to boot under `/dev/null` stdin; the `@`/`t`/`f`/escape behaviour itself was never watched on a real terminal. Separately covered by `tests/ui/command-log-menu.integration.test.ts` and `tests/ui/action-menu.test.ts`, which is a different claim | Not tested |
| Command log keybindings (`,`/`.`/`<`/`>` page and jump), autoscroll arming/clearing, `getExtrasWindowSize`-equivalent sizing, default visibility | `tests/ui/command-log-scroll.test.ts`, `tests/ui/command-log-autoscroll.integration.test.ts`, `tests/ui/layout.test.ts` (`DEFAULT_LOG_HEIGHT`/`MIN_LOG_HEIGHT`/focused-expand branches), `tests/ui/ui-state-store.integration.test.ts` and `tests/ui/command-log-menu.integration.test.ts` (`commandLogVisible` default and persistence) | Automated |
| Random-tip catalogue is a documented subset of lazygit's tips | `src/app/command-log-tips.ts`'s block comment records the 13-of-~30 subset and the reasons for every exclusion (feature or keybinding absent from githunk); `tests/app/command-log-tips.test.ts` pins the key table | Automated |

## Release gates

- [x] `bun test tests/acceptance/review-workflow.integration.test.ts` — 1 pass, 75 assertions.
- [x] `bun run typecheck` — pass.
- [x] `bun install --frozen-lockfile && bun run check` — pass: 137 tests, 0 failures, 801 expectations; typecheck passed.
- [x] Real non-destructive `bun run start` smoke — process exited 0 after navigation, diff inspection, splitter drag input, and quit. (Predates this branch's `@` change from a toggle to a modal menu; the menu itself is `Not tested`, see line 62.)
- [ ] SSH+zellij 120×40 clipboard/paste run — Not tested; see compatibility record.
- [ ] tmux clipboard/paste run — Not tested.
- [ ] Local client clipboard paste result — Not tested.
- [ ] Splitter geometry readback before/after terminal resize — Not tested.

Before tagging, preserve unrelated user changes (including `.gitignore`).
