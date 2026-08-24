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
| Recognizable keyboard muscle memory | TUI smoke exercised numeric pane navigation, Enter inspection, `@` Command Log toggle, and `q` quit | Manual smoke observed |
| Working Tree and `base...HEAD` Branch Review are first-class | Acceptance asserts Working Tree state and aggregate Branch Review (`agent` vs `refs/remotes/origin/main`) with three commits | Automated |
| Active target and branch base always visible | Acceptance asserts `Working Tree — All`, `Stash — <ref>`, `agent vs refs/remotes/origin/main`, and `Commit — <oid>` labels after transitions | Automated |
| Reviewed files visibly invalidate after changes | Acceptance asserts `changed-after-review` and invalidation count | Automated |
| Remote branches browse and switch to tracking branches | Acceptance checks out `origin/main`, asserts created local tracking branch and current branch | Automated |

## Release gates

- [x] `bun test tests/acceptance/review-workflow.integration.test.ts` — 1 pass, 75 assertions.
- [x] `bun run typecheck` — pass in this worker.
- [x] Real non-destructive `bun run start` smoke — process exited 0 after navigation, diff inspection, Command Log toggle, splitter drag input, and quit.
- [ ] SSH+zellij 120×40 clipboard/paste run — Not tested in this worker; see compatibility record.
- [ ] tmux clipboard/paste run — Not tested.
- [ ] Local client clipboard paste result — Not tested.
- [ ] Final full `bun install --frozen-lockfile && bun run check` — controller gate after integration.

Before tagging, confirm the final controller gate, inspect `git diff --check`, and preserve unrelated user changes (including `.gitignore`).
