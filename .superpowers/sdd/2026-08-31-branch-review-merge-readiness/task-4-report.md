# Task 4 — refresh, persistence, Finish ordering, and failure recovery

## Files changed

- `src/ui/review-workspace/controller.ts`
  - Refresh now qualifies responses by request/review/generation, reconciles the current aggregate exactly once per accepted generation, and performs one atomic state publication. A successful same-generation retry clears a prior load error without repainting the document.
  - Finish validates before transaction work, verifies a marker artifact against the complete current semantic artifact (stable structural comparison), and retains in-memory pending state when durable work fails.
  - Controller destruction is awaitable and drains draft/state-store writes.
  - Corrupt-state quarantine warnings remain visible if replacing the malformed state file also fails.
- `src/app/screen-controller.ts`, `src/app/create-app.ts`, `src/main.ts`
  - Async review-state flushing is propagated through screen-controller and app shutdown; the startup failure path awaits app destruction, and renderer destroy hooks explicitly schedule app cleanup.
- `src/review/core/reconcile.ts`
  - Semantic line selections now use the same context relocation policy as feedback anchors, preserving a unique relocated line when content identity changes and clearing unresolved selections.
- `src/review/storage/review-artifact-store.ts`
  - `finishReviewTransaction()` now performs immutable artifact create-or-digest-verify first, writes the `submissionInProgress` marker with current semantic state second, and finalizes/clears feedback and draft only after the marker succeeds.
  - Artifact, marker, and finalization failures return actionable stage-specific errors and leave retryable pending state intact.
  - Existing marker artifacts remain idempotently retryable through digest verification.
- `src/review/storage/review-state-store.ts`
  - Durable projection is always aggregate-only; only semantic selection, line selection, filter, feedback, Viewed records, draft, and supported expanded-gap identities are serialized. Draft writes also normalize an existing unsupported projection.
  - Draft flushing drains updates that arrive while a queued write is in flight and always waits for the underlying write queue.
- `tests/review/storage/review-artifact-store.integration.test.ts`, `tests/ui/review-workspace/finish-dialog.test.ts`
  - Updated artifact-failure expectations to the approved artifact-first ordering: no marker is written before an artifact succeeds.
- `tests/helpers/shell-harness.ts`, `tests/acceptance/branch-review-artifact.integration.test.ts`
  - Acceptance now drives source selection and composer fields through actual OpenTUI nodes/input (`mockMouse`, `typeText`, key commands), inspects the rendered aggregate workspace, and avoids `ReviewWorkspace`/`FeedbackComposer` imperative APIs.
- `tests/ui/review-workspace/refresh.integration.test.ts`
  - Added exact review-identity qualification and storage-error persistence-retry regressions.

## Verification

Exact focused command from the Task 4 brief:

```text
bun test tests/review/core/reconcile.test.ts tests/review/core/artifact.test.ts tests/review/storage/review-artifact-store.integration.test.ts tests/review/storage/review-state-store.integration.test.ts tests/ui/review-workspace/finish-dialog.test.ts tests/ui/review-workspace/finish.integration.test.ts tests/ui/review-workspace/refresh.integration.test.ts tests/ui/review-workspace/lifecycle.integration.test.ts tests/acceptance/branch-review-artifact.integration.test.ts
```

Final exact output after this fix round:

```text
bun test v1.4.0 (34cbb9a40)

 63 pass
 0 fail
 299 expect() calls
Ran 63 tests across 9 files. [2.17s]
```

Narrow acceptance/lifecycle verification:

```text
bun test tests/acceptance/branch-review-artifact.integration.test.ts tests/ui/review-workspace/lifecycle.integration.test.ts

3 pass
0 fail
49 expect() calls
Ran 3 tests across 2 files. [1.73s]
```

`git diff --check` completed with no output/errors.

## Fix-round notes

1. Refresh rejects an accepted document whose review identity differs from the captured active review before the same-generation fast path or reconciliation.
2. Same-generation refresh distinguishes storage errors from load errors: storage errors retry `persistState()` and remain published if the retry fails; they are cleared only after a successful persistence retry.
3. `ReviewWorkspaceController.destroy()`, `AppScreenController.destroy()`, and `App.destroy()` now propagate awaitable shutdown flushing. `closeBranchReview()` also awaits controller destruction, and startup failure cleanup awaits app destruction.
4. The named branch artifact acceptance no longer imports or calls `ReviewWorkspace`, `FeedbackComposer`, `handleSidebarClick`, or `handleKeyPress`; source selection and composer editing use actual OpenTUI input/renderable nodes while artifact persistence and restart assertions remain covered.
5. Semantic line selection relocation is unique-context based and content-identity aware; unresolved context no longer fabricates a hunk-wide selection.

6. Open persistence now carries forward any existing `submissionInProgress` marker instead of serializing the in-memory aggregate's marker-free representation over it. Added a restart/open retention regression.

Final focused rerun after marker retention:

```text
64 pass
0 fail
300 expect() calls
Ran 64 tests across 9 files. [2.15s]
```

## Round-2 re-review fixes

1. Refresh ownership is rechecked after document loading, before same-generation recovery, and after every awaited persistence call. Persistence snapshots the accepted state and suppresses stale error publication when a request is superseded or shutdown begins.
2. Default-base open carries the quarantine warning observed during base resolution into the subsequent persisted-state load, so corrupt-state recovery remains actionable on the normal no-argument path without retaining stale warnings.
3. Every draft transition that can leave a pending debounce snapshot, including cancel/create/edit, schedules the current draft value. Null transitions therefore flush as semantic `draft: null` instead of resurrecting an older draft during shutdown.
4. `AppScreenController.destroy()` retains and awaits any in-flight branch open, and every supersession/error path awaits the created review controller's async cleanup.
5. Finish acceptance now opens the rendered Finish dialog, selects Request Changes, enters the summary through the rendered textarea, and clicks the rendered Submit node before loading the stored artifact and checking aggregate/Markdown/restart behavior.

Round-2 focused verification:

```text
bun test tests/ui/review-workspace/refresh.integration.test.ts tests/app/screen-controller.test.ts tests/acceptance/branch-review-artifact.integration.test.ts

19 pass
0 fail
116 expect() calls
Ran 19 tests across 3 files.
```

Round-2 persistence verification:

```text
bun test tests/review/storage/review-state-store.integration.test.ts

9 pass
0 fail
22 expect() calls
Ran 9 tests across 1 file.
```

The earlier concern that acceptance artifact creation used the semantic Finish API is resolved: the acceptance now submits through the rendered Finish dialog.

Exact focused suite rerun after the round-2 changes:

```text
bun test tests/review/core/reconcile.test.ts tests/review/core/artifact.test.ts tests/review/storage/review-artifact-store.integration.test.ts tests/review/storage/review-state-store.integration.test.ts tests/ui/review-workspace/finish-dialog.test.ts tests/ui/review-workspace/finish.integration.test.ts tests/ui/review-workspace/refresh.integration.test.ts tests/ui/review-workspace/lifecycle.integration.test.ts tests/acceptance/branch-review-artifact.integration.test.ts

66 pass
0 fail
305 expect() calls
Ran 66 tests across 9 files.
```

## Round-3 re-review fix

`AppScreenController.openBranchReview()` now catches `createReviewView()` failures, awaits the successfully opened review controller's destruction, and then rethrows. Added a lifecycle regression proving the failed view construction leaves no live review controller.

Round-3 lifecycle verification:

```text
bun test tests/app/screen-controller.test.ts tests/ui/review-workspace/lifecycle.integration.test.ts tests/acceptance/branch-review-artifact.integration.test.ts

10 pass
0 fail
73 expect() calls
Ran 10 tests across 3 files.
```

The exact Task 4 focused suite still passes: 66 tests, 0 failures, 305 expect() calls across 9 files.

## Round-4 test-quality fix

The `createReviewView()` failure regression now gates the review controller's `destroy()` behind a promise. It asserts that `openBranchReview()` remains pending while cleanup is blocked, then releases cleanup and verifies the original view-construction error plus final controller destruction.

Round-4 lifecycle and acceptance verification:

```text
bun test tests/app/screen-controller.test.ts tests/ui/review-workspace/lifecycle.integration.test.ts tests/acceptance/branch-review-artifact.integration.test.ts

10 pass
0 fail
76 expect() calls
Ran 10 tests across 3 files.
```

Exact Task 4 focused suite:

```text
66 pass
0 fail
305 expect() calls
Ran 66 tests across 9 files.
```
