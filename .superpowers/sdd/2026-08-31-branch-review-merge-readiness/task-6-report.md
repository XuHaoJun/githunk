# Task 6 — End-to-end acceptance and deferred-surface guards

## Changes

- Added a real `createShellHarness`/OpenTUI scenario in `tests/acceptance/branch-review-workspace.integration.test.ts`.
- Added real-surface footer/help-generator deferred-feature guards in `tests/ui/review-workspace/real-surface.integration.test.ts` and command-resolution/help/hints guards in `tests/ui/review-workspace/command-catalog.test.ts`.
- Reframed core Viewed coverage as active aggregate coverage and removed the Since Last eligibility assertion from `tests/review/core/coverage.test.ts`.
- Isolated direct Since Last/history-rewrite and commit projection loader assertions under explicit future-loader suites in `tests/review/git/history-rewrite.integration.test.ts` and `tests/review/git/projections.integration.test.ts`.

## Real-surface scenario evidence

The focused scenario passed and exercises the requested sequence:

1. Opens Branch Review with `b` against a real temporary repository.
2. Drives `0`, `1`, `Tab`, and `0`; assertions inspect the actual Diff scrollbox, Files scrollbox, and filter input `focused` nodes after each transition, plus the active stream footer.
3. Selects a changed line through keyboard navigation and a different changed line with OpenTUI mouse row clicks.
4. Creates a line comment, edits it through the composer, creates and deletes a second feedback item through the two-step delete action.
5. Selects a two-line new-side range and creates a blocking suggestion with real replacement text (`export const valid = false`); no sentinel replacement is used.
6. Creates a real commit changing `src/payment.ts`, refreshes the generation, and closes/reopens the review.
7. Observes the payment feedback become stale while the validation suggestion remains active.
8. Confirms Finish renders the stale/orphaned blocking message, then re-anchors the stale feedback to a newly selected current line.
9. Finishes as Request Changes, reads the persisted JSON artifact, verifies aggregate projection and replacement text, and verifies deterministic Markdown by rendering it twice and comparing exact output.
10. Restarts the shell harness against the same repository and verifies the aggregate projection, artifact id, and cleared pending feedback state survive.
11. Inspects app command-log entries after startup and validates every non-empty logged command against an explicit read-only Git verb allow-list; no mutating Git command is accepted.

Focused result: `44 pass`, `0 fail`, `736 expect() calls` across the six affected suites after the follow-up guards.

## Deferred-surface guards

The active command catalog and generated help/hints reject all named deferred surfaces: Since Last Review, individual commit projection, trailing-final-hunk expansion, page/half-page navigation, horizontal scroll, current-line mode, theme selection, copy decorations, agent annotations, extension panes, pager, editor, and Git mutation actions. The real rendered Branch Review footer is also checked for those labels. Future projection loaders remain covered only by suites explicitly named `future projection loader` / `future projection loaders — isolated direct tests`; those tests are not active-surface proof.
## Follow-up guard corrections

- The OpenTUI `b` path now waits for the observable `branch-review` screen transition and no longer calls `openBranchReview` directly from the acceptance test.
- The command-catalog guard enumerates deferred command IDs and concrete deferred key names (`pagedown`, `pageup`, `ctrl+d`, `ctrl+u`, and related projection/navigation/copy/editor keys) across every active focus.
- The acceptance scenario now proves semantic `j` movement by changed line number and stable content identity, proves the deleted feedback id is absent while the payment note remains, and checks restart feedback/draft emptiness.
- The real-surface footer guard includes a standalone word-boundary `page` check and both hyphenated and spaced copy-selection/decorations wording.

## Final commands

The required commands were run after focused-test cleanup. An earlier diagnostic-only `bun run typecheck` before the final test-shape cleanup emitted 78 diagnostics in 7 files, including one Task 6 acceptance typing diagnostic and one command-catalog state-shape diagnostic; after those were corrected, the final invocation below emitted 76 diagnostics in 5 files. Both outputs are recorded rather than hidden.

- `bun run typecheck` — failed with 76 diagnostics in 5 files. The remaining diagnostics are pre-existing repository configuration/source issues: missing Bun test globals in `tests/ui/review-workspace/finish-dialog.test.ts` (71 diagnostics), two existing `refresh.integration.test.ts` errors, `src/review/core/anchors.ts` `ReviewAnchor.contextDigest`, `src/review/storage/review-state-store.ts` projection typing, and one existing `header.test.ts` `lineSelection` shape error. The Task 6 acceptance test and command-catalog test no longer add diagnostics.
- `bun test` — failed with `4152 pass`, `220 fail`, `4400 tests` in the full repository. Failures are outside this Task 6 surface, principally missing `/home/noah/githunk/learn-projects/hunk` dependencies/packages (`commander`, `tuistory`, `@playwright/test`, `@axe-core/playwright`), hunk CLI/session daemon failures, five `/tmp/repo` action-label tests, and the existing large-branch layout expectation.
- `bun run check` — failed on the same typecheck issues (`anchors.ts`, `review-state-store.ts`, missing test globals in `finish-dialog.test.ts`, plus the existing refresh diagnostics).
- `git diff --check` — passed with no output.

No documentation wording correction was supported by implementation evidence, so the approved design specification was left unchanged.

## Concerns

The repository-wide typecheck and test commands remain red for the known diagnostics above; affected Task 6 focused suites pass. The full test command also traverses the checked-in `learn-projects/hunk` project, whose optional dependencies are unavailable in this checkout.
