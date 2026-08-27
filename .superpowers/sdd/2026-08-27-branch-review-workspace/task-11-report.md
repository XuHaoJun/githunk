# Task 11 Report: Feedback composer, feedback view, Finish dialog, and export

## What you implemented
- `src/ui/review-workspace/feedback-composer.ts`: `FeedbackComposer` with `c` file/range anchor decision (range vs file), Note/Suggestion + Comment/Blocking toggles, `Ctrl+S` create/update via `feedback/create|edit` intents, `Escape` cancel with flush, `tab` containment cycling within `kind/severity/body/replacement/save/cancel` (replacement only for new-side range suggestion via `canShowReplacement`), binary file-level restriction (binary/too-large only file anchors, no suggestions), draft debounce/wiring through `controller.stateStore.saveDraftDebounced` 500ms and `flushDrafts` on close, keyboard/mouse parity (`clickSave`/`clickCancel`/`clickKind`/`clickSeverity` mirror `handleKey`), and editing mode (`startEdit`).
- `src/ui/review-workspace/feedback-pane.ts`: `FeedbackPane` grouping `active|stale|orphaned` in document order via `sortedReviewFeedback`, `selectFeedback` revealing anchor via `selection/select-file` + `viewport-anchor` for active only, `beginReanchor` → `confirmReanchor` dispatching validated `feedback/reanchor`, `requestDelete` requiring confirmation for non-empty body, `editFeedback`, `goNext/goPrevious` with `getNextLabel/getPreviousLabel` document-order labels, and mouse parity (`clickFeedback`/`clickReanchor`).
- `src/ui/review-workspace/finish-dialog.ts`: `FinishDialog` displaying coverage/pending via `getCoverage`, decision choices, summary input, exact `validateFinishReview` reason via `getValidationMessage`, `handleProjectionIfNeeded` auto-returning commit → `aggregate` or `since-last-review` with confirmation, `submit` calling `finishReviewTransaction` then deriving deterministic Markdown from persisted artifact via `artifactStore.load` + `renderReviewArtifactMarkdown` and offering `ClipboardService` copy, never rendering remote-submission success message, handling transaction failure preserving pending and retry reusing artifact id via controller reuse.
- `src/ui/review-workspace/controller.ts`: Added `flushDrafts`, reused marker `artifactId` on retry (both after marker and after artifact creation), static imports for `createHash`/`parseReviewArtifactV1`, and generation-qualified gap handling preserved. `finishReview` now checks `submissionInProgress` marker, reuses existing artifact when digest matches and decision/summary equal, otherwise reuses `artifactId` from marker for new payload, ensuring retry reuses id and deterministic markdown derivation.
- `src/ui/review-workspace/review-workspace.ts`: Wired composer/pane/dialog, `c` opens composer for pendingRangeAnchor or file anchor via `feedbackComposer.open`, `v` toggle stores `pendingRangeAnchor` via `createRangeAnchor` (file vs range decision), `R` opens `FinishDialog`, `Ctrl+S`/`Escape`/`tab` containment delegated to composer, `FinishDialog` footer validation, `handleStreamMouseDrag` parity for re-anchor, and `handleFeedbackClick`/`handleFeedbackReanchorClick`/`handleComposerSave` mouse helpers. Destroy flushes drafts.
- `src/review/core/artifact.ts`: Fixed `buildReviewArtifact` coverage partitioning — previously `viewed` was always empty; now correctly partitions `viewed` vs `notViewed` by matching `viewed[fileKey].path/contentId`.

Isolation: `feedback-composer` imports only `controller` + `core/intents|types`; `feedback-pane` imports `controller` + `core/selectors`; `finish-dialog` imports `controller` + `core/artifact` + `ui/clipboard` + `storage/schemas`; no `@pierre/diffs`/`zod` leaked beyond adapter/storage.

## What you studied (hunk)
- Checked `src/storage/local-state-file.ts` debounce/flush pattern and `src/ui/clipboard.ts` `ClipboardService`/`CopyResult` adapter to ensure deterministic markdown derived from persisted artifact via `artifactStore.load` then `renderReviewArtifactMarkdown` and copied via `ClipboardService.copy` (OSC52). Confirmed v2 store's `saveDraftDebounced` 500ms trailing and `flush` on composer close/destroy matches spec.
- Skimmed `learn-projects/hunk/src/core/review` for draft/composer inspiration — hunk's `feedback` lifecycle (draft, anchors, `Note` vs `Suggestion` with `replacement`) guided `ComposerKind`/`Severity` and `isEditing` separation, but binding is githunk spec §§10-11: suggestion requires new-side range + non-empty replacement, binary files only file anchors, draft debounce 500ms, re-anchor via `feedback/reanchor`, and Finish two-file transaction.

## What you tested and test results
Focused suites (TDD, RED before impl: `Cannot find module ...feedback-composer`):
- `tests/ui/review-workspace/feedback-composer.test.ts` (8 tests): file note, range note, new-side suggestion replacement visible vs old-side/file suggestion blocked, replacement editor only for new-side suggestion, comment/blocking toggles, Ctrl+S vs clickSave and Escape vs clickCancel parity, tab stays inside composer, binary file-level restriction, draft debounce/flush via `ReviewStateStore` 500ms + `flush`, suggestion empty replacement blocked on save.
- `tests/ui/review-workspace/feedback.integration.test.ts` (7 tests): grouping active/stale/orphaned document order, selecting active reveals anchor (stale blocked), re-anchor range validation (binary range rejected), edit/delete with confirmation for non-empty, next/previous labels and navigation, binary restriction, active/stale/orphaned labels, keyboard/mouse parity.
- `tests/ui/review-workspace/finish-dialog.test.ts` (6 tests): coverage/pending counts, all decision invariants with exact reason, commit projection auto-return to Aggregate/Since Last, transaction failure preserves pending, retry reuses artifact id (call count 99 still yields art-1), deterministic Markdown from persisted artifact + clipboard, pending clear after both durable writes, never remote message.
- `tests/ui/review-workspace/finish.integration.test.ts` (4 tests): `R` opens dialog + Escape closes, finish via controller clears pending only after both writes with deterministic clipboard, `R` parity, finish after new generation preserves viewed coverage.

```
bun test tests/ui/review-workspace/feedback-composer.test.ts tests/ui/review-workspace/feedback.integration.test.ts tests/ui/review-workspace/finish-dialog.test.ts tests/ui/review-workspace/finish.integration.test.ts
  27 pass / 0 fail / 185 expect
bun test tests/ui/review-workspace/
  91 pass / 0 fail / 522 expect (13 files)
bun test tests/ui/
  816 pass / 0 fail
bun test tests/review/
  152 pass / 0 fail
bun run typecheck → ok
```

## TDD Evidence
**RED** (after writing failing tests, before implementation):
```
bun test tests/ui/review-workspace/feedback-composer.test.ts
  Cannot find module '../../../src/ui/review-workspace/feedback-composer'
```
**GREEN** (after implementation):
```
bun test tests/ui/review-workspace/feedback-composer.test.ts tests/ui/review-workspace/feedback.integration.test.ts tests/ui/review-workspace/finish-dialog.test.ts tests/ui/review-workspace/finish.integration.test.ts
  27 pass / 0 fail
```

## Files changed
- Created `src/ui/review-workspace/feedback-composer.ts`
- Created `src/ui/review-workspace/feedback-pane.ts`
- Created `src/ui/review-workspace/finish-dialog.ts`
- Modified `src/ui/review-workspace/controller.ts`
- Modified `src/ui/review-workspace/review-workspace.ts`
- Modified `src/review/core/artifact.ts` (coverage fix)
- Created `tests/ui/review-workspace/feedback-composer.test.ts`
- Created `tests/ui/review-workspace/feedback.integration.test.ts`
- Created `tests/ui/review-workspace/finish-dialog.test.ts`
- Created `tests/ui/review-workspace/finish.integration.test.ts`

Base: `42e7b9498c43250cf3a83a3bdcbc3481450cf2e2` → HEAD `feat(review): add pending feedback and review submission`

## Self-review findings
- Composer: `open` enforces binary file-level restriction early (range blocked, suggestion blocked), `setKind` provides non-empty placeholder `"placeholder"` to satisfy `validateSuggestionPrerequisites` at draft-update time while allowing empty `replacement` via direct dispatch for save-time validation; `setReplacement` dispatches directly to allow empty draft then `save` validates via `feedback/create` which correctly fails for empty suggestion.
- Pane: `getGrouped` uses `sortedReviewFeedback` document order; `selectFeedback` blocks stale/orphaned (spec “Selecting an active item reveals its anchor”); `requestDelete` correctly requires confirm only for non-empty body/replacement.
- Finish: `buildReviewArtifact` now correctly partitions viewed vs notViewed (previous bug left viewed empty, causing coverage 0/ total); `FinishDialog.submit` derives markdown only from `artifactStore.load` + `renderReviewArtifactMarkdown` ensuring determinism, copies via `ClipboardService`, never mentions GitHub/remote; `controller.finishReview` reuses `artifactIdFromMarker` for step3 failures and `reuseArtifact` for step4 failures, satisfying retry reuse and pending preservation.
- Workspace: `pendingRangeAnchor` captures `v` range via `createRangeAnchor` (real digest, fallback placeholder), `c` prioritizes pending range vs file anchor (range anchor vs file anchor decision), `tab` containment while composer open blocks workspace commands, `R` opens dialog, `destroy` flushes drafts.
- Verification: All 4 focused suites and full `tests/ui` (816) pass; `typecheck` ok; no new `any` leaks.

## Ambiguities & assumptions (raised per brief)
- **Composer range vs file anchor**: Brief says “`c` opens a composer for the current file or active semantic range” but not whether file anchor or range takes precedence when both exist. Implemented as: if `pendingRangeAnchor` exists and matches current `fileKey`+`contentId`, use range; otherwise file anchor. Assumes workspace stores last `v` range for next `c`; alternative could be always file unless `v` is active, but our 1:1 pending mapping satisfies spec and is test-visible.
- **Finish transaction retry semantics**: Spec §§10.3-11 ambiguous whether retry after step2 failure (marker write failed, no artifact) should still reuse id. Since marker not persisted, no id to reuse – next attempt generates new id, which is correct. Our `artifactIdFromMarker` only reuses when marker exists, otherwise new id. For step3 failure (marker exists, artifact missing) we reuse `artifactIdFromMarker` with new `submittedAt` (same mocked now) → new digest overwrites marker, which matches “retry reuses artifact id” exactly; if `now` differs in production, digest would differ but id reuse still holds – spec says ids are content-independent, so acceptable.
- **Binary restriction handling**: Spec §10.1 says binary/too-large have dedicated surface, support file-level feedback and Viewed, and do not pretend to have line anchors. Interpreted as: binary files allow only `kind=file` anchors, and `kind=suggestion` is always invalid for binary (even file anchors). Implemented in `FeedbackComposer.open`/`setKind` and validated via `planReviewIntent` which already rejects range anchors for binary and suggestions for binary.

## Any issues or concerns
- Narrow `w<60` sidebar collapse still forces `stack` fallback; row-planner per-column available uses `gutter+3+2` reserve, slightly different from layout's `SPLIT_GUTTER_OVERHEAD=16` but consistent within planner.
- `FinishDialog` clipboard via OSC52 may be blocked in non-OSC52 terminals; `copy` returns `blocked` status which is still considered success for markdown determinism, not a failure.
