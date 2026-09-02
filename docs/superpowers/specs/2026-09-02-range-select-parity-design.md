# Range Select Parity Design

**Goal:** Add lazygit-compatible contiguous range selection to githunk's existing list and patch actions without pretending that githunk already implements lazygit operations it does not have.

**Scope:** The feature covers the selection contract and the equivalent actions already exposed by githunk: side-list file stage/discard, branch deletion, stash drop, and main-pane line stage/discard/copy. It also covers range selection in branch/commit child lists wherever the existing githunk action can consume it. Cherry-pick, rebase, commit mutation, and custom-command APIs remain out of scope because githunk does not currently expose those operations.

## Reference behaviour

The vendored lazygit reference defines two contiguous list-selection modes:

- Sticky: `v` starts or cancels a range; ordinary up/down extends it.
- Non-sticky: `Shift+Up`/`Shift+Down` starts or extends a range; ordinary up/down cancels it.

Reference evidence:

- `learn-projects/lazygit/docs/Range_Select.md:3-14`
- `learn-projects/lazygit/pkg/gui/context/traits/list_cursor.go:9-19,136-185`
- `learn-projects/lazygit/pkg/gui/context/list_view_model.go:44-51`
- `learn-projects/lazygit/pkg/gui/controllers/list_controller.go:340-386`

The range is always inclusive and contiguous. lazygit stores two endpoints, sorts them, and slices `[start:end+1]`; it does not implement non-contiguous multi-selection (`learn-projects/lazygit/docs/dev/Find_Base_Commit_For_Fixup_Design.md:57-58`).

## Architecture

`ListState` remains the single immutable snapshot for each githunk list. It gains range metadata and pure transition helpers; `RootView` remains the only owner of mutable UI state and dispatch. Pane rendering receives the same state and paints every row in the active range, while the moving endpoint keeps the focused-row styling.

Range-aware mutations stay behind the existing `RootViewOptions` callbacks and `AppController` mutation queue. The view only resolves selected stable row ids into domain objects and builds a batch request; it does not spawn Git. New batch callbacks are explicit, so a single-item action cannot accidentally operate on a range.

The main pane uses the existing exact diff-selection pipeline. Keyboard range selection produces diff line indexes through the already parsed `DiffDocument`; stage, discard, and copy consume those indexes. The patch line state is separate from side-list range state, matching lazygit's separate `patch_exploring.State` implementation.

## List selection contract

`src/ui/list-view.ts` will expose:

```ts
type ListRangeMode = "none" | "sticky" | "non-sticky"

type ListState = {
  readonly rows: readonly ListRow[]
  readonly displayRows: readonly ListDisplayRow[]
  readonly selectedId?: string
  readonly selectedIndex: number
  readonly rangeMode: ListRangeMode
  readonly rangeStartId?: string
  readonly scrollY: number
}
```

Pure helpers will provide:

```ts
getListSelectionRange(state: ListState): { readonly startIndex: number; readonly endIndex: number }
isListRangeActive(state: ListState): boolean
hasMultipleListRowsSelected(state: ListState): boolean
toggleListRangeSelection(state: ListState): ListState
expandListRangeSelection(state: ListState, direction: "next" | "previous"): ListState
clearListRangeSelection(state: ListState): ListState
```

Invariants:

1. `rangeStartId` and `selectedId` are stable row ids, never stale numeric indexes.
2. `getListSelectionRange` resolves both ids against the current `rows`, sorts their indexes, and returns an inclusive range.
3. `rangeMode === "none"` makes the selected row the one-item range.
4. Sticky navigation moves only the selected endpoint and retains the anchor.
5. Non-sticky navigation starts from the current row, then ordinary navigation clears the range.
6. `toggleListRangeSelection` cancels any active range; otherwise it anchors at the current row and enters sticky mode.
7. A direct row click selects one row and clears range mode. Mouse drag explicitly establishes a non-sticky range from the press row to the release/drag row.
8. Refreshes preserve endpoints when their stable ids remain. If an endpoint disappears, the range is cleared and the surviving selected row is retained or clamped using the existing selection policy.
9. Batch mutation refreshes explicitly collapse selection to the first surviving row, matching lazygit's `CollapseRangeSelectionToTop` behaviour.
10. Empty lists have no selected id, no active range, and index `0`.

Rendering uses the inclusive resolved range. Unfocused panes keep row identity but do not paint the active range background, matching the existing focused-row contract.

## Keybindings and dispatch

`src/ui/bindings.ts` adds three actions to `ACTIONS`:

- `toggle-range-select`
- `range-select-up`
- `range-select-down`

The bindings are context-local for interactive list panes (`files`, `branches`, `commits`, `stash`) and for `main`'s diff range mode where applicable. The handlers pass both `model` and `ui` to availability-aware resolution, preserving the existing binding fall-through rule.

The list contexts do not acquire range actions merely because they render rows. A context's mutation binding declares whether it accepts one row or the resolved range. Menu, status, command-log, and other non-list contexts do not receive list range bindings.

## Action coverage

### Files pane

The existing Files tab keeps its tree-specific row projection. Range-aware actions resolve selected file-tree rows to unique file paths and retain the existing parent/child normalization rules:

- `Space`: stage or unstage all files represented by the selected rows.
- `d`: discard all files represented by the selected rows through the existing discard mode flow.
- `e`: remains single-file because the current githunk editor callback opens one path and does not provide lazygit's multi-file editor semantics.
- Directory rows continue to expand to their descendants; duplicate child paths are removed before mutation.
- Mixed submodule/conflict selections retain the existing refusal rules rather than silently partially mutating.

### Branches pane

Panel 3's current local-branch and remote-branch child rows gain range-aware deletion. The existing local/remote/both confirmation choices remain visible, but the request carries all selected branch targets. The checked-out branch, worktree, upstream, merged-state, and force-delete checks apply to the complete selection before mutation. A refresh occurs once after the batch and selection collapses to the first surviving row.

The local-commits child remains range-selectable at the state level, but no new cherry-pick/rebase mutation is invented in this scope.

### Stash pane

`d` drops all selected stash refs in one serialized mutation, highest index first where indexes are required, and refreshes once. Apply, pop, inspect, and rename remain single-item. Filtered rows operate on the currently displayed contiguous range, not on hidden entries.

### Main pane

`v` and `Shift+Up`/`Shift+Down` operate on the current diff document's line selection. Hunk mode remains available through the existing hunk navigation/action model. The selected range is converted to exact diff line indexes before mutation:

- `Space`: stage selected additions/deletions when the working-tree scope permits.
- `d`: discard selected additions/deletions when the scope permits.
- `Ctrl+O`: copy exactly the selected patch range through the existing OSC52 path.

Wrapped rows, wide/combining characters, context lines, and binary/unavailable actions retain the current `DiffDocument` and availability rules.

## Data flow and errors

1. Key or mouse input produces a pure list/main selection transition.
2. `RootView` renders immediately and resolves the selected stable ids/indexes.
3. A range-aware action builds a domain batch request or exact diff indexes.
4. `RootView` invokes the existing callback inside `runUiMutation` semantics.
5. `AppController` serializes Git writes through `MutationQueue`, logs each operation according to existing command-log rules, and refreshes once per batch.
6. `finally` still calls `view.update(controller.state)` through `createApp`.
7. Failed batch operations leave the error visible and do not claim that later items succeeded. The next refresh revalidates selection ids.

## Tests

TDD starts with pure `ListState` tests before production changes:

- sticky range expansion and cancellation
- non-sticky expansion and ordinary-navigation cancellation
- reverse-direction inclusive ranges
- direct click cancellation
- stable-id refresh preservation and endpoint removal
- empty-list and one-row boundaries
- range rendering only while focused

Then repository-backed integration tests cover:

- branch deletion of a contiguous local range, including confirmation and single refresh
- remote-branch child deletion of a contiguous range
- stash drop in normal and filtered views
- files stage/discard ranges across files and directories, including mixed unsupported rows
- main staging/discard/copy range behaviour through the real renderer and Git runner

The final gate is `bun run check`, followed by an actual `bun run start` smoke that exercises `v`, `Shift+Down`, ordinary navigation cancellation, branch deletion, stash drop, and main line selection.

## Non-goals

- Non-contiguous multi-selection.
- New cherry-pick, rebase, squash, fixup, revert, commit-attribute, or custom-command features.
- New runtime dependencies.
- Moving Git process execution into UI code.
- Changing githunk's existing review-target or persistence model.
