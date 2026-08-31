# Task 5 implementation report

## Changed files

- Added `src/review/git/pierre-diff-adapter.ts`, the renderer-facing Pierre boundary. It exports exactly `ReviewDiffMetadata` and `ReviewDiffHunk` normalized fields from the brief, normalizes hunk content groups, preserves file identity/type, caches metadata by `ReviewFile` identity, and returns the existing partial fallback for parser failures. It also owns review patch construction and plain trailing-newline normalization.
- Updated `src/ui/review-workspace/hunk-review-model.ts` to consume named normalized adapter types and remove all Pierre imports/parser logic from UI.
- Updated `src/ui/review-workspace/components/ReviewDiffRow.tsx` to use the adapter's plain string normalizer instead of importing `cleanLastNewline`; preserved width fitting, pane geometry, and syntax span colors.
- Reduced `src/ui/review-workspace/react-review-host.tsx` to React mount/session invalidation/unmount lifecycle responsibilities. Removed feedback panes/composer, direct intent dispatch, focus state, and compatibility key branches.
- Reduced `ReviewScreenView` in `src/app/screen-controller.ts` and the headless view in `src/app/create-app.ts` to the root/destroy shell contract.
- Updated active-surface tests in `tests/ui/review-workspace/stream-pane.integration.test.ts`, `navigation.integration.test.ts`, `finish.integration.test.ts`, `context-expansion.integration.test.ts`, `real-surface.integration.test.ts`, `review-diff-row.test.tsx`, `tests/review/conformance/row-planner.conformance.test.ts`, `tests/app/screen-controller.test.ts`, and `tests/ui/review-workspace/finish-dialog.test.ts`.
- Added a trailing-newline test covering both fixed split-cell widths and preserved foreground highlighting.
- Updated the architecture section of `docs/superpowers/specs/2026-08-27-branch-review-workspace-design.md` to document React as the active renderer, the Pierre adapter/core/storage/shell boundaries, and deferred projection/Hunk boundaries.

## Deleted files

After source and test reference analysis, deleted the superseded imperative renderer and private behavior modules:

- `src/ui/review-workspace/review-workspace.ts`
- `src/ui/review-workspace/stream-pane.ts`
- `src/ui/review-workspace/feedback-composer.ts`
- `src/ui/review-workspace/feedback-pane.ts`
- `src/ui/review-workspace/files-pane.ts`
- `src/ui/review-workspace/row-planner.ts`
- `src/ui/review-workspace/review-highlight-text.ts`
- `src/ui/review-workspace/layout.ts`

Deleted tests whose only active implementation was one of those retired modules: feedback composer/integration, files-pane, layout, row-planner, row-planner-highlight, and imperative highlight integration tests. The focused stream, navigation, conformance, finish, and context coverage now exercises React/OpenTUI rendered ids, input, mouse, controller state, and captured frames.

## Reference analysis

- Source search showed no active imports of the deleted modules outside their own implementation before deletion; `ReviewWorkspaceApp`, controller, finish dialog, header/sidebar, hunk row modules, highlights, and React session remain active.
- Post-migration search showed no UI Pierre imports. Pierre imports remain only in `src/review/git/patch-adapter.ts`, the new Git adapter, and the pre-existing `src/review/git/highlight/` boundary.
- No `ReviewWorkspace.handleKeyPress`, `getFeedbackComposer`, `getFeedbackPane`, `setRangeActive`, `dispatchKey`, `ReviewStreamPane`, or row-planner imports remain in active tests/source.
- `ReviewScreenView` has only `root` and `destroy`; screen-controller uses no renderer command/feedback methods.

## Behavior

Aggregate/windowed rendering, syntax highlighting, binary/sidebar visibility, navigation, context expansion qualification/cache behavior, finish persistence, and lifecycle cleanup remain covered by active tests. The adapter keeps stable metadata identity for repeated conversion of the same `ReviewFile`, and malformed parser output remains a visible partial file model.

## Exact focused verification

Command:

```bash
bun test tests/ui/review-workspace/hunk-review-model.test.ts tests/ui/review-workspace/hunk-diff-rows.test.ts tests/ui/review-workspace/review-diff-row.test.tsx tests/ui/review-workspace/react-review-host.integration.test.tsx tests/app/screen-controller.test.ts tests/acceptance/branch-review-artifact.integration.test.ts tests/ui/review-workspace/finish.integration.test.ts tests/ui/review-workspace/navigation.integration.test.ts tests/ui/review-workspace/stream-pane.integration.test.ts tests/ui/review-workspace/context-expansion.integration.test.ts tests/review/conformance/row-planner.conformance.test.ts
```

Output:

```text
40 pass
0 fail
163 expect() calls
Ran 40 tests across 11 files. [2.32s]
```

## Concerns

- Repository-wide `bun run typecheck` still reports pre-existing diagnostics in unrelated core/storage and test files (including missing Bun test globals, anchor narrowing, state-store typing, and fixture state shape). No diagnostics remained for the new adapter, the reduced host/screen contracts, or deleted-module imports after migration.
- The finish integration test emits an existing React `act(...)` warning while exercising the asynchronous finish lifecycle; the focused command still passes completely.

## Review findings follow-up

- Migrated `benchmarks/review-row-plan.ts` from the deleted `row-planner` to the active normalized adapter and `buildHunkStackRows` surface. The `bench:review-rows` package command is retained and now smoke-tests fixture rows plus a 500-file active-model stress document.
- Added `tests/ui/review-workspace/highlight.integration.test.tsx`, which renders `ReviewWorkspaceApp` and verifies the real `useReviewHighlights`/Pierre highlight adapter produces syntax-colored spans in a rendered row.
- Replaced the two synthetic conformance cases with all 13 corpus fixtures. Each fixture now validates normalized hunk metadata and line slices, and checks every corpus source-address sample against active Hunk stack rows, including CRLF, missing-newline, CJK, combining marks, long lines, binary/mode-only, rename/copy/delete, ambiguous context, and multi-file cases.

## Follow-up verification

Focused command rerun:

```text
51 pass
0 fail
268 expect() calls
Ran 51 tests across 11 files. [2.14s]
```

Active syntax integration:

```text
1 pass
0 fail
2 expect() calls
Ran 1 test across 1 file. [683.00ms]
```

Active row benchmark:

```text
fixtureCount: 13
totalRowsBuilt: 51
largeTotalRows: 2500
largeViewportRows: 56
```
