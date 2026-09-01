# Hunk React Review Renderer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Replace Githunk's imperative Branch Review stream renderer with a Hunk-derived React/OpenTUI review renderer that preserves Githunk review semantics while matching Hunk's split/stack, viewport, highlight, and teardown behavior.

**Architecture:** Keep Githunk's renderer-neutral review core, Git document loading, reconciliation, persistence, feedback, and artifact workflow. Add a React/OpenTUI review surface mounted beside the existing imperative repository `RootView`; adapt `ReviewDocument`/`ReviewState` into Hunk-style diff rows and route UI actions back through Githunk intents. Port the production Hunk review-rendering patterns (`DiffPane`/`DiffSection`/code rows, persistent `scrollbox` with `viewportCulling`, effect-owned highlight loading, bounded worker/cache lifecycle), not Hunk's CLI/session/extension app shell.

**Tech Stack:** Bun, TypeScript 5.9, React 19, `@opentui/core` 0.5.6, `@opentui/react`, `@pierre/diffs` 1.3.5, Bun Worker, Bun test.

**Spec:** `docs/superpowers/specs/2026-08-27-branch-review-workspace-design.md`, with the approved scope of Hunk React review renderer plus existing Githunk app/core.

## Global Constraints

- Branch Review remains read-only with respect to the Git repository.
- `src/review/core` remains renderer- and dependency-neutral; no React, OpenTUI, Pierre, filesystem, Git runner, or Zod imports enter core.
- Do not import runtime source files from `learn-projects/hunk`; adapt the source into Githunk-owned modules so the submodule remains a reference project.
- Do not port Hunk `AppHost`, session broker, extension runtime, startup/reload protocol, or VCS shell.
- Use Hunk production `DiffPane` behavior, not the non-scrollable `HunkReviewStream` demo surface, for multi-file documents.
- Keep all row planning windowed and use persistent OpenTUI scroll containers; never materialize the complete 23k-line review into mounted renderables.
- Async document, highlight, source, and worker results must be qualified by review identity, generation, request token, and component lifetime before publication.
- Worker startup/posting failures, worker runtime errors, timeouts, and teardown must settle every pending request; no promise may keep the process alive.
- Every behavior change gets a failing focused test before production implementation. Skip formatters, linters, and project-wide suites until final verification.

---

### Task 1: React/OpenTUI runtime and screen mount boundary

**Files:**
- Modify: `package.json`
- Modify: `tsconfig.json`
- Modify: `bun.lock` through the package manager
- Create: `src/ui/review-workspace/react-review-host.tsx`
- Modify: `src/app/screen-controller.ts`
- Modify: `src/app/create-app.ts`
- Test: `tests/app/screen-controller.test.ts`
- Create: `tests/ui/review-workspace/react-review-host.integration.test.tsx`

**Interfaces:**
- `ReactReviewHost` exposes `destroy(): void`, `root`, and the review controller it mounts.
- `createReviewView` returns the host type accepted by `AppScreenController`; the repository view remains an imperative `RootView`.
- The host creates one `@opentui/react` root for the existing `CliRenderer`, renders one review workspace component, and unmounts it before releasing review-specific resources.

- [ ] **Step 1: Write the failing mount/unmount test**

  Mount a minimal host with `createTestRenderer`, assert a review root is present after the asynchronous React commit, call `destroy()`, flush, and assert the review root is no longer mounted. Also assert repeated destroy is harmless.

- [ ] **Step 2: Run the focused test and observe the expected dependency or export failure**

  Run `bun test tests/ui/review-workspace/react-review-host.integration.test.tsx tests/app/screen-controller.test.ts`.

- [ ] **Step 3: Add React/OpenTUI dependencies and JSX compiler settings**

  Add runtime `react` and `@opentui/react` versions compatible with the installed `@opentui/core`; add React typings as development dependencies; include `src/**/*.tsx` and `tests/**/*.tsx` and set `jsx: "react-jsx"`, `jsxImportSource: "@opentui/react"`, and React/Bun types in TypeScript configuration.

- [ ] **Step 4: Implement the host and screen ownership**

  Create the React root once per review screen. In `destroy()`, mark the host closed, unmount the React tree, dispose the review renderer resources, then let `AppScreenController` restore the repository view. Do not call `destroyRecursively()` on a child that the renderer still owns.

- [ ] **Step 5: Run the focused mount/lifecycle tests and verify they pass**

- [ ] **Step 6: Commit the toolchain and mount boundary**

  Commit message: `refactor(review): mount branch review through OpenTUI React`

---

### Task 2: Adapt Githunk review documents to Hunk-style diff files

**Files:**
- Create: `src/ui/review-workspace/hunk-review-model.ts`
- Modify: `src/review/git/load-review-document.ts`
- Modify: `src/review/git/load-review-projection.ts`
- Test: `tests/review/git/load-review-document.integration.test.ts`
- Create: `tests/ui/review-workspace/hunk-review-model.test.ts`

**Interfaces:**
- `ReviewSourceLoader` is `{ readonly read: (side: "old" | "new", file: ReviewFile) => Promise<readonly string[]> }`; it is optional and never enters `src/review/core`.
- `HunkReviewFile` is a renderer-local immutable `{ readonly id: string; readonly path: string; readonly previousPath?: string; readonly kind: ReviewFile["kind"]; readonly metadata: FileDiffMetadata; readonly sourceLoader?: ReviewSourceLoader }`.
- `toHunkReviewFile(file: ReviewFile, sourceLoader?: ReviewSourceLoader): HunkReviewFile` returns a renderer-local immutable model containing file identity, Pierre-compatible metadata, old/new line arrays, hunk content groups, and optional source readers.
- `toHunkReviewFiles(document, options)` preserves document file order and stable `file.key` identity.
- Binary, mode-only, deleted, added, rename, no-final-newline, and too-large states remain explicit; no renderer guesses source lines for unavailable files.

- [ ] **Step 1: Write failing adapter tests**

  Cover a modified file whose contiguous deletion/addition block must become one change group, a context block shared by both sides, a rename retaining `previousPath`, a binary file with no line rows, and a deleted file with only an old source side.

- [ ] **Step 2: Run the adapter tests and verify the model is not implemented**

- [ ] **Step 3: Implement the renderer-local adapter**

  Build Pierre-compatible metadata once per stable `ReviewFile`/`contentId`, cache it by document file identity, and preserve the normalized hunk boundaries from Githunk. Attach qualified old/new blob readers using the existing Git source-context boundary; keep these readers outside `src/review/core`.

- [ ] **Step 4: Add source-backed loading for syntax context**

  Use the file blob OIDs already loaded into `ReviewFile`; stat and read blobs through the existing bounded source loader, normalize CRLF consistently, and return unavailable/too-large outcomes without throwing into the visible raw diff.

- [ ] **Step 5: Run the adapter and source tests and verify they pass**

- [ ] **Step 6: Commit the renderer-local model**

  Commit message: `feat(review): adapt documents to Hunk diff rows`

---

### Task 3: Port Hunk pure row planning and split/stack geometry

**Files:**
- Create: `src/ui/review-workspace/hunk-diff-row-model.ts`
- Create: `src/ui/review-workspace/hunk-diff-rows.ts`
- Create: `src/ui/review-workspace/hunk-code-columns.ts`
- Create: `src/ui/review-workspace/hunk-styled-span-layout.ts`
- Retire after cutover: `src/ui/review-workspace/row-planner.ts`
- Retire after cutover: `src/ui/review-workspace/stream-pane.ts`
- Test: `tests/ui/review-workspace/row-planner.test.ts`
- Test: `tests/ui/review-workspace/row-planner-highlight.test.ts`
- Create: `tests/ui/review-workspace/hunk-diff-rows.test.ts`
- Create: `tests/ui/review-workspace/hunk-diff-columns.test.ts`

**Interfaces:**
- `buildHunkSplitRows(file, state, highlights, options): readonly HunkDiffRow[]` pairs contiguous deletion/addition blocks into left/right cells, pads the shorter side, and leaves context on both sides.
- `buildHunkStackRows(file, state, highlights, options): readonly HunkDiffRow[]` emits context, deletion, and addition rows in unified order with correct old/new gutters.
- `resolveHunkSplitCellGeometry` and `resolveHunkStackCellGeometry` return fixed gutter/content widths from terminal cells, never UTF-16 lengths.
- Each row has a stable key, file key, hunk index, source addresses, rendered spans, and optional feedback insertion metadata.

- [ ] **Step 1: Write failing split/stack behavior tests**

  Assert that a hunk with two deletions and one addition produces two split rows: the second left cell is deletion and the second right cell is empty. Assert that a context row has both source numbers, stack rows preserve deletion-before-addition ordering, line numbers advance independently, and a long CJK/tab line is measured by terminal cells.

- [ ] **Step 2: Run the row tests and confirm current planner fails**

  The current `row-planner.ts` must fail the split assertion because it emits one unified row even when `effectiveMode` is `split`.

- [ ] **Step 3: Implement Hunk-derived pure row model and geometry**

  Port the data-level behavior from Hunk `diffRowModel.ts`, `diffRows.ts`, `codeColumns.ts`, and styled-span layout without importing Hunk modules. Keep Githunk feedback rows and gap rows as explicit row variants. Preserve current source-address APIs through an adapter so range selection and feedback anchoring remain semantic.

- [ ] **Step 4: Add stable row memoization**

  Cache per-file geometry and rows by `contentId`, layout, width, wrapping, expanded gaps, feedback revision, and highlight snapshot identity. Do not include selection-only changes in the geometry key.

- [ ] **Step 5: Run focused row/geometry tests and verify they pass**

- [ ] **Step 6: Commit the Hunk-derived row model**

  Commit message: `feat(review): add Hunk split and stack row planning`

---

### Task 4: React review stream with persistent viewport culling

**Files:**
- Create: `src/ui/review-workspace/components/ReviewDiffRow.tsx`
- Create: `src/ui/review-workspace/components/ReviewDiffSection.tsx`
- Create: `src/ui/review-workspace/components/ReviewDiffPane.tsx`
- Create: `src/ui/review-workspace/components/ReviewWorkspaceApp.tsx`
- Modify: `src/ui/review-workspace/header.ts`
- Modify: `src/ui/review-workspace/files-pane.ts`
- Modify: `src/ui/review-workspace/feedback-pane.ts`
- Modify: `src/ui/review-workspace/feedback-composer.ts`
- Modify: `src/ui/review-workspace/finish-dialog.ts`
- Test: `tests/ui/review-workspace/real-surface.integration.test.ts`
- Create: `tests/ui/review-workspace/react-review-workspace.integration.test.tsx`
- Create: `tests/ui/review-workspace/react-diff-pane.integration.test.tsx`

**Interfaces:**
- `ReviewWorkspaceApp` receives the Githunk controller, options, and close callback; it owns focus, layout mode, sidebar visibility, selection reveal, feedback overlays, and finish dialog state.
- `ReviewDiffPane` receives renderer-local files, selected file/hunk, layout, width/height, expanded gaps, and highlight snapshots; it renders one persistent `scrollbox` with `scrollY` and `viewportCulling`.
- Row callbacks dispatch Githunk intents only; no component invokes Git mutation APIs.

- [ ] **Step 1: Write failing React surface tests**

  Render a three-file document and assert the sidebar, header, and persistent diff scrollbox exist. Assert split mode places deletion and addition text in different columns, stack mode emits unified rows, selecting a file reveals its section, and scrolling keeps mounted row count bounded by viewport plus overscan.

- [ ] **Step 2: Run the surface tests and observe missing component/module failures**

- [ ] **Step 3: Implement row and section components**

  Port Hunk's `DiffRowView`/`CodeRowView` structure using Githunk row types and OpenTUI React styled text. Keep file headers, hunk headers, collapsed gaps, binary/too-large explanations, and feedback rows in the same stream. Use stable keys from file/content/hunk/line identity.

- [ ] **Step 4: Implement the persistent diff pane**

  Use Hunk's `scrollbox` contract. Measure complete file section heights through pure geometry, mount only intersecting sections/rows plus bounded overscan, keep spacer heights for skipped sections, debounce viewport reads, and clamp reveal targets before applying scroll. Never replace the scrollbox with a new text buffer on every render.

- [ ] **Step 5: Implement the workspace shell**

  Port current header/sidebar/footer behavior into React components. Keep feedback composer and finish dialog semantics, but make open/close state explicit React state. Route Escape in priority order: composer/dialog, range, filter, workspace close.

- [ ] **Step 6: Run focused React surface tests and verify they pass**

- [ ] **Step 7: Commit the React review surface**

  Commit message: `feat(review): render branch review through Hunk React panes`

---

### Task 5: Hunk highlight hook, cache, worker, and source qualification

**Files:**
- Create: `src/ui/review-workspace/hooks/useReviewHighlights.ts`
- Modify: `src/review/git/highlight/highlight-worker-client.ts`
- Modify: `src/review/git/highlight/highlight-worker.ts`
- Modify: `src/review/git/highlight/highlight-adapter.ts`
- Modify: `src/review/git/highlight/highlight-cache.ts`
- Retire after cutover: highlight orchestration in `src/ui/review-workspace/controller.ts`
- Test: `tests/ui/review-workspace/highlight-controller.test.ts`
- Test: `tests/ui/review-workspace/highlight.integration.test.ts`
- Create: `tests/ui/review-workspace/highlight-worker-lifecycle.test.ts`

**Interfaces:**
- `useReviewHighlights` accepts stable renderer-local files, theme, selected/visible file IDs, and an enabled flag; it returns an immutable map of per-file highlight payloads plus loading/error state.
- `highlightInWorker` serializes requests through one reusable worker, rejects on startup/post/runtime failure, and supports `disposeHighlightWorker()` that settles active and queued requests.
- Highlight cache keys include file content identity, generation/review identity, language/theme, and source-context identity.

- [ ] **Step 1: Write failing async/lifecycle tests**

  Assert duplicate visible-file requests share one promise, a stale generation result cannot enter the current map, an unresponsive worker times out to plain rows, worker errors reject all pending callers, and disposing the worker lets a short Bun process exit.

- [ ] **Step 2: Run the focused tests and verify they fail against the current controller/client**

- [ ] **Step 3: Port Hunk's effect-owned highlight scheduling**

  Start loads only from React effects/prefetch callbacks, not during render. Keep a map of in-flight promises keyed by the complete highlight identity. Cancel or ignore results when the effect cleanup, review identity, generation, or request token changes.

- [ ] **Step 4: Port Hunk worker queue safety**

  Add a protocol version, serialized active request, guarded `postMessage`, `onerror` reset, bounded timeout, `unref`, and complete queue rejection on dispose. Use the existing payload boundary; do not transfer HAST trees for oversized files without the configured limit.

- [ ] **Step 5: Keep syntax work bounded**

  Reuse the 10,000 changed-line ceiling, skip binary/generated/non-code files according to the renderer policy, prefer the Hunk `shiki-wasm` path, and return plain rows immediately when highlighting declines or fails.

- [ ] **Step 6: Run focused highlight and worker tests and verify they pass**

- [ ] **Step 7: Commit highlight lifecycle changes**

  Commit message: `fix(review): bound React highlight lifecycle and worker shutdown`

---

### Task 6: Controller and input cutover

**Files:**
- Modify: `src/app/screen-controller.ts`
- Modify: `src/app/create-app.ts`
- Modify: `src/ui/review-workspace/controller.ts`
- Modify: `src/ui/review-workspace/command-catalog.ts`
- Modify: `src/ui/root-view.ts`
- Retire: `src/ui/review-workspace/review-workspace.ts`
- Retire: `src/ui/review-workspace/stream-pane.ts`
- Test: `tests/app/screen-controller.test.ts`
- Test: `tests/app/create-app.test.ts`
- Test: `tests/ui/review-workspace/lifecycle.integration.test.ts`
- Test: `tests/ui/review-workspace/navigation.integration.test.ts`

**Interfaces:**
- Only the active review React root receives review commands; hidden repository bindings cannot mutate review state or repaint over it.
- `AppScreenController.closeBranchReview()` unmounts React before restoring `RootView`; app shutdown unmounts the active review root before renderer destruction.
- `ReviewWorkspaceController.destroy()` invalidates document/highlight/source request tokens and disposes review-local resources without touching repository mutations.

- [ ] **Step 1: Write failing cutover tests**

  Exercise repeated open/close with the real renderer, assert one repository handler and one review root, assert background repository refreshes do not repaint the review root, and assert shutdown produces no OpenTUI child-removal error or live worker.

- [ ] **Step 2: Run the lifecycle tests and confirm the current imperative cutover fails at least one assertion**

- [ ] **Step 3: Move command routing to the React workspace host**

  Remove the old direct `renderer.keyInput` listener from the imperative workspace. Let one active host own review keyboard/mouse routing and let the repository RootView remain gated while hidden.

- [ ] **Step 4: Remove obsolete imperative stream paths**

  Delete dead row-planner/stream-pane/highlight painter code only after every caller and test has migrated. Keep semantic feedback/controller APIs that the React surface still consumes.

- [ ] **Step 5: Run focused lifecycle/navigation tests and verify they pass**

- [ ] **Step 6: Commit the cutover**

  Commit message: `refactor(review): complete React workspace cutover`

---

### Task 7: Real large-branch verification and cleanup

**Files:**
- Modify: `tests/ui/review-workspace/real-surface.integration.test.ts`
- Create: `tests/ui/review-workspace/large-branch.integration.test.tsx`
- Modify: `benchmarks/review-row-plan.ts`
- Create: `benchmarks/review-react-surface.tsx`
- Modify: `docs/release-checklist-v0.1.md`

- [ ] **Step 1: Write the failing 163-file/23k-line surface scenario**

  Load the current branch document through the real Git runner, mount the React workspace at 100x30, assert the first frame is available before all highlights finish, exercise split/stack, file navigation, wheel scroll, range selection, and close, and assert the process has no active review worker afterward.

- [ ] **Step 2: Run the scenario and record the expected failure or hang signature before the cutover**

- [ ] **Step 3: Add bounded performance instrumentation**

  Measure first paint, visible row count, mounted section count, highlight completion, scroll latency, and teardown. Keep benchmark output deterministic and do not establish a threshold without observing the new implementation.

- [ ] **Step 4: Run the real scenario after the cutover and verify no render error/hang**

  Use a real TTY smoke for `bun run src/main.ts`, press `b`, inspect split/stack and a TypeScript file, scroll, press Escape, and terminate through the normal app path.

- [ ] **Step 5: Run applicable review tests and typecheck**

  Run focused review/React suites first, then `bun run typecheck` and the project test suite once. No formatter/linter runs inside earlier tasks.

- [ ] **Step 6: Update release checklist with the verified React review smoke**

- [ ] **Step 7: Review the final diff for stale imperative paths, unused dependencies, comments, and worker leaks**

- [ ] **Step 8: Commit final verification and cleanup**

  Commit message: `test(review): verify React workspace on large branch`
