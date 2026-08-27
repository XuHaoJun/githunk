# Lazygit Branch Actions Parity Design

**Status:** Approved design
**Date:** 2026-08-27
**Reference:** vendored `learn-projects/lazygit/`
**Scope:** Branch delete/create flows and the shared menu/confirmation pattern they expose

## Goal

Make panel 3's branch actions follow lazygit's observable interaction contract instead of silently replacing menus and confirmations with inline `bottomTitle` text.

The primary user-visible change is pressing `d` on a local branch: it opens a menu containing local, remote, and local+remote deletion choices. The `n` action must create from the selected local or remote ref, preserve lazygit's suggested-name and tracking semantics, and refresh into the new branch.

## Reference contract

### Delete

On a local branch selection, `d` opens a menu titled `Delete branch '<name>'?` with:

- `c` — Delete local branch;
- `r` — Delete remote branch;
- `b` — Delete local and remote branch.

Local and local+remote are unavailable for the checked-out branch. Remote and local+remote are unavailable when the branch has no live upstream (`upstreamGone` is also unavailable). A normal local delete runs immediately when the branch is merged into the checked-out branch or its upstream; an unmerged local delete first asks for force deletion. Remote deletion always confirms. Local+remote confirms, includes the force warning when needed, deletes the remote ref before the local ref, and refreshes both branch views. A branch checked out by another linked worktree offers remove-worktree or detach-worktree before continuing; multi-selection/worktree complexity is not introduced until range selection exists in the branch UI.

Remote deletion uses `git push <remote> --delete refs/heads/<branch>`. Local deletion uses `git branch -D <branch>` after the merged/force confirmation (matching lazygit's `confirmForceIfUnmerged` plus `LocalDelete(..., true)`).

### Create

On a selected local branch, `n` opens a prompt titled `New branch name (branch is off of '<branch>')` and uses that branch's full ref as the start point. On a selected remote branch in the remote-branch child view, `n` uses the remote ref as the start point and pre-fills the short branch name without the remote prefix.

The entered name replaces spaces with `-`. If the user changes the suggested name, creation uses `--no-track`; leaving the remote-derived suggestion unchanged allows Git's normal tracking setup. A successful create checks out the branch, refreshes all dependent panes, and focuses panel 3. Dirty-worktree checkout failures expose an explicit autostash confirmation before retrying and restore the stash afterward. Renaming a branch with a live upstream first warns that only the local name changes.

## Shared pattern

`ActionMenuHandle` is the single transient menu surface for branch choices and other already-supported menu/confirmation gaps. It must support:

- a title and optional prompt text;
- keyed items with `j`/`k`/Enter/Escape handling;
- visible disabled items with a reason, without invoking their mutation;
- callbacks that may open a follow-up confirmation or start an async mutation;
- modal input capture so keys cannot fall through to the focused pane.

The same audit fixes supported destructive flows that currently use direct execution or inline double-press text: files discard gets its lazygit all-vs-unstaged menu; stash apply/pop/drop use explicit confirmation; main-pane discard keeps its existing scope guard but uses the shared confirmation surface. Single linked-worktree cleanup reached through branch deletion is included; standalone worktree-pane actions, tags, rebase, merge, and sort remain out of scope until their operation backends exist, and are not relabelled as fixed by this change.

## Data flow

1. `RootView` resolves the selected branch row and builds the menu from current `LocalBranch` metadata.
2. A menu item produces a typed branch mutation request; UI-only confirmation state stays in `RootView`.
3. `AppController` owns validation, merge checks, mutation ordering, action logging, and refresh.
4. `src/git/branches.ts` owns branch/ref-safe commands and never interpolates user input into a shell string.
5. Errors remain visible in the existing pane status path and do not leave a modal lockout.

## Acceptance criteria

- `d` on a local branch visibly opens the three-option menu; disabled options explain checked-out/no-upstream reasons.
- Local, remote, and both paths execute the expected Git commands and refresh the branch model.
- Unmerged local/both deletion shows force confirmation; merged local deletion does not add a second confirmation.
- `n` from local and remote branch rows uses the correct start point; remote rows prefill the short name; edited names use `--no-track`; spaces are sanitized.
- Branch creation and deletion failures surface their Git error and clear transient state.
- Existing focus, mutation serialization, command-log action labels, and branch-review read-only guards remain intact.
- Focused unit/integration tests cover menu rendering, disabled conditions, Git command ordering, confirmation transitions, branch creation tracking, and the existing non-regression cases.

## Deliberate boundary

The repository has no lazygit-style user configuration loader, so the default empty branch prefix is retained rather than inventing a new config format. Implementing this contract does not require an OpenTUI or Node.js workaround; the existing absolute action-menu surface and async mutation queue are sufficient.
