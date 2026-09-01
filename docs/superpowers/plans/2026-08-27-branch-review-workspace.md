# Branch Review Workspace Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the current Branch Review mode with a dedicated, local-first Review Workspace that preserves exact coverage across Git generations, supports precise pending feedback, and produces immutable review artifacts.

**Architecture:** Keep githunk's Git runner, base inference, commit loading, secure local storage, and repository workspace. Introduce a renderer-neutral `src/review/core` document/state/intent/reconcile model, Git adapters under `src/review/git`, v2 persistence under `src/review/storage`, and a full-screen OpenTUI renderer under `src/ui/review-workspace`; cleanly delete the old Branch Review mode after every caller has moved.

**Tech Stack:** Bun, TypeScript 5.9, `@opentui/core`, `@pierre/diffs`, `zod`, Git CLI, Bun test.

**Spec:** `docs/superpowers/specs/2026-08-27-branch-review-workspace-design.md`

## Global Constraints

- Branch Review is read-only: no edit, stage, discard, apply, commit, or other Git mutation path may be reachable.
- The authoritative target is committed `base...HEAD`; working-tree changes are excluded and the UI says so.
- Review identity excludes moving OIDs; generation contains `mergeBaseOid`, `baseOid`, and `headOid`.
- Coverage validity requires both the reviewed path and per-file content identity to match.
- A rename transfers selection and feedback anchors but invalidates Viewed coverage.
- Review core imports no OpenTUI, filesystem, Git runner, process, clipboard, Pierre, or Zod types.
- `@pierre/diffs` is isolated behind the Git/document adapter; `zod` is isolated behind persistence and artifact boundaries.
- Do not add React, `@opentui/react`, hunk components, a provider interface, a fallback parser, compatibility aliases, deprecated exports, or v1 migration.
- Continuous rendering is viewport-windowed; do not construct terminal rows for the entire changeset.
- All async results are qualified by review identity, generation, and request token before publication.
- Every task uses TDD, runs only the focused tests named in that task, and commits an independently testable result.
- Do not run project-wide formatting, lint, or the full test suite inside individual tasks; Task 15 owns integrated verification.

## Locked file structure

```text
src/review/core/
  types.ts                 Domain types shared by core modules
  identity.ts              Stable review, generation, file, and tuple hashes
  document.ts              Document construction invariants and indexes
  state.ts                 Semantic mutable review state
  actions.ts               Reducer action union
  intents.ts               Validated semantic intent planning
  reducer.ts               Deterministic state transitions
  selectors.ts             Coverage, filtering, progress, and visible order
  navigation.ts            File/hunk/feedback walks and reveal policy
  anchors.ts               File/range anchor creation and reconciliation
  reconcile.ts             Atomic generation reconciliation
  artifact.ts              Finish validation and deterministic artifact/Markdown

src/review/git/
  patch-adapter.ts          Pierre-only patch parsing boundary
  raw-diff.ts               Git --raw -z metadata parsing
  load-review-document.ts   Aggregate document loader
  load-review-projection.ts Since-last and commit projections
  load-source-context.ts    Generation-qualified gap expansion

src/review/storage/
  schemas.ts                Zod schemas and persisted/domain conversion
  review-state-store.ts     Serialized v2 mutable-state persistence
  review-artifact-store.ts  Exclusive immutable artifact transaction

src/ui/review-workspace/
  controller.ts             Async orchestration and effects
  review-workspace.ts       OpenTUI screen lifetime and event routing
  command-catalog.ts        Command ids, keys, titles, availability
  layout.ts                 Sidebar and auto/split/stack geometry
  header.ts                 Target, progress, projection, and warning text
  files-pane.ts             Filtered semantic file rows
  row-planner.ts            Windowed stream rows and source addresses
  stream-pane.ts            Visible row renderables and mouse mapping
  feedback-composer.ts      Note/suggestion draft UI
  feedback-pane.ts          Pending/stale/orphaned feedback navigation
  finish-dialog.ts          Decision validation and artifact submission
```

Existing files changed by the cutover:

```text
package.json
bun.lock
src/app/create-app.ts
src/app/controller.ts
src/domain/repository.ts
src/git/branch-review.ts             deleted
src/review/fingerprint.ts            deleted
src/review/store.ts                  deleted
src/ui/root-view.ts
src/ui/bindings.ts
src/ui/panes/status-pane.ts
src/ui/panes/files-pane.ts
src/storage/local-state-file.ts
```

Tests mirror ownership under `tests/review/core`, `tests/review/git`, `tests/review/storage`, and `tests/ui/review-workspace`. Shared adversarial patch fixtures live under `tests/fixtures/review`.

---

### Task 1: Core identities and document model

**Files:**
- Create: `src/review/core/types.ts`
- Create: `src/review/core/identity.ts`
- Create: `src/review/core/document.ts`
- Create: `tests/review/core/identity.test.ts`
- Create: `tests/review/core/document.test.ts`

**Interfaces:**
- Produces: `ReviewIdentity`, `ReviewGeneration`, `ReviewFile`, `ReviewDocument`, `ReviewCommit`, `ReviewHunk`, `createReviewIdentity`, `createReviewGeneration`, `createReviewDocument`, `sha256Tuple`.
- Consumes: only Node `crypto` and plain TypeScript values.

- [ ] **Step 1: Write identity tests that distinguish stable review identity from moving generation**

```ts
import { describe, expect, test } from "bun:test"
import { createReviewGeneration, createReviewIdentity } from "../../../src/review/core/identity"

describe("review identity", () => {
  test("keeps one review id while HEAD and base OIDs move", () => {
    const first = createReviewIdentity({ headRef: "refs/heads/feature", headOid: "h1", baseRef: "refs/remotes/origin/main" })
    const second = createReviewIdentity({ headRef: "refs/heads/feature", headOid: "h2", baseRef: "refs/remotes/origin/main" })
    expect(second.id).toBe(first.id)
    expect(createReviewGeneration({ mergeBaseOid: "m1", baseOid: "b1", headOid: "h1" }).id)
      .not.toBe(createReviewGeneration({ mergeBaseOid: "m2", baseOid: "b2", headOid: "h2" }).id)
  })

  test("uses the detached OID as snapshot identity", () => {
    const identity = createReviewIdentity({ headOid: "deadbeef", baseRef: "main" })
    expect(identity).toMatchObject({ headRef: null, detachedHeadOid: "deadbeef" })
  })
})
```

- [ ] **Step 2: Run identity tests and verify the module is absent**

Run: `bun test tests/review/core/identity.test.ts`  
Expected: FAIL because `src/review/core/identity.ts` cannot be resolved.

- [ ] **Step 3: Define the normative domain types**

Implement the spec shapes in `types.ts`, including blob OIDs and modes on `ReviewFile`:

```ts
export type ReviewIdentity = Readonly<{ id: string; headRef: string | null; baseRef: string; detachedHeadOid: string | null }>
export type ReviewGeneration = Readonly<{ id: string; baseOid: string; mergeBaseOid: string; headOid: string }>
export type ReviewFileKind = "added" | "modified" | "deleted" | "renamed" | "copied" | "binary"
export type ReviewFile = Readonly<{
  key: string
  path: string
  previousPath?: string
  kind: ReviewFileKind
  oldBlobOid: string | null
  newBlobOid: string | null
  oldMode: string | null
  newMode: string | null
  contentId: string
  patchDigest: string
  stats: Readonly<{ additions: number | null; deletions: number | null }>
  hunks: readonly ReviewHunk[]
  source: "available" | "binary" | "too-large" | "unavailable"
}>
export type ReviewDocument = Readonly<{
  identity: ReviewIdentity
  generation: ReviewGeneration
  commits: readonly ReviewCommit[]
  files: readonly ReviewFile[]
  aggregatePatchDigest: string
}>
```

Define `ReviewHunk` with old/new start/count, normalized lines, and a stable hunk digest. Define `ReviewCommit` with OID, parents, author, timestamp, subject, and body; do not import `src/domain/commit.ts` into core.

- [ ] **Step 4: Implement length-prefixed identity hashing**

```ts
export function createReviewIdentity(input: { headRef?: string; headOid: string; baseRef: string }): ReviewIdentity {
  const headKey = input.headRef ?? `detached:${input.headOid}`
  return {
    id: sha256Tuple(["branch-review-v2", headKey, input.baseRef]),
    headRef: input.headRef ?? null,
    baseRef: input.baseRef,
    detachedHeadOid: input.headRef === undefined ? input.headOid : null,
  }
}

export function createReviewGeneration(input: Omit<ReviewGeneration, "id">): ReviewGeneration {
  return { ...input, id: sha256Tuple([input.mergeBaseOid, input.baseOid, input.headOid]) }
}
```

`sha256Tuple` must retain the existing four-byte big-endian length prefix per UTF-8 field so tuple boundaries cannot collide.

- [ ] **Step 5: Write and implement document invariant tests**

Test that duplicate file keys, duplicate paths, and duplicate commit OIDs throw; valid input builds readonly `fileByKey`, `fileIndexByKey`, and `commitByOid` indexes in a `ReviewDocumentIndex` returned by `indexReviewDocument(document)`.

Run: `bun test tests/review/core/identity.test.ts tests/review/core/document.test.ts`  
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/review/core tests/review/core/identity.test.ts tests/review/core/document.test.ts
git commit -m "feat(review): define stable review document identities"
```

---

### Task 2: Semantic state, intents, reducer, and navigation

**Files:**
- Create: `src/review/core/state.ts`
- Create: `src/review/core/actions.ts`
- Create: `src/review/core/intents.ts`
- Create: `src/review/core/reducer.ts`
- Create: `src/review/core/selectors.ts`
- Create: `src/review/core/navigation.ts`
- Create: `tests/review/core/reducer.test.ts`
- Create: `tests/review/core/navigation.test.ts`

**Interfaces:**
- Consumes: `ReviewDocument`, `ReviewFile`, and document indexes from Task 1.
- Produces: `ReviewState`, `ReviewIntent`, `ReviewAction`, `ReviewSelection`, `ReviewRevealIntent`, `createInitialReviewState`, `planReviewIntent`, `reduceReviewState`, `visibleReviewFiles`, `moveReviewSelection`.

- [ ] **Step 1: Write failing tests for semantic-only state and explicit reveal tokens**

```ts
const state = createInitialReviewState(document)
const action = planReviewIntent(state, { type: "selection/select-file", fileKey: "src/b.ts" })
const next = reduceReviewState(state, action)
expect(next.selection).toEqual({ fileKey: "src/b.ts", hunkIndex: 0 })
expect(next.reveal.fileTopToken).toBe(state.reveal.fileTopToken + 1)
expect(next.revision).toBe(state.revision + 1)
expect(Object.keys(next)).not.toContain("scrollOffset")
```

Also test filter normalization, next/previous hunk clamp, next/previous file clamp, explicit reselection incrementing reveal, passive viewport anchoring not incrementing reveal, and empty documents.

- [ ] **Step 2: Run focused tests and verify failure**

Run: `bun test tests/review/core/reducer.test.ts tests/review/core/navigation.test.ts`  
Expected: FAIL because state and navigation modules do not exist.

- [ ] **Step 3: Implement semantic state without feedback or persistence effects**

```ts
export type ReviewSelection = Readonly<{ fileKey: string | null; hunkIndex: number }>
export type ReviewRevealIntent = Readonly<{ fileTopToken: number; hunkToken: number; scrollToFeedback: boolean }>
export type ReviewProjection =
  | Readonly<{ kind: "aggregate" }>
  | Readonly<{ kind: "since-last-review"; fromHeadOid: string }>
  | Readonly<{ kind: "commit"; oid: string }>

export type ExpandedGap = Readonly<{ fileKey: string; gapId: string; expanded: boolean }>
export type SubmittedReviewRef = Readonly<{ artifactId: string; generationId: string; headOid: string; submittedAt: string }>
export type ReviewState = Readonly<{
  document: ReviewDocument
  revision: number
  projection: ReviewProjection
  selection: ReviewSelection
  reveal: ReviewRevealIntent
  filter: Readonly<{ query: string; scope: "all" | "unreviewed" | "changed" | "feedback" }>
  expandedGaps: readonly ExpandedGap[]
  lastSubmission: SubmittedReviewRef | null
}>
```

`createInitialReviewState` selects the first file or `null`, begins at revision zero, aggregate projection, empty filter, and no expanded gaps.

- [ ] **Step 4: Implement closed intent and action unions**

Include exact intent types for selecting files, moving by file/hunk, passive viewport anchor, changing filter/scope, changing projection, and toggling an expanded gap. `planReviewIntent` must validate file keys, commit OIDs, hunk bounds, and projection preconditions before producing an action.

```ts
export type ReviewIntent =
  | { type: "selection/select-file"; fileKey: string }
  | { type: "selection/move"; unit: "file" | "hunk"; direction: "next" | "previous" }
  | { type: "selection/viewport-anchor"; fileKey: string; hunkIndex: number }
  | { type: "filter/set-query"; query: string }
  | { type: "filter/set-scope"; scope: "all" | "unreviewed" | "changed" | "feedback" }
  | { type: "projection/set"; projection: ReviewProjection }
  | { type: "gap/toggle"; fileKey: string; gapId: string }
```

- [ ] **Step 5: Implement deterministic reducer and selectors**

The reducer returns the same object for a semantic no-op, except explicit reveal intents must update their token and revision. `visibleReviewFiles` filters over normalized current/previous paths and preserves document order. Navigation walks the visible order, clamps at boundaries, and never invents wrap behavior.

- [ ] **Step 6: Run focused tests**

Run: `bun test tests/review/core/reducer.test.ts tests/review/core/navigation.test.ts`  
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/review/core tests/review/core/reducer.test.ts tests/review/core/navigation.test.ts
git commit -m "feat(review): add semantic review state and navigation"
```

---

### Task 3: Feedback anchors, pending lifecycle, and artifact rules

**Files:**
- Create: `src/review/core/anchors.ts`
- Create: `src/review/core/artifact.ts`
- Modify: `src/review/core/types.ts`
- Modify: `src/review/core/state.ts`
- Modify: `src/review/core/actions.ts`
- Modify: `src/review/core/intents.ts`
- Modify: `src/review/core/reducer.ts`
- Modify: `src/review/core/selectors.ts`
- Create: `tests/review/core/anchors.test.ts`
- Create: `tests/review/core/feedback.test.ts`
- Create: `tests/review/core/artifact.test.ts`

**Interfaces:**
- Consumes: state/intent/reducer interfaces from Task 2.
- Produces: `ReviewAnchor`, `ReviewFeedback`, `ReviewFeedbackDraft`, `ReviewArtifactV1`, `createRangeAnchor`, `reconcileAnchor`, `validateFinishReview`, `buildReviewArtifact`, `renderReviewArtifactMarkdown`.

- [ ] **Step 1: Write failing anchor tests using one-based source lines rather than terminal rows**

Test file-level anchors, inclusive new/old ranges, invalid zero/reversed ranges, owner hunk assignment, unique context relocation, stale same-file anchors, and orphaned deleted-file anchors.

```ts
expect(createRangeAnchor(file, { side: "new", startLine: 8, endLine: 10 })).toMatchObject({
  kind: "range",
  fileKey: file.key,
  contentId: file.contentId,
  side: "new",
  startLine: 8,
  endLine: 10,
})
```

- [ ] **Step 2: Write failing lifecycle and finish-rule tests**

Cover draft start/update/cancel/create; note versus suggestion; comment versus blocking severity; edit/delete/re-anchor; feedback-order navigation; restart-shaped state values; and these decisions:

```ts
expect(validateFinishReview(stateWithBlocking, { decision: "approve", summary: "Looks good" })).toEqual({ ok: false, reason: "approve-has-blocking-feedback" })
expect(validateFinishReview(stateWithBlocking, { decision: "request-changes", summary: "Please address this" })).toEqual({ ok: true })
expect(validateFinishReview(stateWithStale, { decision: "request-changes", summary: "Please address this" })).toEqual({ ok: false, reason: "feedback-needs-reanchor" })
```

- [ ] **Step 3: Run focused tests and verify failure**

Run: `bun test tests/review/core/anchors.test.ts tests/review/core/feedback.test.ts tests/review/core/artifact.test.ts`  
Expected: FAIL because feedback interfaces are absent.

- [ ] **Step 4: Add feedback and draft fields to state and actions**

`ReviewState` gains `feedback`, `draft`, and a feedback reveal preference. Add intents/actions for start/update/cancel/create, edit, delete, re-anchor, and next/previous feedback. Suggestions require a new-side range and replacement text; file/binary anchors reject suggestions.

- [ ] **Step 5: Implement anchor context and reconciliation**

Build `contextDigest` from normalized source lines around the selected range and hunk identity. Reconciliation returns exactly one of:

```ts
export type AnchorReconciliation =
  | { resolution: "active"; anchor: ReviewAnchor }
  | { resolution: "stale"; anchor: ReviewAnchor }
  | { resolution: "orphaned"; anchor: ReviewAnchor }
```

Only a unique context match relocates an active range. Never choose the first of multiple matches.

- [ ] **Step 6: Implement finish validation, immutable payload construction, and Markdown rendering**

Artifact construction receives an explicit id and timestamp so tests remain deterministic. Markdown ordering is decision/summary, refs/generation, coverage, blocking feedback, comment feedback, then suggestion replacement fences. Individual-commit projection is rejected.

- [ ] **Step 7: Run focused tests**

Run: `bun test tests/review/core/anchors.test.ts tests/review/core/feedback.test.ts tests/review/core/artifact.test.ts`  
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/review/core tests/review/core/anchors.test.ts tests/review/core/feedback.test.ts tests/review/core/artifact.test.ts
git commit -m "feat(review): model precise pending review feedback"
```

---

### Task 4: Viewed coverage and atomic generation reconciliation

**Files:**
- Create: `src/review/core/reconcile.ts`
- Modify: `src/review/core/state.ts`
- Modify: `src/review/core/actions.ts`
- Modify: `src/review/core/intents.ts`
- Modify: `src/review/core/reducer.ts`
- Modify: `src/review/core/selectors.ts`
- Create: `tests/review/core/coverage.test.ts`
- Create: `tests/review/core/reconcile.test.ts`

**Interfaces:**
- Consumes: `ReviewDocument`, anchors, feedback, and state from Tasks 1–3.
- Produces: `ViewedRecord`, `ReviewCoverageState`, `coverageForFile`, `reviewProgress`, `reconcileReviewState`, mark-Viewed intent/action.

- [ ] **Step 1: Write failing coverage tests for path plus content identity**

```ts
const viewed = { fileKey: "src/a.ts", path: "src/a.ts", contentId: "content-1", generationId: "g1", viewedAt: "2026-08-27T00:00:00.000Z" }
expect(coverageForFile(file({ path: "src/a.ts", contentId: "content-1" }), viewed)).toBe("viewed")
expect(coverageForFile(file({ path: "src/b.ts", previousPath: "src/a.ts", contentId: "content-1" }), viewed)).toBe("changed-after-review")
expect(coverageForFile(file({ path: "src/a.ts", contentId: "content-2" }), viewed)).toBe("changed-after-review")
```

Also test Aggregate marking, Since Last Review eligibility, and Commit projection refusal.

- [ ] **Step 2: Write failing reconciliation tests**

Cover unchanged file, changed content, rename, ambiguous rename, copied file, deletion, selection fallback, feedback relocation, stale/orphaned anchors, expanded-gap retirement, base movement, and rewritten-history flagging.

- [ ] **Step 3: Run focused tests and verify failure**

Run: `bun test tests/review/core/coverage.test.ts tests/review/core/reconcile.test.ts`  
Expected: FAIL because `reconcile.ts` and Viewed state do not exist.

- [ ] **Step 4: Add Viewed records and derived selectors**

`ReviewState` gains `viewed: Readonly<Record<string, ViewedRecord>>`. `reviewProgress` returns counts for total, viewed, reviewing, changed, unreviewed, and pending feedback without scanning raw patch text. Marking Viewed stores current file key, path, content id, generation id, and injected timestamp.

- [ ] **Step 5: Implement one atomic reconciliation action**

```ts
export function reconcileReviewState(previous: ReviewState, document: ReviewDocument): ReviewState {
  const matches = matchReviewFiles(previous.document.files, document.files)
  const viewed = reconcileViewed(previous.viewed, matches)
  const feedback = previous.feedback.map((item) => reconcileFeedback(item, matches, document))
  const selection = reconcileSelection(previous.selection, matches, document)
  const expandedGaps = reconcileExpandedGaps(previous.expandedGaps, matches)
  return reduceReviewState(previous, { type: "document/reconciled", document, viewed, feedback, selection, expandedGaps })
}
```

`matchReviewFiles` must return explicit exact, rename, ambiguous, new, copy, and deleted results; consumers may not infer them independently.

- [ ] **Step 6: Run focused tests**

Run: `bun test tests/review/core/coverage.test.ts tests/review/core/reconcile.test.ts`  
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/review/core tests/review/core/coverage.test.ts tests/review/core/reconcile.test.ts
git commit -m "feat(review): reconcile viewed coverage across generations"
```

---

### Task 5: Pierre patch adapter and aggregate Git document loader

**Files:**
- Modify: `package.json`
- Modify: `bun.lock`
- Create: `src/review/git/patch-adapter.ts`
- Create: `src/review/git/raw-diff.ts`
- Create: `src/review/git/load-review-document.ts`
- Create: `tests/fixtures/review/modified.patch`
- Create: `tests/fixtures/review/rename.patch`
- Create: `tests/fixtures/review/binary.patch`
- Create: `tests/fixtures/review/awkward-path.patch`
- Create: `tests/review/git/patch-adapter.test.ts`
- Create: `tests/review/git/raw-diff.test.ts`
- Create: `tests/review/git/load-review-document.integration.test.ts`

**Interfaces:**
- Consumes: core document/identity interfaces and existing `GitRunner`, `resolveRefOid`, `listCommits`.
- Produces: `parseReviewPatch(patchText, metadata)`, `parseRawDiffZ(raw)`, `loadReviewDocument(runner, baseRef): Promise<ReviewDocument>`.

- [ ] **Step 1: Add the parser dependency**

Run: `bun add @pierre/diffs`  
Expected: `package.json` and `bun.lock` record a production dependency; no React dependency is added.

- [ ] **Step 2: Write parser fixtures and failing adapter tests**

Fixtures must include modified/add/delete, pure rename, rename with edits, copy, mode-only, binary, no-final-newline, quoted/non-ASCII path, CRLF content, and multiple files. Assert core `ReviewFile` values; never snapshot Pierre objects.

- [ ] **Step 3: Run adapter tests and verify failure**

Run: `bun test tests/review/git/patch-adapter.test.ts tests/review/git/raw-diff.test.ts`  
Expected: FAIL because adapter modules do not exist.

- [ ] **Step 4: Implement the Pierre boundary and raw metadata parser**

`parseReviewPatch` calls `parsePatchFiles` and immediately converts each result into core hunks. `parseRawDiffZ` parses Git's NUL-framed raw records into old/new modes, blob OIDs, status, score, current path, and previous path. Join patch, raw, and numstat records by normalized current/previous path; reject missing or ambiguous joins.

Content identity must use this exact tuple:

```ts
sha256Tuple([
  raw.oldBlobOid ?? "",
  raw.newBlobOid ?? "",
  raw.oldMode ?? "",
  raw.newMode ?? "",
  normalizedHunkBody,
])
```

Patch digest hashes the normalized complete per-file patch. Paths are excluded from content identity and included in the semantic file key.

- [ ] **Step 5: Write the real-repository aggregate loader test**

Use `tests/helpers/temp-repository.ts` to create base plus three branch commits including a rename and binary file. Assert canonical identity, generation, ordered commits, files, OIDs/modes, aggregate digest, and no working-tree file.

- [ ] **Step 6: Implement `loadReviewDocument` with concurrent read-only Git calls**

Run these read-only queries after resolving base and HEAD:

```ts
const range = `${baseRef}...HEAD`
await Promise.all([
  runner.run(["merge-base", baseRef, "HEAD"], { readOnly: true }),
  runner.run(["diff", "--no-ext-diff", "--no-color", "--find-renames", "--binary", "--src-prefix=a/", "--dst-prefix=b/", range, "--"], { readOnly: true }),
  runner.run(["diff", "--no-ext-diff", "--no-color", "--find-renames", "--raw", "-z", range, "--"], { readOnly: true }),
  runner.run(["diff", "--no-ext-diff", "--no-color", "--find-renames", "--numstat", "-z", range, "--"], { readOnly: true }),
  listCommits(runner, `${baseRef}..HEAD`),
])
```

Use `symbolic-ref --quiet HEAD` to obtain the canonical full head ref. Its non-zero detached-HEAD result is data, not an error.

- [ ] **Step 7: Run focused tests**

Run: `bun test tests/review/git/patch-adapter.test.ts tests/review/git/raw-diff.test.ts tests/review/git/load-review-document.integration.test.ts`  
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add package.json bun.lock src/review/git tests/fixtures/review tests/review/git
git commit -m "feat(review): load canonical branch review documents"
```

---

### Task 6: Since-last, commit, and source-context projections

**Files:**
- Create: `src/review/git/load-review-projection.ts`
- Create: `src/review/git/load-source-context.ts`
- Create: `tests/review/git/projections.integration.test.ts`
- Create: `tests/review/git/source-context.integration.test.ts`
- Modify: `src/review/core/types.ts`
- Modify: `src/review/core/intents.ts`

**Interfaces:**
- Consumes: aggregate `ReviewDocument`, `GitRunner`, `SubmittedReviewRef`, patch adapter.
- Produces: `ReviewProjectionDocument`, `loadSinceLastReviewProjection`, `loadCommitProjection`, `loadSourceContext`, `isAncestor`.

- [ ] **Step 1: Write failing projection tests in real repositories**

Test that Since Last Review uses `lastHead..HEAD`, is available only when last head is an ancestor, includes all changes since submission, and is disabled after an amend/force rewrite. Test that a commit projection contains only that commit and cannot mark aggregate coverage.

- [ ] **Step 2: Write failing source-context tests**

Test before/trailing gap expansion, deleted/new side source addresses, binary/too-large refusal, request generation echo, and stale generation rejection at the caller boundary.

- [ ] **Step 3: Run focused tests and verify failure**

Run: `bun test tests/review/git/projections.integration.test.ts tests/review/git/source-context.integration.test.ts`  
Expected: FAIL because projection loaders do not exist.

- [ ] **Step 4: Implement projection documents as views over one review identity**

```ts
export type ReviewProjectionDocument = Readonly<{
  reviewId: string
  generationId: string
  projection: ReviewProjection
  files: readonly ReviewFile[]
}>
```

Since-last loads `lastHeadOid..HEAD`; commit loads `${oid}^!` or the root commit's empty-tree range. Neither constructs a new `ReviewIdentity`. Return a typed `history-rewritten` result instead of throwing when ancestry fails.

- [ ] **Step 5: Implement generation-qualified source loading**

```ts
export type SourceContextRequest = Readonly<{ reviewId: string; generationId: string; fileKey: string; side: "old" | "new"; startLine: number; endLine: number }>
export type SourceContextResult = Readonly<{ reviewId: string; generationId: string; fileKey: string; side: "old" | "new"; startLine: number; lines: readonly string[] }>
```

Use `git show <blobOid>` from the aggregate file metadata, enforce the requested range, and return typed binary/too-large/unavailable errors.

- [ ] **Step 6: Run focused tests**

Run: `bun test tests/review/git/projections.integration.test.ts tests/review/git/source-context.integration.test.ts`  
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/review/git src/review/core/types.ts src/review/core/intents.ts tests/review/git
git commit -m "feat(review): add incremental and commit projections"
```

---

### Task 7: V2 persistence and recoverable artifact transaction

**Files:**
- Modify: `package.json`
- Modify: `bun.lock`
- Modify: `src/storage/local-state-file.ts`
- Create: `src/review/storage/schemas.ts`
- Create: `src/review/storage/review-state-store.ts`
- Create: `src/review/storage/review-artifact-store.ts`
- Create: `tests/storage/local-state-exclusive.test.ts`
- Create: `tests/review/storage/schemas.test.ts`
- Create: `tests/review/storage/review-state-store.integration.test.ts`
- Create: `tests/review/storage/review-artifact-store.integration.test.ts`

**Interfaces:**
- Consumes: core `ReviewState`, `ReviewArtifactV1`, existing `LocalStateFile` and `GitRunner`.
- Produces: `ReviewDatabaseV2`, `PersistedReviewState`, `ReviewStateStore`, `ReviewArtifactStore`, `LocalStateFile.createTextExclusive`, `finishReviewTransaction`.

- [ ] **Step 1: Add runtime schema validation**

Run: `bun add zod`  
Expected: `zod` is a production dependency; package changes contain no other new dependency.

- [ ] **Step 2: Write failing exclusive-create tests**

Assert that `createTextExclusive` creates mode `0600`, fsyncs through the existing path discipline, refuses a symlinked component, and returns a typed `already-exists` result without replacing existing content.

- [ ] **Step 3: Implement atomic exclusive creation**

Write to a mode-`0600` temporary file, sync it, create the final name with an atomic hard-link operation, unlink the temporary file, then sync the directory where supported. A pre-existing final path must never be overwritten.

- [ ] **Step 4: Write failing schema and corruption tests**

Test valid round trips, rejected unknown versions, rejected invalid ranges/decisions/timestamps, detached `baseByHead` keys, corrupt-file quarantine, no v1 read, and exclusion of raw patches/renderer fields.

- [ ] **Step 5: Implement Zod schemas and explicit conversions**

Zod values stop inside `schemas.ts`. Convert parsed values to core readonly types; do not export inferred Zod types as the domain model. The top-level schema is exactly version 2 with `baseByHead` and `reviews`.

- [ ] **Step 6: Implement serialized state persistence and 500 ms draft debounce**

`ReviewStateStore` exposes `load`, `saveSemanticChange`, `saveDraftDebounced`, `flush`, and `quarantineWarning`. Writes run through one promise queue. `flush` waits for both debounce and queue completion.

- [ ] **Step 7: Write failing transaction recovery tests**

Inject failure after marker write, after artifact exclusive-create, and before finalized-state write. Assert retry/restart reuses the same id and digest, never creates a duplicate artifact, never clears pending feedback early, and reports success only after final state durability.

- [ ] **Step 8: Implement artifact transaction**

```ts
export async function finishReviewTransaction(input: {
  stateStore: ReviewStateStore
  artifactStore: ReviewArtifactStore
  reviewState: ReviewState
  artifact: ReviewArtifactV1
}): Promise<ReviewState>
```

Persist `submissionInProgress`, exclusive-create or digest-verify the artifact, then finalize `lastSubmission` and clear submitted pending feedback plus the marker. On load, `recoverSubmission` completes the same steps.

- [ ] **Step 9: Run focused tests**

Run: `bun test tests/storage/local-state-exclusive.test.ts tests/review/storage/schemas.test.ts tests/review/storage/review-state-store.integration.test.ts tests/review/storage/review-artifact-store.integration.test.ts`  
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add package.json bun.lock src/storage/local-state-file.ts src/review/storage tests/storage/local-state-exclusive.test.ts tests/review/storage
git commit -m "feat(review): persist review state and immutable artifacts"
```

---

### Task 8: Workspace controller and top-level screen transition

**Files:**
- Create: `src/ui/review-workspace/controller.ts`
- Create: `src/ui/review-workspace/review-workspace.ts`
- Create: `src/app/screen-controller.ts`
- Modify: `src/app/create-app.ts`
- Modify: `src/ui/root-view.ts`
- Create: `tests/app/screen-controller.test.ts`
- Create: `tests/ui/review-workspace/lifecycle.integration.test.ts`

**Interfaces:**
- Consumes: document/projection loaders, core store, state/artifact stores, `CliRenderer`, existing repository `AppController` and `RootView`.
- Produces: `ReviewWorkspaceController`, `ReviewWorkspace`, `AppScreenController`, `openBranchReview`, `closeBranchReview`.

- [ ] **Step 1: Write failing screen-lifecycle tests**

Assert `b` disposes/hides repository renderables and mounts one Review Workspace; `Escape` restores the same repository focus/selection; opening failure restores the repository screen with a visible error; repeated open/close leaves one key handler and no timer leak.

- [ ] **Step 2: Run lifecycle tests and verify failure**

Run: `bun test tests/app/screen-controller.test.ts tests/ui/review-workspace/lifecycle.integration.test.ts`  
Expected: FAIL because top-level screen ownership does not exist.

- [ ] **Step 3: Implement `ReviewWorkspaceController` orchestration**

Expose readonly `state`, `open`, `dispatch`, `refreshGeneration`, `loadProjection`, `finishReview`, `subscribe`, and `destroy`. `open` performs base resolution, document load, state load/recovery, reconciliation, and one publish. It accepts injected loaders/stores/time/id functions for tests.

- [ ] **Step 4: Implement top-level screen ownership**

```ts
export type ActiveScreen =
  | { kind: "repository"; controller: AppController; view: RootView }
  | { kind: "branch-review"; controller: ReviewWorkspaceController; view: ReviewWorkspace }
```

`AppScreenController` is the only object allowed to mount/destroy top-level views. It remembers repository focus before mounting review. Repository background routines may continue, but they update the hidden repository model without rendering over Review Workspace.

- [ ] **Step 5: Wire `createApp` and the repository `b` command**

Replace the current `onModeChange("branch")` path with `screenController.openBranchReview()`. Headless `createApp` exposes the screen controller and injected review seams rather than forcing a renderer. Do not remove the old controller Branch Review path yet; Task 13 deletes it after all UI callers migrate.

- [ ] **Step 6: Run focused tests**

Run: `bun test tests/app/screen-controller.test.ts tests/ui/review-workspace/lifecycle.integration.test.ts`  
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/app/create-app.ts src/app/screen-controller.ts src/ui/root-view.ts src/ui/review-workspace/controller.ts src/ui/review-workspace/review-workspace.ts tests/app/screen-controller.test.ts tests/ui/review-workspace/lifecycle.integration.test.ts
git commit -m "feat(review): add dedicated review workspace lifecycle"
```

---

### Task 9: Command catalog, header, file sidebar, and responsive layout

**Files:**
- Create: `src/ui/review-workspace/command-catalog.ts`
- Create: `src/ui/review-workspace/layout.ts`
- Create: `src/ui/review-workspace/header.ts`
- Create: `src/ui/review-workspace/files-pane.ts`
- Modify: `src/ui/review-workspace/review-workspace.ts`
- Modify: `src/ui/review-workspace/controller.ts`
- Create: `tests/ui/review-workspace/command-catalog.test.ts`
- Create: `tests/ui/review-workspace/layout.test.ts`
- Create: `tests/ui/review-workspace/header.test.ts`
- Create: `tests/ui/review-workspace/files-pane.test.ts`
- Create: `tests/ui/review-workspace/navigation.integration.test.ts`

**Interfaces:**
- Consumes: core selectors/intents/progress and existing cell-width/theme primitives.
- Produces: `REVIEW_COMMANDS`, `resolveReviewCommand`, `computeReviewLayout`, `reviewHeaderLines`, `reviewFileRows`.

- [ ] **Step 1: Write command-catalog tests**

Assert exact default keys from the spec, unique key claims per focus context, availability in Aggregate/Since Last/Commit projections, context-aware hints/help, and full keyboard coverage for every mouse action.

- [ ] **Step 2: Write layout/header/sidebar tests**

Test auto split only when the remaining diff viewport fits two 32-cell code columns plus gutters; forced split/stack; collapsed sidebar; narrow/short terminal fallback; CJK-width header truncation; binary counts as `—`; composed coverage and `◆` feedback markers; and all four sidebar filters.

- [ ] **Step 3: Run focused tests and verify failure**

Run: `bun test tests/ui/review-workspace/command-catalog.test.ts tests/ui/review-workspace/layout.test.ts tests/ui/review-workspace/header.test.ts tests/ui/review-workspace/files-pane.test.ts`  
Expected: FAIL because UI modules are absent.

- [ ] **Step 4: Implement one declarative command catalog**

Each command declares id, title, default keys, focus contexts, availability predicate, and intent/effect locus. Menus, hints, and keyboard dispatch render from this table. Use the exact commands in spec §5.4; do not add compatibility keys from old Branch Review.

- [ ] **Step 5: Implement pure layout and text projections**

`computeReviewLayout(width, height, mode, sidebarVisible)` returns header/sidebar/stream/footer rectangles and effective diff mode. `reviewHeaderLines` and `reviewFileRows` return semantic styled spans; they do not mutate boxes or read controllers.

- [ ] **Step 6: Mount header/sidebar/footer and route keyboard/mouse navigation**

Sidebar click dispatches `selection/select-file`. `/` focuses filter, `tab` changes focus, file/hunk keys dispatch core intents, `r` dispatches mark-Viewed only when projection permits it, and `Escape` follows overlay/composer/range/workspace priority.

- [ ] **Step 7: Run focused and integration tests**

Run: `bun test tests/ui/review-workspace/command-catalog.test.ts tests/ui/review-workspace/layout.test.ts tests/ui/review-workspace/header.test.ts tests/ui/review-workspace/files-pane.test.ts tests/ui/review-workspace/navigation.integration.test.ts`  
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/ui/review-workspace tests/ui/review-workspace
git commit -m "feat(review): render review header files and commands"
```

---

### Task 10: Windowed continuous diff stream and context expansion

**Files:**
- Create: `src/ui/review-workspace/row-planner.ts`
- Create: `src/ui/review-workspace/stream-pane.ts`
- Modify: `src/ui/review-workspace/review-workspace.ts`
- Modify: `src/ui/review-workspace/controller.ts`
- Create: `tests/ui/review-workspace/row-planner.test.ts`
- Create: `tests/ui/review-workspace/stream-pane.integration.test.ts`
- Create: `tests/ui/review-workspace/context-expansion.integration.test.ts`

**Interfaces:**
- Consumes: core document/projection/selection/reveal, source-context loader, layout rectangles, existing cell-width/ANSI/theme helpers.
- Produces: `ReviewRow`, `ReviewRowPlan`, `planReviewRows`, `sourceAddressAtViewportRow`, `ReviewStreamPane`.

- [ ] **Step 1: Write failing row-planner tests**

Test document order, file/hunk headers, split and stacked lines, wrapping, CJK/combining width, no-final-newline marker, binary/too-large rows, collapsed gaps, feedback insertion, and exact source addresses. Assert a 10,000-file document with a 40-row viewport plans no more than viewport plus configured overscan rows and does not invoke row builders for off-window files.

- [ ] **Step 2: Write failing stream interaction tests**

Test scrolling updates passive semantic selection, sidebar reveal uses explicit token, `v` selects inclusive source lines across wrapped terminal rows, mouse drag never enters headers/sidebar, resize preserves semantic anchor, and split/stack changes preserve selection.

- [ ] **Step 3: Run focused tests and verify failure**

Run: `bun test tests/ui/review-workspace/row-planner.test.ts tests/ui/review-workspace/stream-pane.integration.test.ts`  
Expected: FAIL because stream modules do not exist.

- [ ] **Step 4: Implement a source-addressed row plan**

```ts
export type ReviewTextSpan = Readonly<{ text: string; style: \"plain\" | \"dim\" | \"addition\" | \"deletion\" | \"hunk\" | \"feedback\" }>
export type ReviewRow = Readonly<{
  kind: "file-header" | "hunk-header" | "diff" | "gap" | "feedback" | "binary" | "too-large"
  fileKey: string
  hunkIndex: number | null
  oldLine: number | null
  newLine: number | null
  text: readonly ReviewTextSpan[]
}>
export type ReviewRowPlan = Readonly<{ start: number; totalRows: number; rows: readonly ReviewRow[] }>
```

Use file/hunk height indexes to seek to the viewport start. Cache per-file height/row fragments by file content id, width, effective mode, line-number setting, wrap setting, expanded gaps, and visible feedback revision.

- [ ] **Step 5: Implement range and mouse mapping through semantic rows**

Only `diff` rows with a non-null source line can enter a range. Wrapped continuations map to the same source line and are deduplicated. Cross-file or cross-side drags are rejected with a visible explanation.

- [ ] **Step 6: Implement generation-qualified gap expansion**

`z` or gap click dispatches an expansion request through the controller. Publish returned lines only when request review id, generation id, file key, and side still match. Cache by content id and source range.

- [ ] **Step 7: Run focused tests**

Run: `bun test tests/ui/review-workspace/row-planner.test.ts tests/ui/review-workspace/stream-pane.integration.test.ts tests/ui/review-workspace/context-expansion.integration.test.ts`  
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/ui/review-workspace tests/ui/review-workspace
git commit -m "feat(review): add windowed continuous diff stream"
```

---

### Task 11: Feedback composer, feedback view, Finish dialog, and export

**Files:**
- Create: `src/ui/review-workspace/feedback-composer.ts`
- Create: `src/ui/review-workspace/feedback-pane.ts`
- Create: `src/ui/review-workspace/finish-dialog.ts`
- Modify: `src/ui/review-workspace/review-workspace.ts`
- Modify: `src/ui/review-workspace/controller.ts`
- Create: `tests/ui/review-workspace/feedback-composer.test.ts`
- Create: `tests/ui/review-workspace/feedback.integration.test.ts`
- Create: `tests/ui/review-workspace/finish-dialog.test.ts`
- Create: `tests/ui/review-workspace/finish.integration.test.ts`

**Interfaces:**
- Consumes: feedback intents, artifact validation/rendering, persistence transaction, existing clipboard adapter.
- Produces: `FeedbackComposer`, `FeedbackPane`, `FinishDialog`, exact UI routes for create/edit/delete/re-anchor/finish/export.

- [ ] **Step 1: Write failing composer and feedback-view tests**

Cover file/range note, new-side suggestion, replacement editor, comment/blocking severity, cancel, draft debounce/flush, edit/delete, next/previous feedback, active/stale/orphaned labels, re-anchor, binary file-level restriction, and keyboard/mouse parity.

- [ ] **Step 2: Write failing Finish tests**

Cover all decision invariants, commit-projection return to Aggregate/Since Last, transaction failure preserving pending state, retry reusing artifact id, deterministic Markdown clipboard text, and successful pending clear after both durable writes.

- [ ] **Step 3: Run focused tests and verify failure**

Run: `bun test tests/ui/review-workspace/feedback-composer.test.ts tests/ui/review-workspace/feedback.integration.test.ts tests/ui/review-workspace/finish-dialog.test.ts tests/ui/review-workspace/finish.integration.test.ts`  
Expected: FAIL because feedback UI modules do not exist.

- [ ] **Step 4: Implement composer focus and draft lifecycle**

`c` opens a composer for the current file or active semantic range. The user selects Note/Suggestion and Comment/Blocking. `Ctrl+S` creates or updates pending feedback, `Escape` cancels, and `tab` stays inside composer controls until close. Suggestions expose replacement text only for a new-side range.

- [ ] **Step 5: Implement feedback filter and re-anchor flow**

Feedback view groups active, stale, and orphaned items in document order. Selecting an active item reveals its anchor. Re-anchor enters range selection and dispatches a validated `feedback/reanchor` intent; delete requires confirmation for a non-empty item.

- [ ] **Step 6: Implement Finish dialog and export**

The dialog displays coverage and pending counts, decision choices, summary input, and exact validation reason. On success call `finishReviewTransaction`, then derive Markdown from the persisted artifact and offer existing clipboard copy. Never render a remote-submission success message.

- [ ] **Step 7: Run focused tests**

Run: `bun test tests/ui/review-workspace/feedback-composer.test.ts tests/ui/review-workspace/feedback.integration.test.ts tests/ui/review-workspace/finish-dialog.test.ts tests/ui/review-workspace/finish.integration.test.ts`  
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/ui/review-workspace tests/ui/review-workspace
git commit -m "feat(review): add pending feedback and review submission"
```

---

### Task 12: Background generation refresh and actionable error states

**Files:**
- Modify: `src/ui/review-workspace/controller.ts`
- Modify: `src/ui/review-workspace/review-workspace.ts`
- Modify: `src/app/create-app.ts`
- Create: `src/ui/review-workspace/error-state.ts`
- Create: `tests/ui/review-workspace/refresh.integration.test.ts`
- Create: `tests/ui/review-workspace/error-state.test.ts`
- Create: `tests/review/git/history-rewrite.integration.test.ts`

**Interfaces:**
- Consumes: existing refs watcher/background refresher, `loadReviewDocument`, `reconcileReviewState`, qualified async request contracts.
- Produces: `ReviewWorkspaceController.refreshGeneration`, `ReviewWorkspaceError`, background refresh routing while review is active.

- [ ] **Step 1: Write failing refresh-race tests**

Test slow generation A followed by fast generation B, source result from old generation, failed parse retaining last complete document, changed file invalidation, unchanged file preservation, draft survival, feedback stale/orphaned states, and hidden repository refresh not repainting the review screen.

- [ ] **Step 2: Write failing error-state tests**

Cover invalid base picker, successful empty diff, detached snapshot, history rewritten, binary/too-large file, corrupt v2 quarantine, unsupported patch, Git command failure, and mutable-state persistence failure. Assert each has specific title/body/action rather than a generic banner.

- [ ] **Step 3: Run focused tests and verify failure**

Run: `bun test tests/ui/review-workspace/refresh.integration.test.ts tests/ui/review-workspace/error-state.test.ts tests/review/git/history-rewrite.integration.test.ts`  
Expected: FAIL because refresh/error contracts are incomplete.

- [ ] **Step 4: Implement monotonic request qualification and atomic swap**

Every controller request captures `{ requestId, reviewId, generationId }`. A document refresh validates identity, computes reconciliation off-screen, then publishes once. Failure updates error state only; `state.document` remains the last complete generation.

- [ ] **Step 5: Route ref watcher events by active screen**

While Branch Review is active, refs movement schedules one coalesced review generation refresh and separately refreshes the hidden repository controller. Index-only working-tree changes do not reload Branch Review. Busy/composer state does not suppress refresh; reconciliation preserves the draft.

- [ ] **Step 6: Implement typed actionable errors**

```ts
export type ReviewWorkspaceError = Readonly<{
  kind: "invalid-base" | "history-rewritten" | "git" | "parse" | "source" | "storage" | "corrupt-state"
  title: string
  detail: string
  action: "choose-base" | "retry" | "dismiss" | "open-feedback"
}>
```

Empty review and detached snapshot are status states, not errors.

- [ ] **Step 7: Run focused tests**

Run: `bun test tests/ui/review-workspace/refresh.integration.test.ts tests/ui/review-workspace/error-state.test.ts tests/review/git/history-rewrite.integration.test.ts`  
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/app/create-app.ts src/ui/review-workspace tests/ui/review-workspace tests/review/git/history-rewrite.integration.test.ts
git commit -m "feat(review): reconcile live branch generations safely"
```

---

### Task 13: Cleanly remove the old Branch Review implementation

**Files:**
- Delete: `src/git/branch-review.ts`
- Delete: `src/review/fingerprint.ts`
- Delete: `src/review/store.ts`
- Create: `src/review/working-tree-fingerprint.ts`
- Create: `src/review/working-tree-store.ts`
- Modify: `src/domain/review-target.ts`
- Modify: `src/app/controller.ts`
- Modify: `src/domain/repository.ts`
- Modify: `src/ui/root-view.ts`
- Modify: `src/ui/bindings.ts`
- Modify: `src/ui/panes/status-pane.ts`
- Modify: `src/ui/panes/files-pane.ts`
- Delete or rewrite: `tests/app/controller-branch.test.ts`
- Delete or rewrite: `tests/app/commit-drilldown.test.ts`
- Delete: `tests/review/fingerprint.test.ts`
- Delete: `tests/review/store.test.ts`
- Delete: `tests/review/invalidation.integration.test.ts`
- Create: `tests/review/working-tree-fingerprint.test.ts`
- Create: `tests/review/working-tree-store.integration.test.ts`
- Create: `tests/review/working-tree-invalidation.integration.test.ts`
- Delete: `tests/git/branch-review.integration.test.ts`
- Modify: Branch Review assertions in `tests/ui/bindings.test.ts`, `tests/app/log-actions.test.ts`, `tests/acceptance/review-workflow.integration.test.ts`, and `tests/acceptance/lazygit-core-ui.test.ts`

**Interfaces:**
- Consumes: completed Review Workspace and screen controller.
- Produces: one Branch Review entry path with no old exported symbols, model fields, state reader, UI guards, or compatibility behavior; preserves Working Tree/Stash coverage through a restricted store.

- [ ] **Step 1: Write cutover and Working Tree/Stash regression tests**

Create `tests/review/cutover.test.ts` that imports the new public entry interfaces and exercises repository-to-review lifecycle. Add regression tests proving Working Tree and Stash files still move through not-reviewed, reviewing, reviewed, and changed-after-review states after storage isolation. The restricted fingerprint API must reject a Branch Review target at compile time.

- [ ] **Step 2: Introduce the restricted Working Tree/Stash store**

Move the reusable tuple hashing and non-branch fingerprint logic into:

```ts
export type MutableReviewTarget =
  | Extract<ReviewTarget, { kind: "working-tree" }>
  | Extract<ReviewTarget, { kind: "stash" }>

export function workingTreeTargetKey(target: MutableReviewTarget): string
export function fingerprintWorkingTreeFile(target: MutableReviewTarget, file: FilePatchInput): string
```

`WorkingTreeReviewStore` uses `.git/githunk/working-tree-review-state-v1.json`, accepts only the existing review-progress database shape for mutable/stash targets, and starts empty. It never reads or migrates the combined `review-state-v1.json`.

- [ ] **Step 3: Remove old controller/model ownership and migrate all callers**

Delete Branch Review loader options, fields, methods, cursor, summaries, mode switching, mutation guards, and commit-child preservation from `AppController` and repository domain types. Remove the `branch` variant from `src/domain/review-target.ts`. Repository `b` remains a screen action owned by `AppScreenController`; ordinary controller knows nothing about Branch Review. Wire Working Tree and Stash status paths to `WorkingTreeReviewStore`.

- [ ] **Step 4: Remove old root-view and pane branches**

Delete every `reviewTarget.kind === "branch"`, `"Branch Review is read-only"`, old review marker/status summary, and Branch Review commit drill-down branch. Working-tree and stash read-only rules remain where still valid.

- [ ] **Step 5: Delete old implementation files and obsolete tests**

Delete the exact legacy files listed above. Rewrite acceptance tests to assert dedicated workspace behavior, not old model internals. Do not retain adapters or aliases to satisfy old fixtures.

- [ ] **Step 6: Run affected focused suites**

Run: `bun test tests/review/cutover.test.ts tests/review/working-tree-fingerprint.test.ts tests/review/working-tree-store.integration.test.ts tests/review/working-tree-invalidation.integration.test.ts tests/app tests/ui/bindings.test.ts tests/acceptance/review-workflow.integration.test.ts tests/acceptance/lazygit-core-ui.test.ts`
Expected: PASS with no old Branch Review assertion remaining and unchanged Working Tree/Stash coverage behavior.

- [ ] **Step 7: Run TypeScript diagnostics**

Run: `bun run typecheck`  
Expected: PASS with zero references to deleted Branch Review exported types.

- [ ] **Step 8: Commit**

```bash
git add -A src tests
git commit -m "refactor(review): remove legacy branch review mode"
```

---

### Task 14: Shared conformance corpus and performance guardrails

**Files:**
- Create: `tests/review/conformance/corpus.ts`
- Create: `tests/review/conformance/patch-adapter.conformance.test.ts`
- Create: `tests/review/conformance/core-document.conformance.test.ts`
- Create: `tests/review/conformance/row-planner.conformance.test.ts`
- Create: `tests/fixtures/review/conformance/` fixture files
- Create: `benchmarks/review-document-load.ts`
- Create: `benchmarks/review-row-plan.ts`
- Create: `benchmarks/review-reconcile.ts`
- Create: `benchmarks/results/branch-review-workspace-baseline.json` from measured Task 14 output
- Modify: `package.json`

**Interfaces:**
- Consumes: patch adapter, core document/anchors, row planner, reconciliation.
- Produces: one shared semantic-address fixture vocabulary and repeatable benchmark commands.

- [ ] **Step 1: Define the shared conformance contract**

Each case contains patch/raw/numstat input plus expected file keys, hunk ranges, source addresses, gaps, content-id relationships, and row-address relationships. Include CRLF, no-final-newline, CJK, combining marks, long lines, binary, mode-only, rename, copy, delete, empty diff, and ambiguous context.

- [ ] **Step 2: Register all three consumers against the same cases**

The parser suite asserts document facts, core suite asserts anchors/gaps, and row planner suite asserts screen rows map back to the same expected source addresses. Do not duplicate expected values in three files; import the same corpus.

- [ ] **Step 3: Run conformance tests**

Run: `bun test tests/review/conformance`  
Expected: PASS for every registered consumer and fixture.

- [ ] **Step 4: Add allocation-aware benchmark entry points**

Add scripts:

```json
{
  "bench:review-load": "bun run benchmarks/review-document-load.ts",
  "bench:review-rows": "bun run benchmarks/review-row-plan.ts",
  "bench:review-reconcile": "bun run benchmarks/review-reconcile.ts"
}
```

Each benchmark reports fixture size, elapsed time, heap delta, and output count. Row planning asserts output rows are bounded by viewport plus overscan; reconciliation reports matched/changed/orphaned counts.

- [ ] **Step 5: Run and record the first workstation baseline**

Run: `bun run bench:review-load && bun run bench:review-rows && bun run bench:review-reconcile`  
Expected: all commands exit zero and print structured measurements. Save the measured values under `benchmarks/results/branch-review-workspace-baseline.json`; do not invent thresholds before this run.

- [ ] **Step 6: Commit**

```bash
git add tests/review/conformance tests/fixtures/review/conformance benchmarks package.json bun.lock
git commit -m "test(review): add shared conformance and performance corpus"
```

---

### Task 15: End-to-end acceptance, documentation cutover, and final verification

**Files:**
- Create: `tests/acceptance/branch-review-workspace.integration.test.ts`
- Create: `tests/acceptance/branch-review-artifact.integration.test.ts`
- Modify: `docs/githunk-prd-v0.1.md`
- Modify: `docs/superpowers/specs/2026-08-24-githunk-review-shell-ux-design.md`
- Modify: `docs/release-checklist-v0.1.md`
- Modify: `CLAUDE.md` only if its test-directory or command inventory must include the new review suites

**Interfaces:**
- Consumes: the complete feature.
- Produces: observable proof for every acceptance criterion and current project documentation with no stale old-Branch-Review contract.

- [ ] **Step 1: Write the end-to-end coverage/reconciliation acceptance test**

Use a real temporary repository and real UI harness:

1. create base plus a feature branch with multiple files and commits;
2. press `b` and assert the dedicated workspace header;
3. mark files Viewed and persist;
4. close/reopen and assert restoration;
5. add a commit changing one viewed and one unreviewed file;
6. trigger ref refresh;
7. assert only the changed viewed file is invalidated;
8. select Since Last Review and assert the delta projection;
9. assert no mutation Git command was recorded.

- [ ] **Step 2: Write the end-to-end feedback/artifact acceptance test**

Use keyboard and mouse to create a multiline blocking suggestion plus a comment, finish Request Changes, inspect the immutable JSON, compare deterministic Markdown clipboard text, restart, and assert `lastSubmission`. Inject the step-4 transaction failure and assert recovery reuses one artifact id.

- [ ] **Step 3: Run the new acceptance tests**

Run: `bun test tests/acceptance/branch-review-workspace.integration.test.ts tests/acceptance/branch-review-artifact.integration.test.ts`  
Expected: PASS.

- [ ] **Step 4: Update project documentation for the breaking cutover**

Mark old Branch Review sections as superseded by the approved spec, document the dedicated workspace keys and local artifact paths, state that v1 review progress is intentionally not migrated, and add the behavioral smoke steps to the release checklist. Do not duplicate the full spec.

- [ ] **Step 5: Run typecheck and the complete test suite**

Run: `bun run typecheck && bun test`  
Expected: both commands exit zero; no skipped/newly focused test hides failures.

- [ ] **Step 6: Run the actual TUI smoke scenario**

Launch: `bun run src/main.ts` in a fixture repository with committed `base...HEAD` changes. Observe all eight steps from spec §16.5, including real JSON/Markdown output, one-file invalidation after a new commit, Since Last Review, and restart restoration. Confirm working-tree changes never enter the Branch Review document.

- [ ] **Step 7: Run documentation and patch hygiene checks**

Run: `git diff --check`  
Expected: no whitespace errors. Search repository references with the built-in search tool before execution handoff for `BranchReviewSnapshot`, `branchReviewTarget`, `review-state-v1`, and `Branch Review is read-only`; expected production references: zero, except historical/superseded documentation that explicitly names the removed contract.

- [ ] **Step 8: Commit**

```bash
git add tests/acceptance docs CLAUDE.md
git commit -m "feat(review): complete branch review workspace cutover"
```

- [ ] **Step 9: Request final code review**

Use the `requesting-code-review` skill against the complete branch. Require the reviewer to compare implementation to all 21 acceptance criteria in the spec, inspect the legacy deletion boundary, and verify the actual TUI smoke evidence before integration.
