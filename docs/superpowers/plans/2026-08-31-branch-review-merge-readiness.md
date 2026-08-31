# Branch Review Merge Readiness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the active Branch Review workspace a trustworthy, aggregate-only local review flow for committed `base...HEAD` changes. Comments and suggestions must retain exact semantic anchors, stale feedback must remain visible and block Finish, pending state must survive restart, and Finish must write the immutable artifact before clearing pending state.

**Architecture:** Keep `ReactReviewHost` → `ReviewWorkspaceApp` as the only active renderer. Add renderer-neutral semantic line selection to review core, route all feedback creation and re-anchoring through validated core intents, and keep the existing aggregate document/reconciliation pipeline. Remove projection selection from the active runtime, retire the duplicate imperative workspace, and move Pierre parsing behind a Git/document adapter that returns renderer-owned metadata.

**Tech Stack:** TypeScript 5.9, Bun, `@opentui/core`, `@opentui/react`, React 19, `@pierre/diffs` 1.3.5, Zod v4, Bun tests.

**Spec:** `docs/superpowers/specs/2026-08-31-branch-review-merge-readiness-design.md`

## Global Constraints

- Aggregate `base...HEAD` is the only selectable and rendered projection in this merge.
- `0` focuses Diff, `1` focuses Files, and `Tab` cycles Diff → Files → Filter/Composer → Diff. Layout switching must not reclaim those keys.
- Semantic review state may contain file, hunk, side, line, content identity, and context digest; it must not contain terminal row indexes, renderer handles, or raw viewport offsets.
- `createRangeAnchor` remains the canonical range-anchor constructor. UI code supplies semantic addresses; it must not recreate digest or owner-hunk rules.
- A suggestion is saveable only when it has a new-side range anchor, a current content identity, a non-binary/non-oversized target, and replacement text whose trimmed length is greater than zero. No synthetic replacement value is allowed.
- Reconciliation may relocate a uniquely matching anchor, mark changed/ambiguous context stale, and mark missing files orphaned. It must never replace stale/orphaned feedback with a hunk-wide anchor.
- Branch Review may write only local review state and review artifacts. It must not stage, discard, commit, reset, checkout, rebase, push, pull, or mutate the working tree.
- Projection loaders and deferred Hunk features may remain only when unreachable from the active command/runtime path and absent from active help/footer output.
- Use `learn-projects/hunk/` as a behavior reference only. Do not import Hunk components, sessions, or provider packages.

Behavior references from `learn-projects/hunk/`:

- `learn-projects/hunk/docs/keybindings.md` is the command-inventory reference for semantic navigation, panel focus, and explicitly deferred viewer features.
- `learn-projects/hunk/src/core/run/commandCatalog.ts` and `learn-projects/hunk/src/ui/lib/appCommands.ts` show the desired command-id-to-handler separation.
- `learn-projects/hunk/src/ui/components/panes/DiffPane.tsx`, `learn-projects/hunk/src/ui/lib/lineCursors.ts`, and `learn-projects/hunk/src/ui/lib/copySelection.ts` are references for cursor and selection behavior only; their components and session APIs are not part of this implementation.

---

## Task 1: Lock the aggregate projection and active command contract


**Files:**

- Modify `src/ui/review-workspace/command-catalog.ts`.
- Modify `src/ui/review-workspace/ReviewWorkspaceApp.tsx`.
- Modify `src/ui/review-workspace/controller.ts`.
- Modify `src/ui/review-workspace/finish-dialog.ts`.
- Modify `src/ui/review-workspace/header.ts` if projection text needs an explicit aggregate guard.
- Modify `src/review/storage/schemas.ts` only where persisted projection parsing needs the active-release normalization hook.
- Update `tests/ui/review-workspace/command-catalog.test.ts`, `tests/ui/review-workspace/react-review-workspace.integration.test.tsx`, `tests/ui/review-workspace/react-review-host.integration.test.tsx`, `tests/ui/review-workspace/finish-dialog.test.ts`, `tests/ui/review-workspace/refresh.integration.test.ts`, `tests/review/storage/schemas.test.ts`, and `tests/acceptance/branch-review-workspace.integration.test.ts`.

**Dependencies:** None. This task defines the runtime contract consumed by the core and UI selection tasks.

- [ ] Add failing command-contract assertions before changing the handler. The catalog must expose panel commands with these exact bindings and must not bind layout to `0`, `1`, or `2`:

  ```ts
  expect(command("review.focusDiff").keys).toEqual(["0"])
  expect(command("review.focusFiles").keys).toEqual(["1"])
  expect(command("review.toggleFocus").keys).toEqual(["tab"])
  expect(command("review.layoutCycle").keys).toEqual(["l"])
  expect(REVIEW_COMMANDS.flatMap((entry) => entry.keys)).not.toContain("2")
  expect(REVIEW_COMMANDS.some((entry) => /projection|since last|commit projection/i.test(entry.title))).toBe(false)
  ```

  Add an active-surface regression that opens a state persisted with `{ kind: "since-last-review" }` or `{ kind: "commit", oid }`, renders the document, and asserts `state.projection.kind === "aggregate"`, the header contains `[Aggregate]`, and the frame contains neither `Since Last` nor `Commit`.

- [ ] Replace the catalog's current layout bindings (`review.layoutAuto`=`0`, `review.layoutSplit`=`1`, `review.layoutStack`=`2`) with `review.focusDiff`, `review.focusFiles`, `review.toggleFocus`, and one explicit `review.layoutCycle`=`l`. Keep layout state (`auto`, `split`, `stack`) independent from panel focus. Keep all deferred projection commands absent from `REVIEW_COMMANDS`.

- [ ] Add one active command execution path in `ReviewWorkspaceApp.tsx`. The keyboard branch must resolve the normalized key with `resolveReviewCommand(key, focus)` and dispatch by command id; remove the parallel key-specific branches for `0`, `1`, `Tab`, `l`, navigation, feedback, and Finish. Mouse callbacks must invoke the same command executor with `review.selectFile`, `review.selectDiffLine`, or `review.selectFeedback` command ids rather than directly duplicating state transitions. Textarea-local Escape, Enter, and Ctrl-S handling remains modal input behavior and must exit before workspace command resolution.

- [ ] Normalize persisted projection metadata at the active boundary. Define a local helper with this contract in `src/ui/review-workspace/controller.ts`:

  ```ts
  function normalizeActiveProjection(
    projection: ReviewProjection,
  ): Extract<ReviewProjection, { kind: "aggregate" }> {
    return { kind: "aggregate" }
  }
  ```

  Apply it when reconstructing persisted state in `open()` and when writing active state through `persistState()`. Remove `loadProjection()` from the active controller API instead of returning success after only dispatching `projection/set`. Leave `src/review/git/load-review-projection.ts` exported for isolated future-loader tests, but remove every active import and command path to it.

- [ ] Remove the commit-projection auto-switch from `FinishDialog`. Delete `handleProjectionIfNeeded()`, the `projection-switched` result, `switchedProjection`, and the message that promises an automatic transition. `submit()` must call `validateFinishReview()` directly and then `controller.finishReview()`. An invalid non-aggregate state must return a blocking validation result; it must never be silently changed during Finish.

- [ ] Remove the aggregate-inapplicable history-rewrite error publication from the active refresh path. Keep ancestor/projection loader behavior in `src/review/git/load-review-projection.ts` for deferred work, but aggregate refresh must load, qualify, reconcile, and publish the aggregate document without claiming a Since Last mode.

- [ ] Derive the active footer and help text from the command catalog. The visible strings must state `0 Diff`, `1 Files`, `Tab cycle panels`, and `l layout`; the range help must say semantic line/range rather than hunk-wide selection. Add assertions for both `reviewHelp()` and the actual `review-help-dialog` frame.

**Acceptance:** Active keyboard, mouse, footer, help, persisted restore, header, refresh, and Finish paths all agree that Aggregate is the only active projection and that panel focus owns `0`, `1`, and `Tab`.

**Focused verification:**

```bash
bun test tests/ui/review-workspace/command-catalog.test.ts tests/ui/review-workspace/react-review-workspace.integration.test.tsx tests/ui/review-workspace/react-review-host.integration.test.tsx tests/ui/review-workspace/finish-dialog.test.ts tests/ui/review-workspace/refresh.integration.test.ts tests/review/storage/schemas.test.ts tests/acceptance/branch-review-workspace.integration.test.ts
```

---

## Task 2: Add renderer-neutral semantic line selection and draft validation

**Files:**

- Modify `src/review/core/state.ts`, `src/review/core/actions.ts`, `src/review/core/intents.ts`, `src/review/core/reducer.ts`, `src/review/core/navigation.ts`, `src/review/core/anchors.ts`, and `src/review/core/reconcile.ts`.
- Modify `src/review/storage/schemas.ts` and `src/review/storage/review-state-store.ts`.
- Add `tests/review/core/line-selection.test.ts` if the existing navigation tests cannot express the new pure helpers; otherwise extend `tests/review/core/navigation.test.ts`.
- Extend `tests/review/core/reducer.test.ts`, `tests/review/core/anchors.test.ts`, `tests/review/core/reconcile.test.ts`, `tests/review/core/artifact.test.ts`, and `tests/review/storage/schemas.test.ts`.

**Dependencies:** Task 1's active projection policy is independent of these core types; Task 3 consumes the exact types below.

- [ ] Add the semantic current-line type and state field. The persisted selection must include identity and digest, not terminal coordinates:

  ```ts
  export type ReviewLineSelection = Readonly<{
    fileKey: string
    hunkIndex: number
    side: "old" | "new"
    line: number
    contentId: string
    contextDigest: string
  }>

  export type ReviewState = Readonly<{
    // existing fields
    lineSelection: ReviewLineSelection | null
  }>
  ```

  Initialize `lineSelection` to `null`. Keep `ReviewSelection` as the file/hunk navigation cursor so existing file and hunk navigation remains stable.

- [ ] Extract or expose the existing `sideLinesForHunk()` logic in `src/review/core/anchors.ts` as a shared core helper. Add a constructor with this contract:

  ```ts
  export function createLineSelection(
    file: ReviewFile,
    input: { hunkIndex: number; side: "old" | "new"; line: number },
  ): ReviewLineSelection
  ```

  It must locate the requested source line in the requested hunk, call the canonical range-anchor digest path for `startLine === endLine`, and copy the resulting `contentId` and `contextDigest`. It must reject invalid side/line/hunk, binary files, oversized files, and a line absent from the selected side.

- [ ] Add pure actions/intents for setting and moving the semantic line:

  ```ts
  | { type: "selection/set-line"; selection: ReviewLineSelection }
  | { type: "selection/move-line"; direction: "next" | "previous" }
  ```

  `planReviewIntent()` must validate file identity, hunk bounds, side, line membership, current content identity, and digest shape before returning an action. `moveReviewLineSelection(state, direction)` must stay within the current hunk and side, return a no-op at the boundary, and create the next selection through `createLineSelection()` rather than incrementing a terminal row number.

- [ ] Update reducer invariants. File selection, hunk movement, feedback navigation, and document reconciliation must clear or replace `lineSelection` when the semantic target is no longer the active file/hunk. `selection/set-line` must update `selection.fileKey` and `selection.hunkIndex` consistently, increment revision once, and preserve `reveal` unless a hunk/file reveal is requested. Identical line actions and boundary moves must return the same state object without a revision bump.

- [ ] Reconcile the persisted line selection with the new document. Preserve it only when the mapped file exists, its `contentId` matches, its owner hunk exists, and the source line remains valid on the same side. Clear it for a changed file, deleted/ambiguous file, missing line, or invalid digest. Do not turn a cleared line selection into a hunk-wide selection.

- [ ] Add optional-on-read persistence compatibility for the new field without changing the database version. The Zod field must accept a missing `lineSelection` and produce `null`; it must strictly validate present values. Every fresh persisted record in `saveDraftDebounced()`, `flush()`, `persistedFromReviewState()`, and Finish marker construction must write `lineSelection`.

  ```ts
  const lineSelectionSchema = z.object({
    fileKey: z.string().min(1),
    hunkIndex: z.number().int().min(0),
    side: z.enum(["old", "new"]),
    line: z.number().int().min(1),
    contentId: z.string().min(1),
    contextDigest: z.string().min(1),
  }).strict()
  ```

- [ ] Separate interactive draft shape validation from save validation in `src/review/core/intents.ts`. A suggestion draft may temporarily contain an absent or whitespace-only replacement so the UI can display an invalid field; `feedback/create`, `feedback/edit`, and `feedback/reanchor` must still require non-empty replacement text. Keep target checks mandatory for every suggestion draft. Add a shared `validateSuggestionTarget()` and a `requireSuggestionReplacement()` path so no reducer action can create a persisted invalid suggestion.
- [ ] Make `draftSchema` accept an absent or whitespace-only suggestion replacement while the draft is open; keep `feedbackSchema` strict. This allows the invalid draft to survive debounce, close, and restart without quarantining the whole review, while `feedback/create`, artifact construction, and Finish remain strict.


- [ ] Extend `validateFinishReview()` and `buildReviewArtifact()` to validate every in-memory suggestion's replacement, anchor side/kind, target capability, and content identity before Finish. Return a stable reason such as `suggestion-invalid` and add a matching `FinishDialog` message. This protects Finish even if state was assembled outside the normal composer path.
- [ ] Make `buildReviewArtifact()` reject every non-aggregate projection for this release instead of serializing a Since Last or Commit variant. Keep the union types only for isolated future-loader tests; no active Finish path may produce those artifact projections.

**Acceptance:** Core can represent, move, persist, restore, and reconcile an exact semantic line; range anchors are derived from source addresses and canonical digests; empty suggestion drafts are visibly invalid but cannot be saved or finished; no terminal geometry enters state or artifacts.

**Focused verification:**

```bash
bun test tests/review/core/line-selection.test.ts tests/review/core/navigation.test.ts tests/review/core/reducer.test.ts tests/review/core/anchors.test.ts tests/review/core/reconcile.test.ts tests/review/core/artifact.test.ts tests/review/storage/schemas.test.ts
```

---

## Task 3: Wire semantic selection, exact ranges, and composer focus into React

**Files:**

- Modify `src/ui/review-workspace/ReviewWorkspaceApp.tsx`.
- Modify `src/ui/review-workspace/hunk-diff-row-model.ts`.
- Modify `src/ui/review-workspace/components/ReviewDiffPane.tsx`, `ReviewDiffSection.tsx`, and `ReviewDiffRow.tsx`.
- Modify `src/ui/review-workspace/feedback-composer.ts` only if it remains temporarily needed by tests; the final active path must not import it.
- Extend `tests/ui/review-workspace/react-review-workspace.integration.test.tsx`, `tests/ui/review-workspace/react-diff-pane.integration.test.tsx`, `tests/ui/review-workspace/review-diff-row.test.tsx`, `tests/ui/review-workspace/feedback.integration.test.ts`, `tests/ui/review-workspace/feedback-composer.test.ts`, `tests/ui/review-workspace/finish.integration.test.ts`, and `tests/ui/review-workspace/real-surface.integration.test.ts`.

**Dependencies:** Task 2's `ReviewLineSelection`, `createLineSelection()`, intents, and draft-validation split.

- [ ] Add an explicit renderer-neutral row address to the UI row model. Use this contract for mouse and keyboard selection:

  ```ts
  export type HunkDiffAddress = Readonly<{
    fileKey: string
    hunkIndex: number
    side: "old" | "new"
    line: number
  }>
  ```

  Add an address extractor that returns both valid side addresses for split rows and the available address for stack rows. Collapsed gaps, hunk headers, feedback rows, binary explanations, and empty cells must return no source address.

- [ ] Change `ReviewDiffPane`/`ReviewDiffSection` callbacks from raw rows to `HunkDiffAddress`. In split layout, determine whether the click landed in the left or right cell before dispatching; in stack layout, prefer the new-side address when both sides exist. The callback must call `planReviewIntent(state, { type: "selection/set-line", selection: createLineSelection(...) })` and then set the range-start state from that semantic address.

- [ ] Make selection paint observable. `ReviewDiffSection` must compare each row's source address to `state.lineSelection`, and `ReviewDiffRow` must consume `selected` to alter cell background/foreground. Keep a separate selected treatment for the active hunk header and feedback item. Add a renderer test that asserts the selected row's generated `StyledText` contains the selected background, proving the prop affects paint rather than only being passed.

- [ ] Replace the current hunk-wide `hunkRangeForSelection()` path. `v` must begin at the current `lineSelection`; the second `v` may finish only when file, side, and owner hunk match. Build the range with `createRangeAnchor(file, { side, startLine, endLine })`. If a second selection changes file or side, discard the pending range and start a new semantic range; never silently widen to the full hunk.

- [ ] Define `c` behavior explicitly in the active stream: a pending semantic range creates a range comment; an active `lineSelection` creates a one-line range comment; with only the file/hunk navigation cursor it creates a file anchor. The composer header and feedback row must render the path plus `old:N`, `new:N`, or `new:N-M` anchor label.

- [ ] Make `j`, `k`, Up, and Down move the semantic line while Diff is focused. If no line is selected, initialize the first valid new-side line, or the first valid old-side line for deletion-only hunks, before applying movement. Keep `]`/`[` hunk navigation and `.`/`,` file navigation unchanged; navigation that changes hunk/file clears the line cursor until a row is selected.

- [ ] Remove every suggestion replacement fallback. Selecting Suggestion must dispatch `feedback/update-draft` with `kind: "suggestion"` and no fabricated replacement. The replacement editor starts with the actual persisted value or an empty string. Show an explicit invalid message for empty/whitespace replacement, disable the save action while invalid, and leave Finish unavailable while a draft is open or invalid.

- [ ] Include the replacement editor in the panel focus cycle. Track composer focus as `body | replacement | controls`; `Tab` moves through the visible controls, body, and replacement, and `Escape` cancels the draft before it can close Branch Review. Route replacement changes through `planReviewIntent()` so the empty interactive draft is represented intentionally and save still enforces `requireSuggestionReplacement()`.

- [ ] Rework re-anchor to use explicit semantic selection. For a stale/orphaned range feedback item, require a pending range or current line selection and create the new anchor from that address. For file feedback, allow an explicit file anchor or selected line/range. Remove all calls that derive an anchor only from `selection.hunkIndex`; if there is no semantic target, leave the item unresolved and show an actionable message. Add tests for re-anchoring to another line in the same hunk and to another hunk.

- [ ] Keep stale/orphaned feedback visible until the user chooses re-anchor or delete. Preserve the existing two-step delete interaction and add a visible resolution/anchor label in both the feedback row and orphaned-feedback overlay. Canceling re-anchor must leave the original resolution and anchor unchanged.

**Acceptance:** Real row clicks and keyboard movement create exact line/range comments, old/new side crossings are rejected, selected rows visibly paint, suggestions never contain a sentinel replacement, and composer focus is reachable with `Tab`.

**Focused verification:**

```bash
bun test tests/ui/review-workspace/react-review-workspace.integration.test.tsx tests/ui/review-workspace/react-diff-pane.integration.test.tsx tests/ui/review-workspace/review-diff-row.test.tsx tests/ui/review-workspace/feedback.integration.test.ts tests/ui/review-workspace/feedback-composer.test.ts tests/ui/review-workspace/finish.integration.test.ts tests/ui/review-workspace/real-surface.integration.test.ts
```

---

## Task 4: Harden refresh, persistence, Finish ordering, and failure recovery

**Files:**

- Modify `src/review/core/reconcile.ts`, `src/review/core/artifact.ts`, `src/review/storage/review-artifact-store.ts`, `src/review/storage/review-state-store.ts`, and `src/ui/review-workspace/controller.ts`.
- Modify `src/ui/review-workspace/finish-dialog.ts` for the final validation/error contract.
- Extend `tests/review/core/reconcile.test.ts`, `tests/review/core/artifact.test.ts`, `tests/review/storage/review-artifact-store.integration.test.ts`, `tests/review/storage/review-state-store.integration.test.ts`, `tests/ui/review-workspace/finish-dialog.test.ts`, `tests/ui/review-workspace/finish.integration.test.ts`, `tests/ui/review-workspace/refresh.integration.test.ts`, `tests/ui/review-workspace/lifecycle.integration.test.ts`, and `tests/acceptance/branch-review-artifact.integration.test.ts`.

**Dependencies:** Tasks 1–3. This task verifies that the new semantic state and active projection policy remain correct across generation changes and process boundaries.

- [ ] Preserve the prior complete document on failed refresh. Add a regression that makes `loadDocumentImpl()` reject after a valid open, calls `refreshGeneration()`, and asserts the old document, feedback, line selection, and Viewed records remain published while the error includes the actionable load failure. Add the qualified-response case for an old request completing after a newer request.

- [ ] Reconcile semantic selection and feedback atomically once per new generation. Assert unchanged context remains active, unique context relocation updates the range, changed/ambiguous context becomes stale, deleted/ambiguous files become orphaned, and neither stale nor orphaned feedback receives a generated hunk-wide replacement. Keep coverage invalidation limited to files whose path/content identity changed.

- [ ] Change `finishReviewTransaction()` ordering to match the approved contract: validate before entering the transaction; create or digest-verify the immutable artifact first; write `submissionInProgress` plus current pending state only after artifact success; finalize `lastSubmission`, clear feedback/draft, and clear the marker only after both writes succeed. Preserve retry idempotence by digest-verifying an existing artifact referenced by a marker.

  ```ts
  const artifact = buildReviewArtifact(state, input) // throws before writes
  await ensureArtifactExistsOrMatches(artifact)       // immutable write first
  await stateStore.saveSemanticChange(writeMarker(artifact))
  await stateStore.saveSemanticChange(finalizeSubmission(artifact))
  ```

  If artifact creation or either state write fails, leave in-memory feedback/draft intact and return an actionable error. Add failure-injection tests for artifact write, marker write, finalization write, and retry after a recoverable marker.

- [ ] Persist only semantic selection and supported gap identities. Ensure `persistedFromReviewState()` writes `lineSelection` but never writes terminal row plans, scroll offsets, renderer objects, or unsupported projection metadata. Draft debounce, composer close, orderly destroy, and restart must restore the exact draft and line selection.
- [ ] Preserve the existing corrupt-state quarantine contract. A malformed or schema-invalid state file must move to the existing quarantine path, publish a storage warning, and still open a fresh aggregate document. Add a restart assertion that a quarantined file does not restore stale feedback or draft data.

- [ ] Assert deterministic Markdown is derived from the stored artifact after successful Finish, not from a pre-write in-memory projection. A failed artifact/state write must leave the previous Markdown/artifact reference unchanged.

- [ ] Strengthen Finish validation tests. Cover open draft, empty/whitespace suggestion replacement, old-side suggestion, binary/oversized target, stale/orphaned feedback, blocking decision invariants, aggregate-only projection, and successful artifact/Markdown derivation. Replace weak assertions such as `reason || ok === true || ok === false` with exact `ok` and `reason` expectations.

- [ ] Update acceptance tests that currently instantiate `ReviewWorkspace`, call `loadSinceLastReviewProjection()`, or use imperative composer APIs. The active acceptance must open through `createApp()`/`AppScreenController`, drive keys through the actual OpenTUI input harness, inspect `ReviewWorkspaceApp` output, and verify aggregate-only state and local artifact persistence.

**Acceptance:** Refresh failures do not erase valid UI state; generation changes produce active/stale/orphaned outcomes; Finish cannot clear pending work before durable artifact/state success; restart restores semantic state and draft; failed writes retain retryable pending feedback.

**Focused verification:**

```bash
bun test tests/review/core/reconcile.test.ts tests/review/core/artifact.test.ts tests/review/storage/review-artifact-store.integration.test.ts tests/review/storage/review-state-store.integration.test.ts tests/ui/review-workspace/finish-dialog.test.ts tests/ui/review-workspace/finish.integration.test.ts tests/ui/review-workspace/refresh.integration.test.ts tests/ui/review-workspace/lifecycle.integration.test.ts tests/acceptance/branch-review-artifact.integration.test.ts
```

---

## Task 5: Enforce one renderer path and the Pierre adapter boundary

**Files:**

- Add `src/review/git/pierre-diff-adapter.ts`.
- Modify `src/ui/review-workspace/hunk-review-model.ts`, `src/ui/review-workspace/hunk-diff-row-model.ts`, `src/ui/review-workspace/components/ReviewDiffRow.tsx`, `src/ui/review-workspace/react-review-host.tsx`, `src/app/screen-controller.ts`, and `src/app/create-app.ts`.
- Retire the duplicate imperative review implementation and its private behavior modules after migrating their tests: `src/ui/review-workspace/review-workspace.ts`, `src/ui/review-workspace/stream-pane.ts`, `src/ui/review-workspace/feedback-composer.ts`, `src/ui/review-workspace/feedback-pane.ts`, `src/ui/review-workspace/files-pane.ts`, `src/ui/review-workspace/row-planner.ts`, `src/ui/review-workspace/review-highlight-text.ts`, and `src/ui/review-workspace/layout.ts` when reference analysis confirms they have no active consumers.
- Update `docs/superpowers/specs/2026-08-27-branch-review-workspace-design.md` to describe the retained React renderer and adapter boundary instead of the stale no-React prohibition.
- Add/modify `tests/ui/review-workspace/hunk-review-model.test.ts`, `tests/ui/review-workspace/hunk-diff-rows.test.ts`, `tests/ui/review-workspace/review-diff-row.test.tsx`, `tests/ui/review-workspace/react-review-host.integration.test.tsx`, `tests/app/screen-controller.test.ts`, `tests/acceptance/branch-review-artifact.integration.test.ts`, `tests/ui/review-workspace/finish.integration.test.ts`, `tests/ui/review-workspace/navigation.integration.test.ts`, `tests/ui/review-workspace/stream-pane.integration.test.ts`, `tests/ui/review-workspace/context-expansion.integration.test.ts`, and `tests/review/conformance/row-planner.conformance.test.ts`.

**Dependencies:** Tasks 1–4 must establish active behavior before deleting compatibility implementations. The adapter can be introduced before legacy deletion, but all imports must be migrated first.

- [ ] Create a normalized Pierre adapter that is the only module importing `parsePatchFiles` and `FileDiffMetadata` for review rendering. Export renderer-owned types containing exactly the fields the active row builder uses:

  ```ts
  export type ReviewDiffMetadata = Readonly<{
    name: string
    prevName?: string
    type: "new" | "deleted" | "change" | "rename-pure" | "rename-changed"
    hunks: readonly ReviewDiffHunk[]
    deletionLines: readonly string[]
    additionLines: readonly string[]
    splitLineCount: number
    unifiedLineCount: number
    isPartial: boolean
    cacheKey: string
  }>
  ```

  ```ts
  export type ReviewDiffHunk = Readonly<{
    hunkSpecs?: string
    deletionStart: number
    deletionCount: number
    additionStart: number
    additionCount: number
    deletionLineIndex: number
    additionLineIndex: number
    collapsedBefore: number
    hunkContent: readonly Readonly<{
      type: "context" | "change"
      lines: number
      deletions: number
      additions: number
    }>[]
  }>
  ```


  `ReviewDiffHunk` must expose only normalized starts/counts, line indexes, optional header text, collapse count, and normalized `hunkContent` groups. Preserve the current malformed-patch fallback and stable identity behavior inside the adapter.

- [ ] Change `HunkReviewFile.metadata` to `ReviewDiffMetadata`; `hunk-review-model.ts` must import only `ReviewFile`/`ReviewHunk` and the adapter function. `hunk-diff-row-model.ts`, `ReviewDiffSection.tsx`, and highlight hooks must consume the normalized type, never Pierre types. Keep `@pierre/diffs` imports in `src/review/git/highlight/` only where they are already behind the Git/highlight boundary.

- [ ] Remove the direct `cleanLastNewline` import from `ReviewDiffRow.tsx`. Use a local renderer utility or an adapter-exported plain string normalizer. Add a test proving trailing newline cleanup still preserves row width and highlighting.

- [ ] Make `ReactReviewHost` a lifecycle adapter rather than a second command/feedback implementation. Remove its `FeedbackComposer`, `FeedbackPane`, direct `planReviewIntent` dispatches, and compatibility key branches. Reduce `ReviewScreenView` to the methods required by the screen shell (`root`, `destroy`, and any measured viewport accessor still proven necessary); update the headless `create-app.ts` view and lifecycle tests accordingly. The actual keyboard/mouse behavior must live in `ReviewWorkspaceApp` and its command executor.

- [ ] Migrate tests that call `ReviewWorkspace.handleKeyPress()`, `getFeedbackComposer()`, `getFeedbackPane()`, `setRangeActive()`, or `dispatchKey()` to the real React/OpenTUI surface. Use `createTestRenderer().mockInput.pressKey/pressKeys`, `createShellHarness().pressKey`, `mockMouse`, rendered ids, controller state, and captured frames. Preserve only tests that defend observable active behavior; delete tests whose sole purpose is an obsolete compatibility alias.

- [ ] Delete the imperative workspace and private modules only after LSP/reference checks show no active imports. Remove associated aliases and comments rather than leaving an unreachable second command path. Keep shared active modules (`controller.ts`, `finish-dialog.ts`, `header.ts`, `review-sidebar.ts`, `hunk-*` row modules, highlights, and `react-review-session.ts`) intact.

- [ ] Update the earlier design document's architecture section to match the approved cutover: React is the active renderer, core remains renderer-free, Git/document adapters own Pierre parsing, storage owns local persistence, and the application shell owns screen lifetime. Keep deferred projection and Hunk feature boundaries explicit.

**Acceptance:** One active React workspace and one active command path remain; UI modules do not expose Pierre parser types; all existing aggregate windowing, syntax highlighting, binary handling, sidebar, and navigation tests run against the active surface.

**Focused verification:**

```bash
bun test tests/ui/review-workspace/hunk-review-model.test.ts tests/ui/review-workspace/hunk-diff-rows.test.ts tests/ui/review-workspace/review-diff-row.test.tsx tests/ui/review-workspace/react-review-host.integration.test.tsx tests/app/screen-controller.test.ts tests/acceptance/branch-review-artifact.integration.test.ts tests/ui/review-workspace/finish.integration.test.ts tests/ui/review-workspace/navigation.integration.test.ts tests/ui/review-workspace/stream-pane.integration.test.ts tests/ui/review-workspace/context-expansion.integration.test.ts tests/review/conformance/row-planner.conformance.test.ts
```

---

## Task 6: Run the end-to-end acceptance scenario and close deferred-surface gaps

**Files:**

- Extend `tests/ui/review-workspace/real-surface.integration.test.ts` and `tests/acceptance/branch-review-workspace.integration.test.ts`.
- Modify `tests/review/core/coverage.test.ts`, `tests/review/git/history-rewrite.integration.test.ts`, and `tests/review/git/projections.integration.test.ts` so direct future-loader coverage is clearly isolated from active-surface acceptance.
- Update `docs/superpowers/specs/2026-08-31-branch-review-merge-readiness-design.md` only if implementation evidence requires a wording correction; do not weaken an acceptance criterion.

**Dependencies:** Tasks 1–5.

- [ ] Build one real-surface scenario around `createShellHarness`/OpenTUI input with this exact sequence: open with `b`; focus Diff and Files using `0`, `1`, and `Tab`; select a changed line with keyboard and mouse; create a line comment; create a multiline blocking new-side suggestion with actual replacement text; edit, delete, and re-anchor feedback; add a commit changing one reviewed file; refresh/reopen; observe stale resolution; verify Finish is blocked until re-anchor/delete; Finish Request Changes; inspect JSON and deterministic Markdown; restart and verify state; inspect the command log for repository mutation commands.

- [ ] Add an active-surface guard for deferred behavior. Help/footer and command resolution must not expose Since Last Review, individual commit projection, trailing-final-hunk expansion, page/half-page keys, horizontal scroll, current-line display mode, theme selector, copy decorations, agent annotations, extension panes, pager, editor, or Git mutation actions. Direct tests for future projection loaders may remain, but they must not be used as proof of active projection behavior.

- [ ] Reframe `tests/review/core/coverage.test.ts` and `tests/review/git/history-rewrite.integration.test.ts` around the aggregate-only release. Keep pure coverage identity/reconciliation tests; move Since Last ancestor/eligibility assertions to the isolated future-loader suite and assert that active Branch Review never selects that projection.

- [ ] Run the final verification commands once after cleanup:

  ```bash
  bun run typecheck
  bun test
  bun run check
  git diff --check
  ```

  If `bun run check` repeats typecheck/tests by design, record the final `bun run check` result and use the focused suites above for failure localization. Do not add a test that merely checks source text or an implementation detail; every retained test must defend a visible review contract, state invariant, persistence boundary, or no-mutation guarantee.

**Acceptance:** The real TUI scenario passes end-to-end, all merge acceptance criteria in the approved spec are evidenced by tests or the real surface, and deferred features remain unreachable rather than half-exposed.

---

## Final Self-Review Checklist

- [ ] Every approved merge blocker has an owning task: exact anchors, real suggestion replacements, stale/orphaned blocking, persistence/restart, active-only behavior, and no Git mutation.
- [ ] Every in-scope user behavior is covered: dedicated screen lifecycle, aggregate stream, files/filter/navigation, Viewed coverage, feedback CRUD/re-anchor, Finish decisions/artifacts, refresh failure retention.
- [ ] Every deliberate deferral is named and guarded from active help/commands.
- [ ] `ReviewLineSelection` includes file, hunk, side, line, content identity, and context digest; no terminal geometry is persisted.
- [ ] The active handler, footer, help, and mouse paths use one command vocabulary.
- [ ] No task relies on a vague future step, sentinel data, silent fallback, metadata-only projection, or compatibility alias.
- [ ] Test commands are scoped during implementation and the full verification commands run only after cleanup.
