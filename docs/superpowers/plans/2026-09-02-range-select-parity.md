# Range Select Parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add lazygit-compatible contiguous range selection to githunk's existing list mutations and main diff line actions without adding operations githunk does not expose.

**Architecture:** Extend immutable `ListState` with stable-id range endpoints and pure sticky/non-sticky transitions. `RootView` remains the only mutable UI owner: it routes `v`, shifted arrows, ordinary navigation, direct clicks, and drag gestures, renders focused ranges, resolves stable ids, and invokes explicit batch callbacks. The main diff gets a separate immutable line-range state in the main-pane layer; its exact selected document lines feed the existing diff transform, copy, and mutation paths.

**Tech Stack:** Bun 1.4, strict TypeScript 5.9 (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`), `@opentui/core` 0.5.6 test renderer, Bun tests, real temporary Git repositories through `GitRunner`.

**Spec:** `docs/superpowers/specs/2026-09-02-range-select-parity-design.md`

## Global Constraints

- Selection is inclusive, contiguous, and represented by stable row ids; non-contiguous selection is not implemented.
- Sticky mode is entered/cancelled by `v`; non-sticky mode is entered/extended by `Shift+Up`/`Shift+Down` and cancelled by ordinary navigation.
- Direct list clicks clear range mode; list drags establish a non-sticky range from press row to drag row.
- Refreshes preserve both endpoints only while both stable ids remain; a missing endpoint clears the range and keeps the existing selected-row fallback.
- Every batch mutation collapses the range to its first row before the post-mutation refresh, matching lazygit's `CollapseRangeSelectionToTop` behavior.
- Files range actions cover stage/unstage and discard only; branch range actions cover local/remote/both deletion; stash range action covers drop; existing single-item actions remain single-item.
- Main keyboard range selection uses the parsed `DiffDocument`, filters exact addition/deletion indexes for stage/discard, and uses the existing OSC52 copy pipeline for copy.
- UI code never spawns Git. New writes remain behind `RootViewOptions`, `AppController`, and `MutationQueue`.
- No runtime dependency changes. Preserve strict optional-field spread patterns and readonly data.
- Every production helper is introduced by a focused failing test, then implemented minimally, then re-run green before refactoring.
- Task implementers must skip formatters, linters, and project-wide suites; final verification runs the project gate once.

---

### Task 1: Immutable contiguous list-range state

**Files:**
- Modify: `src/ui/list-view.ts`
- Test: `tests/ui/list-view.test.ts`

**Interfaces:**
- Produces `ListRangeMode = "none" | "sticky" | "non-sticky"`.
- Extends `ListState` with `readonly rangeMode: ListRangeMode` and optional `readonly rangeStartId?: string`.
- Produces `getListSelectionRange(state): { readonly startIndex: number; readonly endIndex: number }`.
- Produces `isListRangeActive(state): boolean`, `hasMultipleListRowsSelected(state): boolean`, `toggleListRangeSelection(state): ListState`, `expandListRangeSelection(state, direction: "next" | "previous"): ListState`, `clearListRangeSelection(state): ListState`, and `setListRangeSelection(state, anchorId: string, endpointId: string): ListState` for mouse drag transitions.
- `moveListSelection` consumes the new metadata: sticky mode retains the anchor, non-sticky mode clears before ordinary movement, and `none` keeps single-row behavior.

- [ ] **Step 1: Write the failing pure-state and rendering tests**

Add tests in `tests/ui/list-view.test.ts` that assert the requested API and observable transitions:

```ts
test("sticky range expands inclusively and v cancels it", () => {
  let state = selectListRow(createListState(rows), "b")
  state = toggleListRangeSelection(state)
  expect(state).toMatchObject({ rangeMode: "sticky", rangeStartId: "b" })
  state = moveListSelection(state, "next")
  expect(getListSelectionRange(state)).toEqual({ startIndex: 1, endIndex: 2 })
  state = toggleListRangeSelection(state)
  expect(state).toMatchObject({ rangeMode: "none", selectedId: "c" })
  expect(state.rangeStartId).toBeUndefined()
})

test("shift expansion starts non-sticky and ordinary navigation cancels it", () => {
  let state = selectListRow(createListState(rows), "b")
  state = expandListRangeSelection(state, "next")
  expect(state).toMatchObject({ rangeMode: "non-sticky", rangeStartId: "b", selectedId: "c" })
  state = moveListSelection(state, "previous")
  expect(state).toMatchObject({ rangeMode: "none", selectedId: "b" })
})

test("reverse ranges include both stable-id endpoints", () => {
  const state = setListRangeSelection(createListState(rows), "c", "a")
  expect(getListSelectionRange(state)).toEqual({ startIndex: 0, endIndex: 2 })
  expect(hasMultipleListRowsSelected(state)).toBe(true)
})
```

Also add cases for direct-click cancellation, endpoint removal on `setListRows`, empty and one-row boundaries, and `renderListRows` highlighting every row in a focused range but none in an unfocused range. The tests must inspect the actual returned state/chunks, not helper call counts.

- [ ] **Step 2: Run the focused tests and verify the expected red failure**

Run:

```bash
bun test tests/ui/list-view.test.ts
```

Expected: FAIL because `ListState` has no range metadata and the requested helpers are not exported. Fix only test typos if the failure is unrelated to the missing feature.

- [ ] **Step 3: Implement the minimum stable-id state machine**

Update `createListState`, `setListRows`, `moveListSelection`, and `selectListRow` so that:

```ts
const selectionRange = getListSelectionRange(state)
// rangeStartId is resolved against current rows; numeric indices are never persisted.
```

Preserve the existing selected-id/index fallback. `setListRows` preserves a range only when both endpoints still resolve; otherwise it returns `rangeMode: "none"` with the existing selected row resolution. `setListRangeSelection` resolves both ids and returns non-sticky range metadata. Render selected rows with the existing full-row background; in a focused active range, apply that background to every inclusive row while keeping bold/bright selected-row styling only on `selectedId`.

- [ ] **Step 4: Re-run focused tests and commit the green foundation**

Run:

```bash
bun test tests/ui/list-view.test.ts
```

Expected: PASS for the file, including all prior list layout/highlight tests. Commit:

```bash
git add src/ui/list-view.ts tests/ui/list-view.test.ts
git commit -m "feat: add stable contiguous list ranges"
```

---

### Task 2: List bindings, cursor dispatch, refresh, and mouse gestures

**Files:**
- Modify: `src/ui/bindings.ts`
- Modify: `src/ui/root-view.ts`
- Test: `tests/ui/bindings.test.ts`
- Test: `tests/ui/list-selection.integration.test.ts`

**Interfaces:**
- Consumes Task 1's `ListRangeMode`, range helpers, and `setListRangeSelection`.
- Adds `Action` values `"toggle-range-select"`, `"range-select-up"`, and `"range-select-down"`.
- Binds `v`, `Shift+Up`, and `Shift+Down` in `files`, `branches`, `commits`, and `stash`; binds the same actions in `main` only when `ui.hasMainDocument === true`.
- Adds `GestureOwner` list state `{ readonly kind: "list-range"; readonly paneId: ListPaneId; readonly viewId: string; readonly anchorId: string }`.
- Produces root handlers that update the active `PanelState` child/view or `stashState`, render immediately, reveal the moving endpoint, and leave other panes unchanged.

- [ ] **Step 1: Add red binding and dispatch assertions**

Extend `tests/ui/bindings.test.ts` with assertions that availability-aware dispatch resolves the new keys in list contexts and main, while modal contexts do not receive them:

```ts
expect(registry.dispatch({ name: "v" }, { context: "files", model: model(), ui: ui() })).toBe("toggle-range-select")
expect(registry.dispatch({ name: "up", shift: true }, { context: "stash", model: model(), ui: ui() })).toBe("range-select-up")
expect(registry.dispatch({ name: "down", shift: true }, { context: "main", model: model(), ui: ui({ hasMainDocument: true }) })).toBe("range-select-down")
expect(registry.dispatch({ name: "v" }, { context: "modal", model: model(), ui: ui() })).toBeUndefined()
```

Add integration assertions using `createShellHarness` that `v` plus `j` expands a focused side-list range, ordinary `j` after a shifted range cancels it, a direct click clears it, refresh keeps both endpoint ids, and a drag paints the inclusive range. Extend the test-only view probe with `selectedListRange(pane): { readonly startId?: string; readonly endId?: string; readonly mode: string }` so the assertions observe the public state contract without reaching into private fields.

- [ ] **Step 2: Run the focused binding/integration tests and verify red**

Run:

```bash
bun test tests/ui/bindings.test.ts tests/ui/list-selection.integration.test.ts
```

Expected: FAIL on the new dispatch and range assertions because the actions, state transitions, and gesture owner do not exist.

- [ ] **Step 3: Add action declarations and availability-aware bindings**

Insert the three actions in `ACTIONS`, add list-context bindings beside the existing `j`/`k` bindings, and add main bindings guarded by `ui.hasMainDocument === true`. Keep `d`, `Space`, and other mutation bindings unchanged; range key availability must not make menu/status/command-log contexts selectable.

- [ ] **Step 4: Route range transitions through the existing root ownership paths**

Add exhaustive `handleAction` cases and private root methods that select the active list view, call the Task 1 helper, update the owning panel, render, and call `revealListRow` for the new endpoint. Make ordinary `next`/`previous` use `moveListSelection` so sticky ranges extend and non-sticky ranges cancel. Preserve child view ids for remote-branch, local-commit, commit-file, and filtered list views.

Update mouse handling so a list row press selects one row and captures a `list-range` owner. On `drag`, resolve the visible row through the existing clipped viewport hit test and call `setListRangeSelection(anchorId, row.id)`; on `up`/cancel, release the owner. Preserve the existing double-click timing and arrow-toggle behavior. Main selection remains the separate owner already used by OpenTUI.

- [ ] **Step 5: Re-run focused tests and commit the interaction slice**

Run:

```bash
bun test tests/ui/bindings.test.ts tests/ui/list-selection.integration.test.ts
```

Expected: PASS, with existing click, double-click, filtering, tab, and scrollbar tests still green. Commit:

```bash
git add src/ui/bindings.ts src/ui/root-view.ts tests/ui/bindings.test.ts tests/ui/list-selection.integration.test.ts
git commit -m "feat: route lazygit range selection keys"
```

---

### Task 3: Explicit batch mutation APIs with one refresh

**Files:**
- Modify: `src/git/mutations.ts`
- Modify: `src/app/controller.ts`
- Modify: `src/app/create-app.ts`
- Test: `tests/git/staging.integration.test.ts`
- Test: `tests/app/controller.test.ts`

**Interfaces:**
- Produces `GitMutations.stageFiles(paths: readonly string[]): Promise<void>`, `GitMutations.unstageFiles(paths: readonly string[]): Promise<void>`, and `GitMutations.discardFiles(paths: readonly string[], mode: DiscardFileMode): Promise<void>`; each serializes all Git commands and invokes its configured refresh once after the batch.
- Produces `AppController.stageFiles(paths: readonly string[]): Promise<void>`, `AppController.unstageFiles(paths: readonly string[]): Promise<void>`, `AppController.discardFiles(paths: readonly string[], mode: DiscardFileMode): Promise<void>`, `AppController.dropStashes(refs: readonly string[], options: StashDropOptions): Promise<void>`, and `AppController.deleteBranches(requests: readonly BranchDeleteRequest[]): Promise<void>`.
- `RootViewOptions` receives explicit callbacks `onStageFiles(paths, stage)`, `onDiscardFiles(paths, mode)`, `onDropStashes(refs)`, and `onDeleteBranches(requests)` in Task 4; singular callbacks remain intact.
- Batch controller methods log one user intent, execute every requested operation in one queue turn, refresh once on success, and retain existing error/banner behavior. Remote browse state is refreshed once per affected remote after branch deletion without introducing a second working-tree refresh.

- [ ] **Step 1: Add failing repository-backed batch mutation tests**

Add tests proving a batch stages multiple files, discards multiple files, and refreshes once through an injected loader; add controller tests with an injected `GitMutations` probe whose batch operation receives all paths and whose loader count increases once. Add stash and branch controller tests with a real temporary repository or runner fake that prove all refs/requests execute in order and the final state refreshes once.

Use assertions on Git state and loader counts, for example:

```ts
await mutations.stageFiles(["first.txt", "second.txt"])
expect((await repo.git(["diff", "--cached", "--name-only"])).stdout.split("\\n").filter(Boolean)).toEqual(["first.txt", "second.txt"])
```

- [ ] **Step 2: Run focused batch tests and verify red**

Run:

```bash
bun test tests/git/staging.integration.test.ts tests/app/controller.test.ts
```

Expected: FAIL because the batch methods and explicit controller APIs do not exist.

- [ ] **Step 3: Implement serialized Git and controller batches**

Implement batch loops in `GitMutations` using the existing runner arguments (`add -- path`, `restore --staged -- path`, and the existing discard command sequence), then call the configured refresh once. In `AppController`, keep target guards and action labels, wrap branch/stash/file batches in the existing `MutationQueue`/`runMutation`/`runBranchMutation` paths, and do not call singular controller methods from a batch because those refresh independently. Drop stash refs in the order supplied by the UI, preserving the current stash-target fallback when the active stash is removed.

For branches, execute each existing `BranchDeleteRequest` with its current local/remote/both semantics inside one queued operation, collect affected remote names, refresh once, then refresh each affected remote listing without calling the full repository refresh again. Preserve force-confirmation validation and existing `GitCommandError` banner text.

- [ ] **Step 4: Wire create-app callbacks and verify green**

Wire the new RootView callback options in `src/app/create-app.ts` with the same `try/finally` `view.update(controller.state)` contract as singular callbacks. Re-run:

```bash
bun test tests/git/staging.integration.test.ts tests/app/controller.test.ts
```

Expected: PASS, including existing singular mutation tests. Commit:

```bash
git add src/git/mutations.ts src/app/controller.ts src/app/create-app.ts tests/git/staging.integration.test.ts tests/app/controller.test.ts
git commit -m "feat: add serialized batch mutations"
```

---

### Task 4: Range-aware Files, Branches, and Stash actions

**Files:**
- Modify: `src/ui/root-view.ts`
- Modify: `src/ui/branch-dialogs.ts`
- Modify: `src/ui/bindings.ts`
- Modify: `tests/ui/branch-actions.integration.test.ts`
- Modify: `tests/ui/dispatch.integration.test.ts`
- Modify: `tests/ui/filter-search.integration.test.ts`
- Test: `tests/ui/list-selection.integration.test.ts`

**Interfaces:**
- Consumes Task 1 range resolution and Task 3 callbacks `onStageFiles(paths, stage)`, `onDiscardFiles(paths, mode)`, `onDeleteBranches(requests)`, and `onDropStashes(refs)`.
- Adds stable-id resolution helpers in `RootView` for the active list: inclusive rows come from `getListSelectionRange`; no model index is persisted.
- Files range resolution expands selected directory nodes through `forEachFile`, removes duplicate paths, removes descendant duplication when a parent directory is selected, rejects any conflicted selected file before invoking Git, and chooses stage vs unstage exactly as lazygit (`stage` if any selected file has unstaged changes, otherwise unstage files with staged changes).
- Branch range deletion builds one `BranchDeleteRequest` per selected local/remote row, keeps local/remote/both menu choices and force/upstream/current/worktree checks, and invokes `onDeleteBranches` only for a true batch. The local-commit child remains selectable but does not gain cherry-pick/rebase behavior.
- Stash range drop resolves currently displayed filtered rows, orders refs highest stash index first, and leaves apply/pop/inspect single-item.

- [ ] **Step 1: Add failing side-action integration tests**

Add repository-backed tests for:

```ts
await harness.pressKey("2")
await harness.pressKey("v")
await harness.pressKey("j")
await harness.pressKey(" ")
await harness.settle()
// both selected file paths are staged; no unrelated file is staged
```

Cover a directory plus child without duplicate Git operations, a conflicted range refusal, and discard confirmation for all/unstaged modes. Add branch tests for contiguous local deletion and remote-child deletion, asserting the confirmation mentions the selected range and exactly the remaining branches survive. Add stash tests for normal and filtered ranges, asserting only displayed selected stashes are dropped.

- [ ] **Step 2: Run the new side-action tests and verify red**

Run:

```bash
bun test tests/ui/branch-actions.integration.test.ts tests/ui/dispatch.integration.test.ts tests/ui/filter-search.integration.test.ts tests/ui/list-selection.integration.test.ts
```

Expected: FAIL because `Space`/`d`/branch delete/stash drop still consume one selected row and the batch callbacks are not present in RootView.

- [ ] **Step 3: Implement Files range resolution and menus**

Add RootView callback fields/options and update `actionStageFile`/`actionDiscardFile` only when `hasMultipleListRowsSelected` is true. Resolve rows by id, expand directory leaves with `forEachFile`, deduplicate by `ChangedFile.path`, reject conflicts with the existing visible bottom-title error, and call the Task 3 callback through `runUiMutation`. Keep single-row directory behavior and editor/review-marker behavior unchanged. For a discard range, preserve the existing confirmation menu and use the comma-separated unique file paths in its message.

Collapse the active range to its first row before opening/confirming a batch mutation so the next refresh selects the first surviving row. Do not collapse a range for non-mutating actions such as `Enter`, `e`, tabs, or filtering.

- [ ] **Step 4: Implement Branch range confirmation and Stash range drop**

Add plural confirmation text alongside the existing singular dialog factories. Resolve local branch names from `local:<name>` and remote child names from `remote-branch:<remote>/<branch>`. Disable local/both choices when any selected local branch is checked out, any selected branch is used by another worktree, or any selected upstream is unavailable; require force confirmation when any local deletion is unmerged. Execute one `onDeleteBranches` callback with all requests after confirmation, while leaving one-row behavior on the existing asynchronous worktree/merge-check paths.

Resolve stash OIDs from `stashState.rows`, sort the selected model entries by descending `stash@{N}` index for deletion, call `onDropStashes` once, and use the existing single-row confirmation unchanged when only one row is selected.

- [ ] **Step 5: Re-run focused side-action tests and commit**

Run:

```bash
bun test tests/ui/branch-actions.integration.test.ts tests/ui/dispatch.integration.test.ts tests/ui/filter-search.integration.test.ts tests/ui/list-selection.integration.test.ts
```

Expected: PASS for new and existing side-pane mutation flows. Commit:

```bash
git add src/ui/root-view.ts src/ui/branch-dialogs.ts src/ui/bindings.ts tests/ui/branch-actions.integration.test.ts tests/ui/dispatch.integration.test.ts tests/ui/filter-search.integration.test.ts tests/ui/list-selection.integration.test.ts
git commit -m "feat: apply side-pane actions to ranges"
```

---

### Task 5: Main diff keyboard line ranges

**Files:**
- Create: `src/domain/diff/line-selection.ts`
- Modify: `src/ui/panes/main-pane.ts`
- Modify: `src/ui/root-view.ts`
- Test: `tests/domain/diff/line-selection.test.ts`
- Modify: `tests/ui/main-diff.integration.test.ts`

**Interfaces:**
- Produces pure `DiffLineRangeMode = "none" | "sticky" | "non-sticky"` and `DiffLineRangeState` with `lineCount`, `selectedIndex`, `rangeMode`, and optional `rangeStartIndex`.
- Produces pure transitions `createDiffLineRangeState(document)`, `toggleDiffLineRange(state)`, `expandDiffLineRange(state, direction)`, `moveDiffLineSelection(state, direction)`, `clearDiffLineRange(state)`, `diffLineSelectionRange(state)`, and `changedIndexesInDiffLineRange(document, state)`.
- `main-pane.ts` stores this state separately from side-list `ListState`, initializes the cursor at the first addition/deletion line, preserves it only for identical document identity/text, exposes selected changed indexes and raw offsets, and uses OpenTUI's existing UTF-16 `setSelection(start, end)` for visual selection. Display offsets include the normalized preamble and rendered line-number gutter; raw mutation indexes still come from `DiffDocument.lines`.
- `RootView` maps `toggle-range-select`/shifted arrows to main-line transitions, clears non-sticky selection on ordinary main scrolling, and routes stage/discard/copy through the existing availability, `changeLineIndexes`, `copySelection`, and OSC52 code.

- [ ] **Step 1: Add failing pure line-range tests**

Create `tests/domain/diff/line-selection.test.ts` with a parsed multi-line diff and assert first-change initialization, sticky expansion/cancellation, non-sticky expansion/ordinary cancellation, reverse inclusive bounds, empty/no-change behavior, and changed-index filtering:

```ts
test("returns only additions and deletions from an inclusive reverse range", () => {
  const document = parseDiff("diff --git a/a.txt b/a.txt\\n@@ -1,2 +1,3 @@\\n keep\\n-old\\n+new\\n")
  const state = expandDiffLineRange(expandDiffLineRange(createDiffLineRangeState(document), "next"), "next")
  expect(changedIndexesInDiffLineRange(document, state).every((index) => ["addition", "deletion"].includes(document.lines[index]!.kind))).toBe(true)
})
```

- [ ] **Step 2: Run the pure line-range test and verify red**

Run:

```bash
bun test tests/domain/diff/line-selection.test.ts
```

Expected: FAIL because the module and transitions do not exist.

- [ ] **Step 3: Implement line state and main-pane visual/raw mapping**

Implement the pure state machine with the same sticky/non-sticky rules as Task 1, then add a WeakMap state beside `documents`/`cursorTargets` in `main-pane.ts`. Compute each selected document line's display start/end from `renderDiff(document).segments`; prepend the same normalized preamble used by `diff-text.ts`; call the runtime `TextRenderable.setSelection` through a narrow structural cast. Reset the state whenever the main document identity or text changes, and keep range selection separate from OpenTUI's pointer `main-selection` owner.

- [ ] **Step 4: Route main actions and add real renderer/Git assertions**

Update RootView's range action cases and `mainChangeSelection`/`copyMainMode` so an active keyboard range supplies exact document indexes/raw offsets; preserve current all-scope, staged-scope, conflicted, binary, wrapped, wide-character, and native mouse-selection rules. Add integration tests that use a real temporary repository to press `0`, `v`, `Shift+Down`, then `Space`/`d`/`Ctrl+O`, asserting staged/worktree content or copied text and captured selection background. Also assert ordinary `j`/`k` cancels a non-sticky main range.

- [ ] **Step 5: Re-run focused line tests and commit**

Run:

```bash
bun test tests/domain/diff/line-selection.test.ts tests/ui/main-diff.integration.test.ts
```

Expected: PASS, including existing diff color, preamble, scrolling, and native-selection tests. Commit:

```bash
git add src/domain/diff/line-selection.ts src/ui/panes/main-pane.ts src/ui/root-view.ts tests/domain/diff/line-selection.test.ts tests/ui/main-diff.integration.test.ts
git commit -m "feat: select contiguous main diff lines"
```

---

### Task 6: Acceptance coverage, parity documentation, and final verification

**Files:**
- Modify: `docs/lazygit-compatibility-v0.1.md`
- Modify: `tests/acceptance/lazygit-core-ui.test.ts`

**Interfaces:**
- Consumes all prior range transitions and batch callbacks.
- Documents row 24 as `partially compatible`, explicitly listing implemented list `v`/shift ranges and main stage/discard/copy ranges, while retaining non-goals for absent commit mutations and non-contiguous selection.
- Produces final evidence from focused tests, `bun run check`, and a real `bun run start` TUI smoke; documentation status must distinguish automated tests from manual smoke observations.

- [ ] **Step 1: Add the final acceptance scenario before implementation changes**

Extend the real renderer acceptance path to exercise `v`, `Shift+Down`, ordinary navigation cancellation, branch deletion, stash drop, and main line selection against a temporary repository. Assert Git state, rendered confirmation/collapse, and the command log's existing action output rather than internal fields alone.

- [ ] **Step 2: Run the acceptance test and verify the expected red result**

Run:

```bash
bun test tests/acceptance/lazygit-core-ui.test.ts
```

Expected: FAIL only on the newly asserted range behavior until the preceding tasks are present.

- [ ] **Step 3: Update the authoritative compatibility row**

Change row 24's status/notes to describe the implemented contiguous range contract and exact action coverage. Keep the document's statement that the four review extensions remain exactly four; range selection is part of existing list/patch behavior, not a fifth extension.

- [ ] **Step 4: Run the final project gate and actual TUI smoke**

Run:

```bash
bun run check
bun run start
```

In the live TUI, exercise `v`, `Shift+Down`, ordinary navigation cancellation, branch deletion, stash drop, and main line selection/copy. Record only observed behavior in the release/parity evidence; if the terminal cannot expose one surface, mark that surface `Not tested` rather than upgrading its status.

- [ ] **Step 5: Commit documentation and acceptance changes**

Run the acceptance test once more after the documentation edit, then commit:

```bash
git add docs/lazygit-compatibility-v0.1.md tests/acceptance/lazygit-core-ui.test.ts
git commit -m "docs: record contiguous range parity"
```

The branch is ready for the final whole-branch review only after the gate and smoke output are captured.
