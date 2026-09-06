# App wiring and dispatch refactor — design

Date: 2026-09-06
Branch: `refactor/app-wiring-and-dispatch`
Status: approved design, pending implementation plan

## Goal

Remove three sources of mechanical duplication that make `RootView`, `AppController`
and `create-app` hard to change, and close a read-modify-dispatch race in Branch
Review. Behaviour is preserved throughout; every scope lands as its own `refactor:`
commit with `bun run check` green.

Out of scope: splitting `RootView` into modules, splitting `AppController` into
sub-controllers, renaming callbacks, dead-export sweeps, lazygit parity changes.

## Scope 1 — RootView ports and the `create-app` wrapper

### Problem

`RootViewOptions` (`src/ui/root-view.ts:203-265`) carries 47 optional callbacks.
`RootView` copies each into a private field in its constructor and calls them with
`this.onX?.(...)`. `create-app.ts:292-480` wraps 35 of them in the identical
`try { await controller.x() } finally { if (shouldRenderRepository) view.update(controller.state) }`.
`RootView` is constructed only in `create-app.ts`, which supplies every callback, so the
optionality is fiction.

### Design

New file `src/ui/root-view-ports.ts` with three interfaces whose methods are required:

| Interface | Contents |
| --- | --- |
| `RepositoryCommands` | Every callback that changes the repository or controller state: stage/unstage/discard (file, files, selection, all), scope change, branch create/checkout/delete/rename/inspect/filter, remote fetch/browse/checkout-tracking, fetch/pull/push, upstream choose/cancel, stash create/apply/pop/drop/inspect, commit/amend message, edit file, `onExpandCommits`, `onRefresh`, `onSelectFile`, `onOpenBranchReview`, `onMarkFocusedFileReviewed`. |
| `RepositoryQueries` | Pure reads: `loadCommitInspection`, `loadBranchCommits`, `loadCommitFileInspection`, `loadTagInspection`, `loadRefLogInspection`, `onCurrentCommitMessage`, `onCheckBranchMerged`. |
| `ViewHost` | `onQuit`, `onGeometryChange`, `onMutationSettled`, `onPreviewError`, `isBranchReviewActive`. |

`RootViewPorts = { commands, queries, host }`. `RootViewOptions` becomes
`{ sidePanelRatio?, logHeight?, logVisible?, ports }`.

Rules:

- Method names are unchanged in this step (`onStageFile` stays `onStageFile`) so the
  diff is a mechanical move. Renaming is a possible follow-up, not part of this work.
- `RootView` keeps a single `private readonly ports: RootViewPorts`; the 47 fields and
  their constructor copies are deleted. `this.onX?.(…)` becomes
  `this.ports.commands.onX(…)` (or `.queries` / `.host`).
- Any branch that exists only because a callback might be absent (early returns,
  alternate paths, hint gating on `this.onX === undefined`) is dead once ports are
  required and is deleted, not preserved.
- Tests that need a `RootView` use a `noopPorts()` helper (every method a no-op
  returning a resolved promise or neutral value); it lives with the test helpers.

In `create-app.ts`:

- One `shouldRender = () => screenController?.shouldRenderRepository() ?? true`.
- One wrapper:

  ```ts
  const ui = <A extends unknown[], R>(fn: (...args: A) => Promise<R>) =>
    async (...args: A): Promise<R> => {
      try { return await fn(...args) } finally { if (shouldRender()) view.update(controller.state) }
    }
  ```

  Simple handlers become `onStageFile: ui((path) => controller.stageFile(path))`. The
  handlers with extra logic (`onCheckoutRemoteTracking`, `onExpandCommits`,
  `onOpenBranchReview`, `onDeleteBranch`, `onEditFile`, `onSelectFile`) keep their
  bodies but are still wrapped in `ui()` where they currently use the `finally`.
- The `isBusy` closure duplicated at `create-app.ts:285-290` and `522-527` becomes one
  function.

### Safety net

`tests/ui/dispatch.integration.test.ts`, `tests/app/create-app.test.ts`,
`tests/app/create-app.integration.test.ts`, and every shell-harness suite drive the real
wiring end to end. No new behaviour, so no new behavioural tests; a small unit test for
`ui()` is added only if it is extracted to its own module.

## Scope 2 — AppController helpers and loader options

### Problem

`src/app/controller.ts` has 52 hand-written `this.currentState = { ...this.currentState, … }`
sites, 41 of which also spread `...this.commandLogSnapshot()`; 18 verbatim copies of the
`GitCommandError` → banner text ternary; a 165-line `refresh()` that repeats the same
load/apply/warn block six times; and 8 unused alias keys in `AppControllerOptions`.

### Design

1. **`describeGitError(error: unknown): string`** in `src/git/` (next to
   `GitCommandError`): `GitCommandError` → `record.stderr || message`, `Error` →
   `message`, otherwise `String(error)`. All 18 controller sites call it.
2. **`private setState(patch: Partial<AppModel>, omit?: readonly (keyof AppModel)[])`**:
   spreads the current state, removes `omit` keys (the `exactOptionalPropertyTypes`
   idiom that today is four hand-written destructurings), applies `patch`, and always
   folds in `commandLogSnapshot()`. All 52 sites move to it. The 11 sites that today
   omit the snapshot are reviewed one by one in the plan; a site that must not carry the
   snapshot keeps a direct assignment with a comment saying why.
3. **Table-driven `refresh()`**: a constant list of auxiliary loaders
   (`branches`, `stashes`, `tags`, `reflog`, `worktrees`, `submodules`), each with
   `load`, `apply(state, value) => patch` and its warning slot. The table is iterated in
   the current write order, so the banner precedence stays "last failed loader wins".
   The `generation` guard and the pull-request kick-off are unchanged.
4. **Loader options**: delete the alias keys `loader`, `commitsLoader`, `commitLoader`,
   `branchesLoader`, `commitFilePatchLoader`, `tagsLoader`, `reflogLoader`,
   `worktreesLoader`, `submodulesLoader` (unused in `src/` and `tests/`). Add
   `defaultLoaders(runner)` returning the Git-backed set; the constructor becomes
   defaults overlaid by whatever `load*` keys the options carry. The positional
   `new AppController(runner)` overload stays: `tests/app/remote-checkout.test.ts` and
   `tests/acceptance/review-workflow.integration.test.ts` use it.

Not included: merging `runMutation`/`runBranchMutation`, extracting the stash-target
reset, splitting into sub-controllers.

### Safety net

`tests/app/controller.test.ts`, `tests/app/log-actions*.test.ts` (pin banner text and
command-log labels), `tests/app/filter.test.ts`, `tests/app/commit-drilldown.test.ts`,
plus the integration suites. A unit test for `describeGitError` covers its three
branches. A `refresh()` test asserting the existing last-wins banner precedence (two
loaders failing, the later one's message shown) is added.

## Scope 3 — Branch Review dispatch goes through `dispatchIntent`

### Problem

`ReviewWorkspaceController.dispatchIntent(intent)` (`src/ui/review-workspace/controller.ts:451`)
already plans an intent against the controller's current state and returns `false` on
failure. `ReviewWorkspaceApp.tsx` never calls it; instead 35 sites do
`controller.dispatch(planReviewIntent(current, intent))` inside `try {} catch {}`, where
`current` was read earlier in the callback. Each site re-implements the plan step against
a possibly stale snapshot.

### Design

- Every `controller.dispatch(planReviewIntent(…, intent))` in `ReviewWorkspaceApp.tsx`
  becomes `controller.dispatchIntent(intent)`. The component no longer imports
  `planReviewIntent`; `fallbackSelectionIntent` returns `ReviewIntent | undefined`.
- Empty `catch {}` blocks around those calls are removed. The three sites whose catch
  performs recovery (reanchor: set message and keep reanchor mode; range selection: reset
  `rangeStart` / `pendingRangeAnchor`) become `if (!controller.dispatchIntent(…)) { recovery }`.
- Sequences that dispatch, then re-read `controller.state` to dispatch again, become two
  consecutive `dispatchIntent` calls; the second reads fresh state inside the controller.
- Reads of `current` that feed data into the intent (an existing feedback's fields, the
  selected file) are unchanged; only the dispatch step moves.
- `controller.dispatch` stays public: 42 test sites call it directly.
- `dispatchIntent` itself is unchanged.

### Safety net

`tests/ui/review-workspace/*` (notably `react-review-workspace.integration.test.tsx`,
`refresh.integration.test.ts`, `finish.integration.test.ts`) and
`tests/acceptance/branch-review-*.integration.test.ts`. No unit test covers
`dispatchIntent` today; one is added asserting it returns `false` for an invalid intent
and leaves state untouched, and `true` with the state advanced for a valid one.

## Delivery

| Commit | Summary |
| --- | --- |
| 1 | `refactor: route root view callbacks through required ports` |
| 2 | `refactor: table-drive controller refresh and centralize state writes` |
| 3 | `refactor: dispatch branch review intents through the controller` |

Each commit passes `bun run check`. The compatibility matrix is untouched because no
user-visible behaviour changes.
