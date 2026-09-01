# Branch Review Merge Readiness

## 1. Decision summary

This specification narrows Branch Review to the product that the branch is actually intended to deliver:

> A lazygit-style, local, read-only workspace with a GitHub-like pending review flow for committed `base...HEAD` changes.

The branch does **not** need to clone every Hunk viewer feature before merging. The merge gate is correctness of the review loop, not viewer feature parity.

### Merge blockers

1. A comment or suggestion must remain attached to the exact intended file and line/range.
2. Suggestions must never persist synthetic replacement text.
3. Stale and orphaned feedback must be visible and must block Finish until re-anchored or deleted.
4. Pending feedback, review decisions, and the finished artifact must survive the documented persistence lifecycle.
5. The active runtime must expose only behavior that is actually implemented. Unsupported projections and duplicate UI paths must not remain silently callable.
6. The Branch Review surface must remain read-only with respect to Git and the working tree.

### Deliberately deferred

These are useful but do not block this merge:

- Since Last Review projection.
- Individual commit projection.
- Trailing context expansion after the final hunk.
- Hunk's page/half-page scrolling, horizontal scrolling, current-line cursor, theme selector, copy-selection decorations, agent annotations, extension panes, pager, and editor integration.

The panel convention is intentional and is not a defect:

- `0`: focus Diff panel.
- `1`: focus Files panel.
- `Tab`: cycle panels.

Layout mode switching is a separate concern and is not required to use `0/1/2`.

## 2. Problem

The current branch contains two overlapping interpretations of Branch Review:

1. A complete local review lifecycle described by the approved design document.
2. A read-only aggregate diff viewer, which is the immediately useful user experience.

The implementation currently exposes pieces of both. This creates a dangerous middle state: the normal aggregate diff path is useful, but feedback and projection paths can appear complete while still containing incorrect behavior.

A reviewer must be able to trust this statement:

> If Branch Review displays a saved comment or suggestion, it refers to the code the reviewer selected, or the UI explicitly says that the reference is stale/orphaned and prevents submission.

## 3. Product scope for this merge

### 3.1 In scope

- Enter a dedicated workspace with `b` and leave with `Escape`.
- Hide the repository dashboard while Branch Review is active.
- Open the committed aggregate `base...HEAD` changeset.
- Browse multiple files in one stream with a Files panel.
- Navigate files and hunks semantically.
- Filter files by path and review state.
- Mark files Viewed and invalidate coverage when file content changes.
- Create, edit, delete, and re-anchor local comments and suggestions.
- Finish a pending review as Comment, Approve, or Request Changes.
- Persist pending feedback, draft content, Viewed state, and last submission.
- Reconcile feedback and coverage after a new generation.
- Preserve the prior complete document when refresh fails.
- Produce an immutable JSON artifact and deterministic Markdown representation.
- Execute no repository mutation as a consequence of Branch Review.

### 3.2 Not in scope for this merge

- Switching the rendered document to Since Last Review.
- Switching the rendered document to an individual commit.
- Applying suggestions to files.
- GitHub authentication, remote comments, remote submission, checks, or provider metadata.
- Editor launch, staging, committing, rebasing, or other Git mutation.
- Agent annotation ingestion and extension-provided panes.
- Full Hunk viewer parity unrelated to review correctness.

Unsupported behavior must be absent from the active command surface rather than represented by a metadata-only state.

## 4. User experience contract

### 4.1 Default review target

Opening Branch Review always renders the aggregate committed changeset:

```text
base...HEAD
```

The header identifies the current branch, base, commit count, file count, and aggregate review progress.

The active renderer must derive its files from the aggregate document. It must not label the view as another projection unless it is rendering that projection's actual file set.

### 4.2 Panel focus

The active runtime uses the following panel semantics:

| Key | Behavior |
| --- | --- |
| `0` | Focus Diff panel |
| `1` | Focus Files panel |
| `Tab` | Cycle Diff → Files → Filter/Composer → Diff |
| `Escape` | Close the active composer/dialog; otherwise leave Branch Review |

The command catalog, help text, footer hints, and active keyboard handler must describe the same behavior. There must be one active command resolution path.

Layout mode is independent from panel focus. The implementation may retain an explicit layout command, but layout switching must not reclaim `0`, `1`, or `Tab`.

### 4.3 Diff browsing

The aggregate stream must support:

- file navigation;
- hunk navigation;
- row scrolling;
- sidebar selection;
- mouse row selection;
- binary, deleted, renamed, and oversized file explanations;
- bounded viewport windowing.

The selected file and hunk must have a visible selection treatment. Passing a `selected` prop that does not affect row paint is not sufficient.

### 4.4 Semantic line selection

Terminal geometry must never be persisted as a review anchor. A line selection is represented semantically by file, side, line range, owner hunk, content identity, and context digest.

Required behavior:

1. Clicking a diff row selects its semantic source address.
2. Keyboard navigation can move the current semantic line within the active hunk.
3. `v` starts and ends a range on the same file and side.
4. A range may cover one or multiple source lines.
5. A range cannot silently cross files or switch old/new sides.
6. `c` on a line selection creates a line comment.
7. `c` with an explicit file selection creates a file-level comment.
8. The rendered feedback text identifies the selected file and line/range.

The existing hunk-level selection remains useful for navigation, but it must not be substituted for a line selection when creating or re-anchoring a line feedback item.

### 4.5 Feedback types

#### Comment

A comment contains a body, severity, and either a file anchor or a precise line/range anchor.

#### Suggestion

A suggestion contains a non-empty replacement for a valid new-side range. It must satisfy all of the following before save or Finish:

- anchor kind is `range`;
- anchor side is `new`;
- replacement is present and non-empty after trimming;
- target file is not binary or oversized;
- anchor content identity matches the current generation.

The implementation must not use sentinel replacement text to satisfy validation. If replacement text is missing, the composer remains invalid and Finish is blocked.

### 4.6 Feedback reconciliation

Each feedback item has one visible resolution:

- `active`: the anchor still identifies the intended code;
- `stale`: the file exists, but the original context no longer matches uniquely;
- `orphaned`: the file or anchor target no longer exists.

On a new generation:

- unchanged content keeps the item active;
- a unique context match relocates the item and keeps it active;
- ambiguous or changed context makes it stale;
- deleted or unmatched files make it orphaned.

A stale or orphaned item must never be silently converted to a new hunk-wide anchor.

The UI must provide an explicit path to:

- inspect the item;
- re-anchor it to a new semantic line/range;
- delete it;
- cancel the re-anchor operation.

### 4.7 Finish flow

Finish is a local pending-review operation, not a remote GitHub submission.

Supported decisions:

- Comment;
- Approve;
- Request Changes.

Validation rules:

- an open composer must be saved or cancelled;
- stale or orphaned feedback blocks Finish;
- Approve rejects blocking feedback;
- Request Changes requires at least one blocking item;
- every suggestion has valid replacement text;
- the review uses the aggregate projection only in this merge.

The transaction order is:

1. validate the complete in-memory review;
2. write one immutable JSON artifact;
3. write the mutable last-submission/state record;
4. only after both writes succeed, clear or finalize pending state;
5. derive deterministic Markdown from the stored artifact.

A failed artifact or state write retains the in-memory feedback and reports an actionable error.

## 5. Projection policy for this merge

The branch currently contains projection types and Git loaders, but the active UI does not render their returned file sets. This is unsafe if projection metadata can be selected or restored.

For this merge:

- Aggregate is the only selectable and renderable projection.
- The active command catalog contains no Since Last Review or Commit projection command.
- The active UI contains no projection selector or projection-specific Finish transition.
- Persisted non-aggregate projection state is normalized to Aggregate when opening this version, or rejected as unsupported before entering core state.
- `loadProjection()` must not claim success after only changing metadata.
- Projection loaders remain separate future work only if they are not reachable from the active runtime.

A later projection implementation must atomically load a projection document, validate its generation and review identity, reconcile its coverage rules, and render its files. A metadata-only projection is not an acceptable intermediate state.

## 6. Generation refresh and persistence

### 6.1 Refresh

Branch Review may refresh when the branch ref moves. Refresh must:

- load a new aggregate document off-screen;
- qualify the response by request, review identity, and generation;
- reconcile the current state once;
- preserve the prior complete document on load failure;
- publish an actionable error without discarding valid in-memory state.

Manual refresh is not required for this merge if the active product relies on the existing ref watcher. The `r` key remains mark Viewed under the selected panel/key convention.

### 6.2 Persistence

Persisted state includes:

- semantic selection;
- filter;
- Viewed records;
- pending feedback;
- current draft;
- expanded gap identities that are actually supported;
- last submission;
- recoverable submission-in-progress marker.

Persisted state excludes terminal row plans, renderer handles, and raw viewport offsets.

Draft writes use the existing serialized store and bounded trailing debounce. Composer close and orderly application exit flush pending writes.

Corrupt state is quarantined and reported while allowing a fresh aggregate review to open.

## 7. Architecture and cutover

### 7.1 One active renderer path

The current branch mounts `ReviewWorkspaceApp` through `ReactReviewHost`. Keep that path as the implementation path for this merge; do not re-platform it back to the imperative renderer.

Remove or retire the duplicate imperative workspace path and its compatibility behavior. There must not be two independent keyboard, feedback, or finish implementations in the source tree that can drift.

The active runtime owns:

- panel focus;
- command resolution;
- semantic intent dispatch;
- rendering;
- dialog lifecycle.

Core owns:

- identity;
- document validation;
- anchors;
- reconciliation;
- finish invariants;
- artifact construction.

### 7.2 Adapter boundary

`@pierre/diffs` types and parsing remain behind the Git/document adapter. UI modules consume normalized core or renderer-owned view models, not Pierre parser types.

If React remains the chosen renderer, the earlier no-React design statement must be updated rather than left contradictory to the implementation. The merge decision is about one coherent architecture, not about preserving a stale prohibition.

### 7.3 No mutation boundary

Branch Review must not call staging, discard, commit, reset, checkout, rebase, push, pull, or other repository mutation commands. Notes, suggestions, Viewed state, and Finish only change local review storage.

## 8. Required implementation changes

### 8.1 Core selection and anchor changes

- Add semantic current-line state or an equivalent renderer-neutral line-selection model.
- Add intents for line movement and range begin/end.
- Make anchor creation consume semantic line/range addresses.
- Keep terminal row indexes and scroll offsets out of persisted anchors.
- Preserve explicit file-level feedback as a separate anchor kind.

### 8.2 Feedback composer changes

- Remove every synthetic replacement fallback.
- Require real replacement text for suggestions.
- Make the invalid replacement state visible.
- Do not allow save or Finish while the suggestion is invalid.
- Ensure composer focus can be reached through the panel focus cycle.

### 8.3 Re-anchor changes

- Re-anchor from an explicit semantic line/range selection.
- Do not derive a replacement anchor from only `selection.hunkIndex`.
- Keep stale/orphaned resolution visible until the user chooses re-anchor or delete.
- Add tests for re-anchoring to a different line within the same hunk and to a different hunk.

### 8.4 Active command changes

- Make `0`, `1`, and `Tab` mean panel focus in the active command catalog and help surface.
- Remove the active React handler's conflicting layout interpretation.
- Use the same command IDs for keyboard, mouse, footer hints, and help.
- Remove unsupported projection commands from the active catalog.

### 8.5 Projection cutback

- Make Aggregate the only active projection.
- Prevent persisted non-aggregate metadata from producing a mislabeled aggregate render.
- Remove or isolate projection code that is not reachable from this release.
- Add a regression test that the active workspace never labels aggregate rows as Since Last or Commit.

### 8.6 Rendering and cutover cleanup

- Apply the selected state to row paint.
- Keep one workspace implementation path.
- Move Pierre parsing/metadata derivation behind the adapter boundary.
- Keep the existing aggregate windowing and highlight worker behavior.

## 9. Verification strategy

### 9.1 Core tests

Pure tests must cover:

- one-line new-side comment anchor;
- one-line old-side comment anchor;
- multiline range anchor;
- invalid cross-side and cross-file range rejection;
- file-level comment anchor;
- suggestion rejection for missing or whitespace-only replacement;
- suggestion rejection for old-side, binary, and oversized targets;
- no sentinel replacement values;
- unchanged anchor remains active after refresh;
- changed context becomes stale;
- deleted file becomes orphaned;
- stale/orphaned feedback blocks Finish;
- Approve and Request Changes invariants;
- reducer no-op and revision behavior.

### 9.2 Integration tests

Temporary repositories must cover:

- aggregate `base...HEAD` loading;
- new commit invalidating only changed Viewed files;
- rename and deletion reconciliation;
- failed refresh retaining the prior document;
- no Branch Review Git mutation commands;
- persistence and restart restoration;
- corrupt state quarantine;
- aggregate-only projection policy.

### 9.3 Real TUI acceptance

The real OpenTUI surface must exercise this scenario:

1. Open Branch Review with `b`.
2. Focus Diff and Files using `0`, `1`, and `Tab`.
3. Navigate to a changed line with keyboard and mouse.
4. Create a line comment and a multiline blocking suggestion.
5. Edit one item, delete one item, and re-anchor one stale item.
6. Add a new commit changing one reviewed file.
7. Reopen or refresh and observe the item become stale rather than silently moving.
8. Verify Finish is blocked until the stale item is re-anchored or deleted.
9. Finish Request Changes and inspect JSON/Markdown output.
10. Restart and verify the persisted review state.
11. Inspect the command log and confirm no repository mutation occurred.

Focused tests that call projection loaders directly do not substitute for this active-surface verification.

## 10. Merge acceptance criteria

The branch is merge-ready when all of the following are true:

1. Aggregate `base...HEAD` is the only rendered projection in this release.
2. `0`, `1`, and `Tab` consistently control panel focus.
3. A line comment records the selected semantic line, not a terminal row or whole hunk by accident.
4. A multiline comment records the selected semantic range.
5. Suggestions require real replacement text and never persist a sentinel.
6. New generations reconcile active, stale, and orphaned feedback visibly.
7. Stale and orphaned feedback cannot be silently submitted.
8. Pending feedback survives restart.
9. Finish writes an immutable artifact before clearing pending state.
10. Finish decision invariants are enforced.
11. Failed refresh leaves the last complete document visible.
12. Branch Review performs no repository mutation.
13. One active workspace implementation and one active command path remain.
14. Existing aggregate stream, sidebar, navigation, filtering, binary handling, and windowing behavior remain intact.
15. The real TUI acceptance scenario passes.

## 11. Deferred work after this merge

The following may be implemented in separate changes without reopening this merge gate:

- Since Last Review projection and its ancestor/coverage rules;
- individual commit projection;
- trailing context expansion;
- page and half-page navigation;
- horizontal scrolling;
- current-line display and alignment;
- theme selection;
- copy selection and copy decorations;
- agent annotations and annotated navigation;
- extension panes, editor integration, pager, and difftool modes.

Each deferred feature must either remain unreachable or have its own complete state, renderer, persistence, and acceptance contract before being exposed.
