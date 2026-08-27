# Branch Review Workspace — Design

**Status:** Draft for written review  
**Date:** 2026-08-27  
**Branch:** `redesign/branch-review-workspace`  
**Supersedes:** the Branch Review portions of `docs/githunk-prd-v0.1.md` and `docs/superpowers/specs/2026-08-24-githunk-review-shell-ux-design.md`

## 1. Decision

githunk will replace the current Branch Review mode with a dedicated, full-screen Review Workspace. The cutover is intentionally breaking: no compatibility UI, deprecated state, aliases, fallback parser, or v1 review-state migration will remain.

The redesign combines three proven ideas without copying any product wholesale:

- githunk keeps ownership of repository context, review-base inference, Git loading, commit metadata, and repository-local storage.
- hunk supplies the architectural model: a renderer-neutral review document, semantic state, intents, reducers, stable anchors, reconciliation, continuous changeset navigation, and responsive split/stack presentation.
- GitHub Pull Request review supplies the workflow model: explicit coverage, invalidation after new changes, precise pending feedback, incremental re-review, and an immutable finished review.

The first release is provider-neutral and local-first. It will not authenticate with GitHub, read remote pull-request metadata, synchronize remote threads, ingest checks, or submit a GitHub review. Its immutable artifact must be useful to a human, coding agent, or future provider integration without introducing a provider abstraction before one exists.

Branch Review remains completely read-only with respect to the repository. Notes and suggestions modify review state only. They never edit files, stage changes, apply patches, create commits, or invoke repository mutations.

## 2. Problem

The existing implementation has the right aggregate Git query but the wrong product and state boundaries.

`src/git/branch-review.ts` correctly loads `baseRef...HEAD`, numstat, merge-base, and commit count. Base inference and persisted base selection are also useful. The loaded snapshot is then flattened into the ordinary repository `AppModel` and rendered through the same multi-pane shell used for working-tree operations.

This causes four structural failures:

1. **Review identity is generation identity.** `src/review/fingerprint.ts` includes `headOid` in the Branch Review target key. A new commit selects a new target record, so unchanged files cannot reliably preserve their Reviewed state and changed files cannot reliably become `changed-after-review`.
2. **The workflow is a mode, not a review.** The screen remains a repository dashboard with a read-only patch. It has no pending feedback lifecycle, finish operation, incremental re-review, or review artifact.
3. **Review semantics live in application and rendering state.** Branch-specific fields and guards are spread across `AppController`, `AppModel`, bindings, panes, and the large `root-view.ts`. Adding comments, anchors, generation reconciliation, or stream navigation would deepen that coupling.
4. **Coverage is only a file marker.** There is no stable connection among the content reviewed, the generation reviewed, subsequent invalidation, and a submitted review result.

The new design fixes the source: identity, state ownership, information architecture, and lifecycle.

## 3. Goals

The implementation must provide:

1. A dedicated Review Workspace entered from the repository screen with `b`.
2. Aggregate review of the complete branch change set at `base...HEAD`.
3. A continuous, windowed multi-file review stream with a file sidebar.
4. Responsive auto, side-by-side split, and stacked/unified diff presentation.
5. File, hunk, line, annotation, unreviewed-file, and invalidated-file navigation.
6. Explicit Viewed coverage tied to the exact current file content.
7. Correct preservation or invalidation of coverage after new commits, base movement, renames, deletions, and rewritten history.
8. Aggregate, since-last-review, and individual-commit projections without replacing the authoritative review target.
9. Precise line, multiline, and file-level pending notes and replacement suggestions.
10. Active, stale, and orphaned anchor reconciliation across generations.
11. A private pending-review workflow ending in Comment, Approve, or Request Changes.
12. Immutable JSON artifacts and deterministic Markdown export.
13. Restart-safe local persistence with atomic writes and corruption quarantine.
14. A renderer-neutral core that can later serve an agent or provider integration without depending on terminal geometry.
15. Clean deletion of the old Branch Review implementation and its compatibility tests.

## 4. Non-goals

The first release will not implement:

- GitHub authentication or API calls;
- remote pull-request discovery or metadata;
- remote review threads, checks, findings, CODEOWNERS, branch protection, or merge queues;
- applying a suggestion to the working tree;
- launching an editor from Branch Review;
- staging, discarding, committing, rebasing, or otherwise mutating Git;
- shared or networked review sessions;
- a browser renderer;
- migration from `review-state-v1.json`;
- compatibility with the old Branch Review UI, internal types, keys, or persisted target keys;
- a generic provider interface with no first consumer.

Working Tree Review and the ordinary repository workspace remain separate products. This design does not rewrite their mutation flows.

## 5. Product model

### 5.1 Screen transition

The application shell owns two top-level screens:

```text
Repository Workspace
    -- b / OpenBranchReview -->
Review Workspace
    -- Escape / CloseReview -->
Repository Workspace
```

Opening a review performs these steps:

1. Resolve the current canonical head ref. Detached HEAD is allowed as a snapshot review.
2. Load the remembered base for that head ref, or infer/prompt using the existing base-selection rules.
3. Build a complete `ReviewDocument` for `base...HEAD`.
4. Load v2 state under the stable `ReviewIdentity`.
5. Reconcile stored state against the loaded `ReviewGeneration`.
6. Publish one complete workspace state. Partial loads are never rendered.

Closing the workspace disposes review-specific loaders and renderer state, then restores the prior repository pane and selection. Reopening restores semantic review selection and pending state. Pixel/row scroll offsets are renderer-local and are not persisted.

### 5.2 Workspace information architecture

The default layout is:

```text
feature/payment → origin/main
12 commits · 18 files · +842 −193
Reviewed 11/18 · 2 changed · 4 pending               [Aggregate]

┌─ Files / filter ─────────┬─ Continuous Review Stream ──────────────┐
│ ! payment.ts             │ src/payment.ts                           │
│ ◆ validation.ts          │ @@ ...                                  │
│ ● types.ts               │ - old                                   │
│ ○ tests.ts               │ + new                                   │
│                          │        pending note or suggestion        │
└──────────────────────────┴──────────────────────────────────────────┘
 next hunk ]  next unreviewed n  comment c  viewed r  finish R
```

The header always shows:

- canonical head and base refs;
- commit and file counts;
- additions and deletions, with binary/unknown counts rendered as `—`;
- Viewed progress;
- invalidated file count;
- pending feedback count;
- active projection;
- generation-change, history-rewrite, or load warnings.

The sidebar supports these filters:

- all files;
- unreviewed files;
- changed after review;
- files with pending feedback;
- text match over current path and previous path.

File markers are semantic, not decorative:

```text
○  not viewed
◐  currently reviewing
●  viewed at current content identity
!  changed after being viewed
◆  has pending feedback
```

`◆` composes with the coverage marker rather than replacing it. Color is supplemental; the glyph remains the source of meaning.

### 5.3 Diff stream and layout

The main surface is one ordered review stream, not a single-file patch replacement. Selecting a sidebar file reveals that file in the stream. Scrolling the stream updates semantic selection without forcing another client or future renderer to adopt the terminal's scroll offset.

Presentation modes are:

- `0`: auto;
- `1`: side-by-side split;
- `2`: stacked/unified.

Auto mode chooses split only when the main diff viewport can allocate two code columns of at least 32 terminal cells plus line-number, marker, and gutter columns. Otherwise it chooses stacked mode. The sidebar is collapsible and the calculation uses the remaining diff viewport, not total terminal width.

The stream is viewport-windowed with bounded overscan. It must not materialize terminal rows for the entire changeset. Parsed semantic files and hunks remain available while row plans are produced only for the visible window.

Collapsed context can be expanded before or after a hunk. Expansion requests carry the current generation and source identity. A response from an older generation is discarded.

Binary and oversized files remain visible in the sidebar and coverage totals. They have a dedicated explanation surface, support file-level feedback and Viewed, and do not pretend to have line anchors.

### 5.4 Navigation and keys

The workspace uses semantic commands with one command catalog. Menus, hints, keyboard handling, and mouse actions resolve the same command ids.

Required defaults:

| Keys | Command |
| --- | --- |
| `j` / `k`, arrows | move/scroll by review row |
| `]` / `[` | next/previous hunk |
| `.` / `,` | next/previous file |
| `n` / `N` | next/previous unreviewed or invalidated file |
| `}` / `{` | next/previous pending feedback anchor |
| `/` | focus file filter |
| `tab` | switch sidebar/stream/composer focus |
| `v` | begin/end range selection |
| `c` | create feedback at selection |
| `r` | mark current file Viewed |
| `0` / `1` / `2` | auto/split/stack layout |
| `R` | finish review |
| `?` | context-aware command help |
| `Escape` | close overlay/composer, otherwise leave workspace |

Mouse support includes sidebar selection, stream scrolling, line/range selection, gap expansion, feedback selection, and menu/dialog actions. Keyboard-only use must expose every operation.

## 6. Review projections

The authoritative document is always the aggregate `base...HEAD` generation. Projections select or derive a view; they never replace `ReviewIdentity` or create a nested review mode.

### 6.1 Aggregate

Displays the complete current branch changeset. Marking a file Viewed records its current aggregate `ContentIdentity`.

### 6.2 Since last review

Available after any finished review whose `headOid` is an ancestor of current HEAD. The patch projection is the delta from the last submitted HEAD to current HEAD. A file may be marked Viewed from this projection only when:

1. that file was Viewed in the submitted generation; and
2. the projection contains every change to that file since that generation.

When both hold, marking it Viewed advances coverage to the current aggregate `ContentIdentity`. If the old head is not an ancestor, the projection is disabled and the workspace reports rewritten history.

### 6.3 Individual commit

Displays the selected commit's patch within the same workspace and keeps aggregate context in the header. Commit projection is inspection-only: marking aggregate Viewed is disabled because the projection may omit changes from other commits.

Commit navigation must not mutate the authoritative review document, review identity, pending feedback, or aggregate selection history.

## 7. Architecture

### 7.1 Module boundaries

```text
src/review/
  core/
    document.ts
    identity.ts
    state.ts
    actions.ts
    intents.ts
    reducer.ts
    selectors.ts
    navigation.ts
    anchors.ts
    reconcile.ts
    artifact.ts
  git/
    load-review-document.ts
    load-review-projection.ts
    load-source-context.ts
  storage/
    review-state-store.ts
    review-artifact-store.ts

src/ui/review-workspace/
  review-workspace.ts
  controller.ts
  command-catalog.ts
  layout.ts
  header.ts
  files-pane.ts
  stream-pane.ts
  row-planner.ts
  feedback-composer.ts
  feedback-pane.ts
  finish-dialog.ts
```

Exact file splitting may combine very small adjacent modules, but these ownership boundaries are mandatory:

- `core` imports no OpenTUI, filesystem, Git runner, process, clipboard, or renderer types.
- `git` produces validated core documents and projections; it does not own review state.
- `storage` serializes core persistence/artifacts through the existing secure local-state primitive.
- `review-workspace` renders selectors and dispatches intents; it does not derive identity, reconciliation, or anchor rules.
- the application shell owns screen lifetime only.

### 7.2 Data flow

```text
GitRunner + canonical refs
  → ReviewDocumentLoader
  → validated ReviewDocument
  → reconcile(previous state, new document)
  → ReviewStore
  → selectors
  → viewport row planner
  → OpenTUI renderables

keyboard/mouse/menu
  → command id
  → ReviewIntent
  → plan/validate
  → ReviewAction
  → reducer
  → persistence effect
  → render
```

Planning an invalid intent fails before state publication. A reducer action is synchronous and deterministic. Filesystem writes and source-context loads occur as effects and return generation-qualified results.

### 7.3 Packages

The clean cutover adds:

- `@pierre/diffs` for unified patch parsing and canonical file/hunk/language metadata;
- `zod` for runtime validation of v2 persisted state, immutable artifacts, and future external payloads.

The lockfile records exact resolved versions. Production code owns adapters around both packages so package types do not leak through the entire review domain.

The redesign does not add React or `@opentui/react`. It continues using `@opentui/core`. It does not import hunk components or session packages.

Git diff commands must force stable, parser-compatible output independently of user Git configuration:

- no external diff;
- no color;
- rename detection enabled;
- binary markers enabled;
- canonical `a/` and `b/` prefixes;
- byte-safe path quoting and `-z` where the Git format supports it.

Before the old parser is deleted, a shared adversarial fixture corpus must demonstrate that the Pierre adapter handles the supported cases. There is no runtime fallback parser after cutover.

## 8. Domain model

The following shapes are normative; names may gain readonly modifiers but not merge semantic layers.

```ts
type ReviewIdentity = {
  id: string
  headRef: string | null
  baseRef: string
  detachedHeadOid: string | null
}

type ReviewGeneration = {
  id: string
  baseOid: string
  mergeBaseOid: string
  headOid: string
}

type ReviewDocument = {
  identity: ReviewIdentity
  generation: ReviewGeneration
  commits: readonly ReviewCommit[]
  files: readonly ReviewFile[]
  aggregatePatchDigest: string
}

type ReviewFile = {
  key: string
  path: string
  previousPath?: string
  kind: "added" | "modified" | "deleted" | "renamed" | "copied" | "binary"
  oldBlobOid: string | null
  newBlobOid: string | null
  oldMode: string | null
  newMode: string | null
  contentId: string
  patchDigest: string
  stats: { additions: number | null; deletions: number | null }
  hunks: readonly ReviewHunk[]
  source: "available" | "binary" | "too-large" | "unavailable"
}
```

Review identity is repository-local because storage already lives below this repository's Git directory. Its id is a length-prefixed hash of:

- schema discriminator `branch-review-v2`;
- canonical head ref, or detached HEAD OID;
- canonical selected base ref.

It does not include `headOid`, `baseOid`, patch text, or file contents. Moving either ref creates a new generation, not a new review. Explicitly selecting a different base ref creates a different review.

Generation id is a length-prefixed hash of `mergeBaseOid`, `baseOid`, and `headOid`.

A file key is a semantic address within the review. For an ordinary file it derives from its normalized current path. Reconciliation transfers state and anchors through an unambiguous `previousPath → path` rename. Content id hashes path-independent change content: old/new blob OIDs, old/new modes, and normalized hunk bodies. It excludes paths, review id, and generation id. Coverage separately records the path that was reviewed, so a rename preserves feedback ownership but invalidates Viewed coverage as a meaningful address change.

### 8.1 Semantic state

```ts
type ReviewState = {
  document: ReviewDocument
  revision: number
  projection: ReviewProjection
  selection: ReviewSelection
  reveal: ReviewRevealIntent
  filter: ReviewFilter
  viewed: Readonly<Record<string, ViewedRecord>>
  feedback: readonly ReviewFeedback[]
  draft: ReviewFeedbackDraft | null
  expandedGaps: readonly ExpandedGap[]
  lastSubmission: SubmittedReviewRef | null
}
```

Terminal rows, measured widths, scroll offsets, box handles, themes, and framework callbacks are forbidden from `ReviewState`.

Every state-changing dispatch increments `revision`. Re-selecting the same semantic target may still increment a reveal token when the explicit intent means "show this again." Passive viewport anchoring updates selection without requesting another reveal.

## 9. Coverage and reconciliation

### 9.1 Viewed records

```ts
type ViewedRecord = {
  fileKey: string
  path: string
  contentId: string
  generationId: string
  viewedAt: string
}
```

Coverage is derived:

- no record: `not-viewed`;
- selected and not currently covered: `reviewing`;
- record path and content id both equal the current file: `viewed`;
- a record exists but path or content id differs: `changed-after-review`.

The generation id records provenance but does not decide validity. Current path plus content identity decide validity.

### 9.2 Reconciliation algorithm

A new validated document is reconciled atomically:

1. Match exact file keys.
2. Match an unmatched old path to one new file whose `previousPath` equals the old path.
3. Reject ambiguous rename matches rather than guessing.
4. Preserve Viewed only when matched path and `contentId` are both unchanged.
5. Transfer the record but derive `changed-after-review` when content or path changed.
6. Transfer active feedback anchors to an unambiguous rename destination, then reconcile their content context.
7. Initialize unmatched new and copied files as not viewed.
8. Remove deleted files from active coverage while retaining their pending feedback as orphaned.
9. Reconcile selection to the same file, rename destination, nearest visible file, or empty selection.
10. Reconcile remaining anchors and expanded gaps.
11. Publish the complete new state in one reducer action.

Base fast-forward is a new generation in the same review. A changed merge-base may remove branch changes; the same matching rules apply. Rewritten branch history is detected when the prior submitted head is not an ancestor of current HEAD. It disables Since Last Review but does not discard aggregate coverage or feedback that can still be reconciled by identity.

## 10. Feedback and anchors

### 10.1 Feedback types

```ts
type ReviewFeedback = {
  id: string
  kind: "note" | "suggestion"
  severity: "comment" | "blocking"
  body: string
  replacement?: string
  anchor: ReviewAnchor
  resolution: "active" | "stale" | "orphaned"
  createdAt: string
  updatedAt: string
}

type ReviewAnchor =
  | { kind: "file"; fileKey: string; contentId: string }
  | {
      kind: "range"
      fileKey: string
      contentId: string
      side: "old" | "new"
      startLine: number
      endLine: number
      ownerHunkIndex: number
      contextDigest: string
    }
```

Line ranges are inclusive, one-based source line addresses. Screen rows, wrapped rows, diff markers, headers, and sidebar cells can never become anchors.

A suggestion requires a new-side range and replacement text. It represents proposed content only and has no apply action.

### 10.2 Anchor reconciliation

On a new generation:

- unchanged content keeps the anchor active;
- a unique context and hunk match relocates the anchor and keeps it active;
- an existing file without a unique valid match makes the anchor stale and retains its last known location;
- a removed/unmatched file makes the anchor orphaned.

Stale and orphaned feedback is visible in the Feedback filter. The application never silently deletes it.

Finish Review is blocked while any pending feedback is stale or orphaned. The reviewer must re-anchor or delete it. This rule applies to notes and suggestions so the artifact cannot claim a precise location it no longer has.

### 10.3 Pending review

Creating feedback adds it to a private pending review. Pending items can be navigated, edited, re-anchored, or deleted. They are saved locally and never produce notifications or repository changes.

Finish Review requires:

- no open composer;
- no invalid, stale, or orphaned pending feedback;
- a non-empty summary for Approve or Request Changes;
- at least one blocking item for Request Changes;
- no blocking item for Approve or Comment;
- for Comment, either a non-empty summary or at least one comment-severity feedback item.

A reviewer with blocking feedback must choose Request Changes or downgrade/delete the blocking items. Decision and feedback severity cannot contradict each other in the immutable artifact.

Finish uses a recoverable two-file transaction:

1. Generate the artifact id and complete artifact payload once.
2. Persist `submissionInProgress` in v2 state with artifact id and payload digest; pending feedback remains intact.
3. Exclusive-create the immutable JSON artifact.
4. Persist finalized v2 state: set `lastSubmission`, clear `submissionInProgress`, clear the submitted pending feedback, and retain file coverage.
5. Offer deterministic Markdown copy/export derived from the stored artifact.

If step 2 fails, no artifact is written. If step 3 fails, pending state and the marker remain intact. If step 4 fails, restart/retry verifies the existing artifact against the marker digest and completes the same transaction rather than creating a duplicate artifact. Finish reports success only after the finalized mutable state is durable.

## 11. Artifact

```ts
type ReviewArtifactV1 = {
  version: 1
  id: string
  review: ReviewIdentity
  generation: ReviewGeneration
  submittedAt: string
  decision: "comment" | "approve" | "request-changes"
  summary: string
  projection: { kind: "aggregate" | "since-last-review" }
  coverage: {
    viewed: readonly { fileKey: string; path: string; contentId: string }[]
    notViewed: readonly { fileKey: string; path: string }[]
  }
  feedback: readonly SubmittedFeedback[]
}
```

Individual-commit projection cannot be submitted because it is not complete branch coverage. Finish automatically returns to Aggregate or Since Last Review and asks the reviewer to confirm the intended submission projection.

Artifact ids are content-independent unique ids generated once when the submission marker is created; retries reuse that id. Immutability is enforced by exclusive-create semantics and digest verification. Artifacts are stored at:

```text
.git/githunk/reviews/<review-id>/<artifact-id>.json
```

Markdown export has stable ordering:

1. decision and summary;
2. generation and base/head refs;
3. coverage summary;
4. blocking feedback by document file order and line;
5. comment feedback by document file order and line;
6. suggestions as fenced replacement blocks.

The JSON artifact is authoritative. Markdown is a projection and is not parsed back into state.

## 12. Persistence

Current mutable state is stored at:

```text
.git/githunk/review-state-v2.json
```

The top-level schema is:

```ts
type ReviewDatabaseV2 = {
  version: 2
  baseByHead: Record<string, { baseRef: string }>
  reviews: Record<string, PersistedReviewState>
}
```

The `baseByHead` key is the canonical head ref, or `detached:<headOid>` for a detached snapshot. This makes base selection deterministic for both supported head forms.

Persisted state includes semantic selection, filter, Viewed records, pending feedback, the current draft, expanded gap identities, last submission, and any recoverable `submissionInProgress` marker. It excludes loaded patch text, source text, parsed hunks, row plans, scroll offsets, and UI handles. The current document is rebuilt from Git and then reconciled with persistence.

`zod` validates untrusted persisted values before they enter core state. Invalid state is quarantined using the existing `LocalStateFile` behavior and starts empty with a visible warning. Unknown schema versions are invalid; there is no v1 migration.

Viewed changes, feedback create/update/delete, gap toggles, projection changes, and submissions are persisted through a serialized write queue. Draft body typing is persisted with a bounded 500 ms trailing debounce and flushed on composer close and orderly application exit. A failed write reports an error and retains the in-memory state; Finish cannot succeed until artifact and mutable-state writes both complete.

## 13. Loading, errors, and concurrency

Every asynchronous load captures the expected review identity, generation, and request token. Results publish only when all still match the active workspace.

- A Git, parse, or source-context failure leaves the last complete document visible and adds an actionable error state.
- Opening with no resolvable base shows the existing base picker inside the Review Workspace startup flow.
- An empty `base...HEAD` shows a successful empty review, not a load error.
- Background HEAD/base movement builds a new document off-screen, then dispatches one reconciliation action.
- A source expansion from an old generation is discarded.
- A corrupt state file is quarantined and reported.
- A rewritten history warning identifies that Since Last Review is unavailable.
- Unsupported or malformed patch content identifies the affected file and prevents a false complete document from publishing.

The workspace remains read-only even when ordinary repository state changes in the background. Working-tree changes are not included in Branch Review and the header states that the review covers committed `base...HEAD` changes only.

## 14. Performance and allocation policy

Correctness is first, but the implementation must not build avoidable copies of large patches or row streams.

- Git output is normalized once and parsed once into the canonical document.
- Per-file digests are computed during document construction, not every render.
- Selectors operate over indexed file keys and precomputed status counts.
- The renderer creates rows only for the viewport plus bounded overscan.
- Expanded source is loaded on demand and cached by file content identity.
- Renderer-local caches are invalidated by semantic identity, never by broad "refresh everything" flags.
- Artifact Markdown is generated only on explicit export/copy.
- The persisted database contains no raw patch or source text.

A benchmark corpus must cover many files, large files, long lines, CJK and combining characters, rename-heavy changes, binary files, and frequent generation reconciliation. Initial implementation records a baseline on the project workstation and turns regressions into explicit benchmark failures only after stable measurements exist.

## 15. Clean cutover

The implementation removes obsolete code rather than routing around it. At minimum the cutover deletes or replaces:

- `BranchReviewSnapshot` and its loader-facing shape;
- `branchReviewTarget` from the repository `AppModel`;
- Branch Review ownership of `reviewStatuses` and `reviewSummary` in `AppController`;
- the old `openBranchReview` and `refreshBranchTarget` state-publication path;
- `src/review/fingerprint.ts` target-key semantics;
- the v1 Branch Review state reader and writer;
- Branch Review-specific read-only mutation guards in `root-view.ts`;
- old Branch Review mode rendering in Status, Files, Main, and Commits panes;
- old Branch Review controller/UI tests and fixtures whose contracts no longer exist.

Reusable Git capabilities remain:

- `GitRunner` and command logging;
- base inference and candidate selection;
- ref resolution;
- commit summary/detail loaders after migrating them to the new review-domain types;
- secure Git-local file resolution and atomic writes;
- clipboard support;
- repository workspace navigation before and after review.

Any retained exported symbol must have every caller migrated. No compatibility aliases or deprecated exports remain.

## 16. Verification strategy

### 16.1 Core contract tests

Pure tests cover:

- stable ReviewIdentity across HEAD and base OID movement;
- new identity after explicit base-ref change;
- detached snapshot identity;
- generation changes;
- unchanged-file Viewed preservation;
- changed-file invalidation;
- rename state transfer with coverage invalidation, plus ambiguous rename refusal;
- deletion and orphaned feedback;
- history-rewrite detection;
- selection/reveal/navigation wrap policies;
- anchor creation, relocation, stale, and orphaned states;
- pending feedback and Finish invariants;
- deterministic artifact and Markdown ordering;
- reducer identity/no-op and revision behavior.

### 16.2 Git integration tests

Real temporary repositories cover:

- multiple commits after a base;
- base fast-forward;
- appended branch commit;
- amend/force rewrite;
- rename, copy, delete, binary, and mode-only changes;
- non-ASCII and awkward paths;
- empty branch diff;
- detached HEAD;
- aggregate, since-last-review, and commit projections;
- canonical parser output despite hostile user Git configuration.

### 16.3 Conformance corpus

One adversarial fixture corpus drives:

- Pierre adapter parsing;
- core document projection;
- anchor geometry;
- context expansion;
- terminal row planning.

The same expected semantic addresses must be observed at every layer. Parser-specific types stop at the adapter boundary.

### 16.4 TUI acceptance

The real OpenTUI surface is exercised for:

- `b` entry and `Escape` return;
- sidebar and stream focus;
- keyboard and mouse file/range selection;
- file/hunk/unreviewed/feedback navigation;
- auto/split/stack layout and resize;
- filters and empty states;
- Viewed progress and invalidation after a new commit;
- note and suggestion composing/editing/deleting;
- stale/orphaned feedback resolution;
- Finish validation and decision selection;
- JSON artifact persistence and Markdown clipboard export;
- restart restoration;
- failed background refresh retaining the prior document.

### 16.5 Behavioral smoke

Completion requires launching githunk in a real repository and observing this scenario end to end:

1. open `base...HEAD` Branch Review;
2. review and mark files Viewed;
3. add a multiline blocking suggestion and comment;
4. finish Request Changes and inspect JSON/Markdown output;
5. add a new commit changing one reviewed and one unreviewed file;
6. reopen/reconcile and observe only the changed reviewed file invalidated;
7. use Since Last Review;
8. restart githunk and confirm state and last submission restoration.

## 17. Acceptance criteria

The redesign is complete only when all statements are true:

1. `b` opens a dedicated Review Workspace; the repository multi-pane dashboard is not visible behind it.
2. The workspace clearly identifies committed `base...HEAD` as its review target.
3. A new HEAD commit does not create a new persistent review identity.
4. An unchanged Viewed file remains Viewed across generations.
5. A changed Viewed file becomes visibly invalidated.
6. An unambiguous rename transfers selection and anchors but invalidates Viewed coverage; deletion preserves orphaned feedback.
7. Aggregate, Since Last Review, and individual-commit projections obey their coverage rules.
8. Continuous diff rendering remains responsive without materializing the whole changeset as terminal rows.
9. Precise file/line/range feedback never anchors to terminal screen rows.
10. Pending notes and suggestions survive restart.
11. Branch Review invokes no repository mutation command.
12. Stale or orphaned feedback cannot be silently submitted.
13. Finish produces one immutable JSON artifact before clearing pending feedback.
14. Markdown export is deterministic and derived from the stored artifact.
15. Approve and Request Changes enforce their blocking-feedback invariants.
16. Corrupt persistence is quarantined and reported without preventing a new review.
17. Failed refresh preserves the last complete generation.
18. The old Branch Review state, UI path, types, tests, and v1 migration code are absent.
19. `@pierre/diffs` is isolated behind the Git/document adapter and `zod` behind storage/artifact boundaries.
20. Core, Git integration, conformance, TUI acceptance, and the behavioral smoke scenario pass.

## 18. Risks and chosen responses

| Risk | Decision |
| --- | --- |
| Pierre parsing differs from the current parser | Prove supported behavior with one adversarial conformance corpus, then delete the old parser; no dual runtime. |
| Continuous stream consumes excessive memory | Keep semantic hunks, window terminal rows, lazy-load expanded source, benchmark real large changesets. |
| New commits invalidate all progress | Stable review identity plus per-file content identity; generation records provenance only. |
| Range feedback silently points at wrong code | Context-qualified anchors with explicit active/stale/orphaned reconciliation; block invalid submission. |
| Local decisions look like fake GitHub controls | Decisions produce immutable, consumable artifacts with enforced invariants; no remote claim is shown. |
| Future provider integration distorts core | Keep artifacts provider-neutral, but do not create a provider interface until a real provider is implemented. |
| Breaking cutover leaves dead paths | Migrate every caller and delete old symbols/tests/state handling in the same implementation. |
| Draft persistence writes on every key | Serialized persistence with a bounded trailing debounce and explicit flush points. |

## 19. Final product boundary

This project delivers a local, complete review lifecycle for committed branch changes. It is more than a diff viewer and intentionally less than a hosted collaboration platform.

The defining loop is:

```text
Open committed branch changes
→ understand the aggregate changeset
→ track exact coverage
→ leave precise private feedback
→ reconcile new generations safely
→ finish an immutable review
→ hand that review to a human or agent
```

Everything in the first release must strengthen that loop. Repository mutations, remote collaboration policy, browser rendering, and provider-specific metadata remain outside it.
