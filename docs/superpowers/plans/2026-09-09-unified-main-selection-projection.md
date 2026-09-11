# Unified Main Selection Projection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Resolve every main-pane mouse selection against the exact installed text-buffer projection and make copy, stage and discard consume one semantic selection.

**Architecture:** A pure projection resolver maps OpenTUI native ranges to text or raw `DiffDocument` selections. Eager, ANSI, plain and bounded virtual renderers publish the exact installed buffer plus non-overlapping source segments; `main-pane.ts` owns the active projection generation and semantic selection. `RootView` captures that selection during mouse gestures and removes its current pointer/native/source priority ladder.

**Tech Stack:** Bun, strict TypeScript, OpenTUI renderer/test harness.

**Spec:** `docs/superpowers/specs/2026-09-09-unified-main-selection-projection.md`

## Global Constraints

- Do not add runtime dependencies.
- Preserve `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, readonly fields and readonly array parameters.
- Use `...(x === undefined ? {} : { x })` for optional fields.
- Projection text must be exactly the string installed in the active `TextRenderable`; never reconstruct it in the copy action.
- Virtual projection work must remain bounded by the rendered window, not total diff size.
- Clean cutover: migrate all callers and remove `selectionFromRenderable`, `RenderableCopySource`, `resolveRenderableCopySelection`, `getMainPaneCopySource`, `VirtualMainPane.nativeCopySource`, virtual pointer selection APIs and obsolete tests.
- Preserve existing copy-mode semantics and OSC52 evidence wording.
- This repairs a githunk review extension; the lazygit compatibility matrix remains unchanged.

---

### Task 1: Pure selection projection resolver

**Files:**

- Create: `src/domain/diff/selection-projection.ts`
- Modify: `src/domain/diff/selection.ts`
- Modify: `tests/domain/diff/selection.test.ts`

**Interfaces:**

- Consumes: `DiffDocument`, `DisplaySourceSegment` and `DocumentSelection`.
- Produces: `NativeSelectionRange`, `MainSelectionProjection`, `MainSelectionProjectionSegment`, `MainSelection`, `resolveMainSelection()` and eager/text projection builders.

- [ ] **Step 1: Replace reconstructed-source tests with failing projection tests**

In `tests/domain/diff/selection.test.ts`, remove tests whose only contract is `selectionFromRenderable(document, ..., prefix)`. Add behavior tests around a projection whose `text` is the exact selected buffer:

```ts
const projection: MainSelectionProjection = {
  generation: 1,
  document: value,
  text: "commit abc\n  1 +new\n",
  segments: [
    { kind: "text", displayStartUtf16: 0, displayEndUtf16: 11 },
    { kind: "decoration", displayStartUtf16: 11, displayEndUtf16: 15 },
    {
      kind: "document",
      displayStartUtf16: 15,
      displayEndUtf16: 20,
      rawStartUtf16: addition.startUtf16,
      rawEndUtf16: addition.startUtf16 + 5,
      lineIndex: additionIndex
    }
  ]
}

expect(resolveMainSelection(projection, { start: 16, end: 19 }, "new")).toMatchObject({
  valid: true,
  kind: "document",
  selection: { startUtf16: addition.startUtf16 + 1, endUtf16: addition.startUtf16 + 4 }
})

expect(resolveMainSelection(projection, { start: 7, end: 10 }, "abc")).toEqual({
  valid: true,
  kind: "text",
  text: "abc"
})
```

Also cover reversed ranges, UTF-8 offsets with `提交🙂` before the selected text, a range containing decoration plus document text, a preamble/diff boundary returning text, decoration-only rejection and a mismatched selected string.

- [ ] **Step 2: Run the domain test and verify RED**

Run:

```bash
bun test tests/domain/diff/selection.test.ts
```

Expected: compile failure because `selection-projection.ts` and `resolveMainSelection` do not exist.

- [ ] **Step 3: Implement the projection types and exact-range normalization**

Create `src/domain/diff/selection-projection.ts` with these public contracts:

```ts
export type NativeSelectionRange = {
  readonly start?: number
  readonly end?: number
  readonly anchor?: number
  readonly focus?: number
  readonly unit?: "utf16" | "utf8"
}

export type MainSelectionProjectionSegment =
  | { readonly kind: "document"; readonly displayStartUtf16: number; readonly displayEndUtf16: number; readonly rawStartUtf16: number; readonly rawEndUtf16: number; readonly lineIndex: number }
  | { readonly kind: "text"; readonly displayStartUtf16: number; readonly displayEndUtf16: number }
  | { readonly kind: "decoration"; readonly displayStartUtf16: number; readonly displayEndUtf16: number }

export type MainSelectionProjection = {
  readonly generation: number
  readonly text: string
  readonly segments: readonly MainSelectionProjectionSegment[]
  readonly document?: DiffDocument
}

export type MainSelection = { readonly valid: true; readonly kind: "document"; readonly selection: DocumentSelection } | { readonly valid: true; readonly kind: "text"; readonly text: string } | { readonly valid: false; readonly reason: "native/display selection mismatch" }
```

Implement one normalizer that tries explicit UTF-8 only when `unit === "utf8"`; otherwise try UTF-16 first and UTF-8 second. A candidate is valid only when `projection.text.slice(startUtf16, endUtf16) === selectedText`. Do not search for `selectedText` elsewhere.

Resolve overlaps in display order. Any text overlap returns `{ valid: true, kind: "text", text: selectedText }`. Otherwise, ignore decoration, calculate raw bounds from document segment overlap, and derive `fileIndex`/`hunkIndex` from the first overlapping segment's `lineIndex`. Reject when there is no text or document overlap.

- [ ] **Step 4: Implement projection builders without rendering dependencies**

Add:

```ts
export function textSelectionProjection(generation: number, text: string): MainSelectionProjection

export function eagerDiffSelectionProjection(input: { readonly generation: number; readonly document: DiffDocument; readonly text: string; readonly preambleLength: number; readonly bodySegments: readonly DisplaySourceSegment[] }): MainSelectionProjection
```

`textSelectionProjection` emits one text segment for non-empty text and no segments for empty text. `eagerDiffSelectionProjection` offsets document segments by `preambleLength`, emits a leading text segment for the preamble, and fills every uncovered body interval with decoration segments. It validates ordered segment bounds while constructing, not at copy time.

- [ ] **Step 5: Keep legacy resolution intact until the atomic UI cutover**

Keep `DocumentSelection`, `copySelection()` and the existing renderable-resolution exports in `selection.ts` during this task. `NativeSelectionRange` remains there until Task 4 migrates every UI and acceptance caller; `selection-projection.ts` imports that type temporarily. Task 4 deletes the old functions and moves the type after the new projection path is wired end to end.

This temporary coexistence is internal to the implementation sequence. It avoids a red intermediate commit and does not survive the final cutover.

- [ ] **Step 6: Run domain tests and typecheck**

Run:

```bash
bun test tests/domain/diff/selection.test.ts
bun run typecheck
```

Expected: projection tests pass and typecheck exits 0. Do not commit a partially migrated or red tree.

- [ ] **Step 7: Commit the domain unit**

```bash
git add src/domain/diff/selection-projection.ts src/domain/diff/selection.ts tests/domain/diff/selection.test.ts
git commit -m "refactor: resolve selections through exact projections"
```

---

### Task 2: Renderer-owned installed text snapshots

**Files:**

- Modify: `src/ui/panes/diff-text.ts`
- Modify: `src/ui/panes/ansi-text.ts`
- Modify: `tests/ui/diff-text.test.ts`
- Modify: `tests/ui/ansi-text.test.ts`

**Interfaces:**

- Consumes: current `DiffTextContent` and `AnsiTextContent`.
- Produces: `InstalledPaneText = { readonly text: string; readonly preambleLength: number }` from both installers.

- [ ] **Step 1: Add failing observable installer-return tests**

Extend the existing tests that install a non-newline-terminated preamble. Assert the returned snapshot equals `host.text.plainText` and reports the normalized preamble length:

```ts
const installed = installDiffText(host.text, { preamble: "commit abc", body: rendered.displayText, displayLines: rendered.displayLines })
expect(installed.text).toBe(host.text.plainText)
expect(installed.preambleLength).toBe("commit abc\n".length)
```

Add the equivalent assertion for `installAnsiText`. These tests defend projection drift: changing either installer's normalization without changing its return value must fail.

- [ ] **Step 2: Run both tests and verify RED**

```bash
bun test tests/ui/diff-text.test.ts tests/ui/ansi-text.test.ts
```

Expected: TypeScript/runtime failure because the installers return `void`.

- [ ] **Step 3: Return the exact installed snapshot from both renderer paths**

Define in `diff-text.ts`:

```ts
export type InstalledPaneText = {
  readonly text: string
  readonly preambleLength: number
}
```

Make the existing join helper return this structure plus painter metadata internally. `installDiffText()` returns the same `{ text, preambleLength }` in both native-buffer and styled-chunk fallback paths. `installAnsiText()` imports `InstalledPaneText` and returns the same contract. It must not read text back from `TextRenderable` or allocate a second body split.

- [ ] **Step 4: Verify renderer tests**

```bash
bun test tests/ui/diff-text.test.ts tests/ui/ansi-text.test.ts
```

Expected: both files pass with no new warnings.

- [ ] **Step 5: Commit renderer snapshots**

```bash
git add src/ui/panes/diff-text.ts src/ui/panes/ansi-text.ts tests/ui/diff-text.test.ts tests/ui/ansi-text.test.ts
git commit -m "refactor: expose installed pane text snapshots"
```

---

### Task 3: Main-pane projection and semantic selection lifecycle

**Files:**

- Modify: `src/ui/panes/main-pane.ts`
- Modify: `src/ui/panes/virtual-main-pane.ts`
- Modify: `tests/ui/main-pane-virtual.test.ts`

**Interfaces:**

- Consumes: Task 1 projection builders/resolver and Task 2 installer snapshots.
- Produces:
  - `getMainSelectionProjection(pane): MainSelectionProjection | undefined`;
  - `resolveMainNativeSelection(pane): MainSelection | undefined`;
  - `getMainSelection(pane): MainSelection | undefined`;
  - `setMainDocumentSelection(pane, selection): void`;
  - `clearMainSelection(pane): void`.
- `createVirtualMainPane` receives callbacks to publish bounded projections and read the current document selection. Its legacy pointer API remains only until RootView migrates atomically in Task 4.

- [ ] **Step 1: Add failing projection-lifecycle tests beside existing pointer tests**

In `tests/ui/main-pane-virtual.test.ts`, retain existing pointer tests until Task 4 because the current `RootView` still consumes them. Add tests that:

1. install a virtual document and assert the active projection text equals `pane.text.plainText`;
2. assert projection segments are an ordered full partition;
3. scroll to a nonzero window and assert generation increases while `projection.text` still equals `pane.text.plainText`;
4. store a document selection, scroll, and assert it survives with the new generation;
5. store a text selection through a native drag/range, scroll, and assert it clears.

Use real `TextRenderable` native selection for resolution; do not inspect copied WeakMap fields.

- [ ] **Step 2: Run the virtual pane test and verify RED**

```bash
bun test tests/ui/main-pane-virtual.test.ts
```

Expected: compile failure for the new projection/selection APIs.

- [ ] **Step 3: Add central projection generation and selection state**

In `main-pane.ts`, add WeakMaps for active projections and stored semantic selections plus a monotonically increasing integer local to the module:

```ts
type StoredMainSelection = {
  readonly projectionGeneration: number
  readonly value: MainSelection
}
```

A `publishProjection(pane, draft)` helper assigns the next generation. It retains a valid document selection only when both old and new projections reference the same `DiffDocument`, retagging it to the new generation. It clears text/invalid selections and every selection on source replacement.

`resolveMainNativeSelection()` reads `pane.text.getSelection()` and `getSelectedText()` once, resolves against the active projection, stores the result under that generation, and returns it. It never reads `MainPaneContent`.

- [ ] **Step 4: Publish eager, ANSI, plain and placeholder projections**

After each install call, use its returned `InstalledPaneText`:

```ts
const installed = installDiffText(...)
publishProjection(pane, eagerDiffSelectionProjection({
  generation: 0,
  document: doc,
  text: installed.text,
  preambleLength: installed.preambleLength,
  bodySegments: rendered.segments,
}))
```

`publishProjection` replaces the draft generation. ANSI/plain/`No content`/`Terminal too small` use `textSelectionProjection`. The projection changes in the same branch that changes the buffer; early returns must not leave an old projection active.

- [ ] **Step 5: Publish a bounded virtual projection from `renderWindow()`**

Change `createVirtualMainPane` to accept:

```ts
type VirtualMainPaneSelectionPort = {
  readonly publishProjection: (draft: Omit<MainSelectionProjection, "generation">) => void
  readonly currentDocumentSelection: () => DocumentSelection | undefined
}
```

While building padded rows, build ordered segments using the exact local row offsets. For each preamble row emit text then padding decoration. For each diff row emit gutter decoration, document segments for the visible raw body and newline, then padding decoration. Use `InstalledPaneText.text` as the projection text and assert the computed cursor ends at `text.length` before publishing.

During Task 3, keep `rawSelection`, `setPointerSelection()`, `selection()`, `nativeCopySource()` and `clearRawSelection()` unchanged so the existing `RootView` remains green. The projection port and semantic state run alongside them only as an intermediate migration state.

Add one paint helper that prefers `currentDocumentSelection()` when present and otherwise preserves the legacy raw selection until Task 4. Task 4 removes the fallback and all five legacy members in the same commit that removes their RootView callers. `resetSelection()` continues clearing OpenTUI paint; semantic state is cleared by `main-pane.ts`.

- [ ] **Step 6: Make keyboard line ranges publish document selections**

When `setMainDiffLineRangeState()` activates a range, derive the existing raw offsets and store them with `setMainDocumentSelection()`. When it clears the range, clear that semantic selection. Preserve current virtual/eager painting and cursor behavior.

- [ ] **Step 7: Verify main-pane lifecycle tests and typecheck**

```bash
bun test tests/ui/main-pane-virtual.test.ts tests/ui/diff-text.test.ts tests/ui/ansi-text.test.ts
bun run typecheck
```

Expected: pane tests pass and typecheck exits 0. Do not commit with deferred RootView errors.

- [ ] **Step 8: Commit pane lifecycle**

```bash
git add src/ui/panes/main-pane.ts src/ui/panes/virtual-main-pane.ts tests/ui/main-pane-virtual.test.ts
git commit -m "refactor: own main selections in pane projections"
```

---

### Task 4: RootView clean cutover and panel-4 regressions

**Files:**

- Modify: `src/ui/root-view.ts`
- Modify: `src/domain/diff/selection.ts`
- Modify: `src/ui/panes/main-pane.ts`
- Modify: `tests/ui/main-diff.integration.test.ts`
- Modify: `tests/ui/branch-preview.integration.test.ts`
- Modify: `tests/acceptance/lazygit-core-ui.test.ts`

**Interfaces:**

- Consumes: Task 3 semantic-selection API.
- Produces: one mouse-selection lifecycle shared by eager and virtual content; copy/stage/discard consume `getMainSelection()`.

- [ ] **Step 1: Add the failing user-path tests before changing `RootView`**

In `tests/ui/main-diff.integration.test.ts`, use panel key `4`, wait for preview, focus main with `0`, then use real `harness.drag()` coordinates. Required cases:

- eager one-line diff body selection copies the raw substring;
- eager multi-line diff selection copies the corresponding raw range;
- virtual commit preview scrolls past its preamble, selects diff text and copies it without `Selection rejected`;
- reverse virtual drag produces the same raw range;
- virtual selection survives scrolling away and back;
- commit-ID and scrolled preamble text still copy exactly;
- preamble-to-diff selection copies visible text in `text` mode and rejects document-only modes.

The regression matching the reported symptom must assert both the OSC52 payload and absence of `Selection rejected` in the frame.

Update the ANSI branch preview test to use real mouse drag instead of `setSelection()`. Replace acceptance-level direct `selectionFromRenderable()` usage with the real Ctrl+O path.

- [ ] **Step 2: Run the integration tests and verify RED**

```bash
bun test tests/ui/main-diff.integration.test.ts tests/ui/branch-preview.integration.test.ts tests/acceptance/lazygit-core-ui.test.ts
```

Expected: the panel-4 diff regression fails under the current pointer/native priority ladder or the removed Task 1 APIs fail compilation.

- [ ] **Step 3: Replace mouse routing with native projection capture**

Delete `mainPointerAnchor`, `mainPointerCoordinates()` and `updateVirtualMainPointer()`. On a selectable main-pane mouse down:

- clear an active keyboard line range;
- clear the semantic main selection;
- let OpenTUI start its native selection; do not install a virtual raw selection.

On main-pane drag and up, after OpenTUI has updated its selection, call `resolveMainNativeSelection(pane)`. Keep gesture ownership only for focus/menu cleanup and cancellation. Do not branch on eager versus virtual.

- [ ] **Step 4: Migrate copy to one semantic selection**

Rewrite `copyMainMode()` around `getMainSelection(pane)`:

```ts
const resolved = getMainSelection(pane)
const document = getMainDocument(pane)
if (resolved?.valid && resolved.kind === "text") {
  if (mode !== "text") return reject()
  return emit(resolved.text)
}
const selection = resolved?.valid && resolved.kind === "document" ? resolved.selection : cursorSelectionForWholeMode(document, mode)
return emit(document === undefined ? "" : copySelection(document, selection, mode))
```

Invalid semantic selections show the existing rejection title and never emit. `hunk`/`file` cursor fallback is permitted only when there is no active semantic selection. Remove every call to `getMainPaneCopySource()`, `getMainPointerSelection()`, `resolveRenderableCopySelection()` and copy-time `pane.text.getSelection()`.

- [ ] **Step 5: Migrate stage/discard target derivation**

`mainActionTarget()` and `mainChangeSelection()` read the same valid document selection. Text/invalid selections do not fall through to a different native interpretation. With no semantic selection, retain keyboard/cursor fallback behavior. Remove the last `selectionFromRenderable()` caller.

After these callers use semantic selection, delete `mainPointerAnchor`, `mainPointerCoordinates()`, `updateVirtualMainPointer()`, and the virtual adapter's `rawSelection`, `setPointerSelection()`, `selection()`, `nativeCopySource()` and `clearRawSelection()`. Update or delete their direct unit-test assertions; retain the behavior through real mouse integration tests and projection lifecycle tests.

- [ ] **Step 6: Delete obsolete exports and test probes**

Remove old imports and exports from `main-pane.ts`, `root-view.ts` and tests. Search must return no matches:

```text
selectionFromRenderable
resolveRenderableCopySelection
RenderableCopySource
RenderableCopySelection
getMainPaneCopySource
getMainPointerSelection
setPointerSelection
nativeCopySource
```

Do not retain aliases.

- [ ] **Step 7: Run the focused behavioral suites**

```bash
bun test tests/domain/diff/selection.test.ts
bun test tests/ui/diff-text.test.ts tests/ui/ansi-text.test.ts tests/ui/main-pane-virtual.test.ts
bun test tests/ui/main-diff.integration.test.ts tests/ui/branch-preview.integration.test.ts
bun test tests/acceptance/lazygit-core-ui.test.ts
```

Expected: all pass; the panel-4 mouse regressions observe exact clipboard payloads.

- [ ] **Step 8: Commit the RootView cutover**

```bash
git add src/ui/root-view.ts src/ui/panes/main-pane.ts tests/ui/main-diff.integration.test.ts tests/ui/branch-preview.integration.test.ts tests/acceptance/lazygit-core-ui.test.ts
git commit -m "fix: unify main pane selection ownership"
```

---

### Task 5: Final cleanup and verification

**Files:**

- Modify only if required by verification: files already named above.
- Verify unchanged: `docs/lazygit-compatibility-v0.1.md`.

**Interfaces:**

- Consumes: completed Tasks 1–4.
- Produces: a clean, reviewed branch with no legacy selection path.

- [ ] **Step 1: Run focused search and strict diagnostics**

Use the repository search tool for the obsolete-symbol list from Task 4. Run LSP diagnostics when a TypeScript server is available; otherwise run:

```bash
bun run typecheck
```

Expected: no obsolete symbol matches and no TypeScript diagnostics.

- [ ] **Step 2: Run the full project gate**

```bash
bun run check
```

Expected: exit 0. Keep pre-existing React `act(...)` warnings distinct from failures.

- [ ] **Step 3: Perform final code review**

Request a reviewer focused on:

- projection text exactly matching installed eager/ANSI/plain/virtual buffers;
- ordered, non-overlapping full segment coverage;
- selection generation invalidation and document-selection survival across virtual scroll;
- no copy-time source reconstruction or pointer/native priority ladder;
- bounded virtual allocation and iteration;
- real panel-4 mouse tests rather than direct `setSelection()` shortcuts.

Fix every critical or important finding and rerun the affected focused suite plus `bun run check`.

- [ ] **Step 4: Commit verification fixes if needed**

If review or verification required source changes:

```bash
git add <only-files-changed-by-the-fix>
git commit -m "fix: harden main selection projection"
```

If no source changed, do not create an empty commit.

- [ ] **Step 5: Report evidence**

Report separately:

- focused automated test counts;
- `bun run check` count and exit status;
- manual/TUI behavior actually exercised;
- known unrelated warnings;
- reviewer verdict;
- commits created.
