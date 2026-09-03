# Large Diff Virtual Main Pane Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the repository main pane render very large diffs through an application-level virtual row window so OpenTUI never receives the full diff as one native text buffer, while preserving exact raw patch selection, copy, and line actions.

**Architecture:** Keep `DiffDocument` as the immutable semantic/raw source used by staging, discard, and exact copy. Add a pure `VirtualDiffLayout` that computes total logical rows, display prefixes, row windows, display offsets, and pointer-to-raw mapping without building a full rendered display string. For documents above the large-diff threshold, `main-pane` keeps the existing outer pane and scrollbar but installs only a bounded row window into its `TextRenderable`; vertical scroll metrics and pointer selection are adapted at the application layer. Small documents keep the existing renderer unchanged.

**Tech Stack:** Bun, strict TypeScript, `@opentui/core` 0.5.6, Bun test, existing `DiffDocument` / `PaneTextBuffer` / `MainPaneContent` APIs.

**Spec:** `docs/superpowers/specs/2026-08-25-lazygit-core-ui-parity-design.md`, with the approved design decision to use true application-level virtual rows for the repository main pane and not silently truncate patch data.

## Global Constraints

- No new runtime dependencies.
- `strict` TypeScript with `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes` remains enabled.
- `DiffDocument.text` remains complete; virtual rendering MUST NOT truncate, drop, or replace raw patch data.
- The eager renderer MUST remain the path for documents at or below `10_000` parsed lines; virtual rendering MUST activate above that threshold.
- The virtual text buffer MUST contain only a bounded viewport window (`viewport height + 2 × viewport height` overscan, with a minimum overscan of 10 rows), never the full large diff.
- Vertical scroll coordinates exposed through the existing `PaneHandle` / `TextRenderable` surface remain logical document rows so existing key, wheel, scrollbar, page, top, bottom, and reveal paths continue to work.
- The virtual renderer MUST preserve diff gutter, addition/deletion/hunk/metadata colours, horizontal scrolling, keyboard line-range selection, pointer selection, exact copy, and stage/discard line-index mapping.
- OpenTUI internals remain isolated in `src/ui/panes/pane-text.ts`; any access to protected text-buffer state MUST use the existing adapter.
- Tests MUST defend observable behavior and MUST skip formatters, linters, and project-wide suites during individual task work.
- New parity comments MUST cite lazygit sources when behavior follows lazygit; lazygit reference code remains read-only.

---

### Task 1: Build Pure Virtual Diff Layout

**Files:**
- Create: `src/domain/diff/virtual.ts`
- Test: `tests/domain/diff/virtual.test.ts`

**Interfaces:**
- Consumes: `DiffDocument`, `DiffLine`, and `DiffDisplayLineStyle` from `src/domain/diff/document.ts`.
- Produces: `VIRTUAL_DIFF_LINE_THRESHOLD`, `VirtualDiffRow`, `VirtualDiffRowWindow`, `VirtualDiffLayout`, and `createVirtualDiffLayout(document, preamble)` for the UI task.

- [ ] **Step 1: Write the failing tests**

Add tests for these exact behaviors:

```ts
const layout = createVirtualDiffLayout(parseDiff("diff --git a/a.txt b/a.txt\n@@ -1 +1 @@\n-old\n+new\n"), "commit message\n")
expect(layout.preambleRows).toBe(1)
expect(layout.totalRows).toBe(5)
expect(layout.rowAt(0)?.text).toBe("commit message")
expect(layout.rowAt(1)?.style).toBe("plain")
expect(layout.rowAt(3)?.style).toBe("deletion")
expect(layout.rowAt(4)?.style).toBe("addition")
expect(layout.rowAt(3)?.rawStartUtf16).toBeGreaterThan(0)
expect(layout.rowAt(layout.totalRows)).toBeUndefined()
```

Add a window test proving `window(scrollTop, viewportHeight, overscan)` clamps to `[0, totalRows)` and returns no more than `viewportHeight + 2 * overscan` rows. Add a display-offset test proving line offsets include the fixed line-number gutter and normalized preamble length. Add a pointer-column test proving a column inside the gutter maps to the line's raw start and a column after the diff sign maps into the raw line without splitting a UTF-16 surrogate pair.

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```bash
bun test tests/domain/diff/virtual.test.ts
```

Expected: FAIL because `src/domain/diff/virtual.ts` and its exported layout API do not exist.

- [ ] **Step 3: Implement the pure layout**

Implement `createVirtualDiffLayout` with these rules:

- Normalize a non-empty preamble to end in one newline; count its logical rows without adding an artificial extra row for the separator.
- Compute one fixed line-number width by scanning `document.lines`; source rows use `${old} ${new} ` padded to that width, non-source rows use an empty gutter.
- `rowAt` returns preamble rows followed by one row per `document.lines` entry. Body rows expose the display text, gutter cell count, style, document line index, raw UTF-16 range, and full display UTF-16 range.
- `totalRows` is `preambleRows + document.lines.length`; `contentWidth` is the maximum display-cell width of every body row and preamble row.
- `window` clamps a requested logical scroll row and returns a bounded inclusive `[first, last]` row range with the requested overscan on both sides.
- `displayOffsetsForLines(startIndex, endIndex)` returns raw and full-display UTF-16 bounds without calling `renderDiff` or allocating full display text.
- `rawOffsetAt(row, column)` maps display-cell columns to raw UTF-16 boundaries, treating gutter columns as the row's raw start and using `cellWidth` to avoid cutting a code point.

- [ ] **Step 4: Run the focused tests and verify GREEN**

Run:

```bash
bun test tests/domain/diff/virtual.test.ts
```

Expected: PASS with all virtual layout assertions.

- [ ] **Step 5: Commit**

```bash
git add src/domain/diff/virtual.ts tests/domain/diff/virtual.test.ts
git commit -m "feat: add virtual diff row layout"
```

---

### Task 2: Add Bounded Main-Pane Virtual Viewport

**Files:**
- Create: `src/ui/panes/virtual-main-pane.ts`
- Modify: `src/ui/panes/main-pane.ts:1-482`
- Test: `tests/ui/main-pane-virtual.test.ts`

**Interfaces:**
- Consumes: `VirtualDiffLayout` from Task 1, `PaneHandle` / `paneTextBuffer`, `DiffDocument`, `MainPaneContent`, and `installDiffText`.
- Produces: `createVirtualMainPane(pane)`, `virtualMainPaneFor(pane)`, `isVirtualDiffDocument(document)`, and the virtual selection/window behavior consumed by RootView.

- [ ] **Step 1: Write the failing tests**

Create a real renderer test fixture with a synthetic `DiffDocument` above the threshold and assert:

```ts
const pane = createMainPane(renderer, model)
const content = { source: "files", stableId: "large", label: "large", document }
installMainContent(pane, content, false)
expect(isVirtualDiffDocument(document)).toBe(true)
expect(pane.text.lineCount).toBeLessThanOrEqual(pane.text.height + pane.text.height * 2 + 10)
expect(pane.text.scrollHeight).toBeGreaterThan(document.lines.length)
pane.text.scrollY = pane.text.maxScrollY
expect(pane.text.scrollY).toBe(pane.text.maxScrollY)
expect(pane.text.plainText).toContain("+last line")
```

Add a small-document regression assertion proving the existing eager path still installs all document rows. Add a selection assertion proving a virtual line range creates a valid raw selection and remains valid after scrolling away and back.

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```bash
bun test tests/ui/main-pane-virtual.test.ts
```

Expected: FAIL because large documents currently install the complete rendered document and have no virtual viewport adapter.

- [ ] **Step 3: Implement the virtual viewport**

Implement `virtual-main-pane.ts` with these exact behaviors:

- Activate only when `document.lines.length > VIRTUAL_DIFF_LINE_THRESHOLD`.
- Keep the existing `PaneHandle.box`, text renderable, and scrollbar. Install own `scrollY`, `scrollHeight`, `maxScrollY`, `scrollWidth`, and `maxScrollX` accessors on the main text instance that delegate to the virtual state only while active; delegate to the original OpenTUI accessors otherwise.
- Keep a logical `scrollY`, viewport height, horizontal offset, current `VirtualDiffLayout`, and current raw `DocumentSelection` in a `WeakMap` keyed by the pane. Do not allocate a row array for the full document.
- On install, compute the bounded window from the logical scroll row and render only that window through `installDiffText`; use `wrapMode: "none"` for virtual rows so each logical diff row has a constant height while `scrollWidth` preserves horizontal scrolling. Include only the visible preamble slice when the window intersects the preamble.
- On vertical scroll, clamp to `totalRows - viewportHeight`, rerender the bounded window, reapply the visible part of the raw selection to the native buffer, sync the existing scrollbar, and request one render. Do not call `renderDiff(document)`.
- On resize, update viewport dimensions and rerender the bounded window without resetting logical scroll unless the new maximum requires clamping.
- Expose pointer-to-raw selection helpers that use pane-local coordinates, logical scroll, display-cell columns, and `rawOffsetAt`; expose `selection()` for RootView copy/stage/discard resolution.
- Expose line-range selection and reset helpers. Visualize the visible intersection by calling the existing text-buffer selection adapter; the complete raw range remains in virtual state when its endpoints are outside the current window.
- On deactivation, restore the original text accessors, release diff painter state, restore `wrapMode: "char"`, and let the existing eager install path render the replacement.

Modify `main-pane.ts` so:

- `createMainPane` creates and attaches the virtual adapter before the preview gate can install content.
- `installMainContent` compares virtual document identity/preamble without constructing `renderedTextFor` for a large document, routes large documents to the virtual adapter, and routes all other content through the existing eager implementation.
- `mainDiffVisualRowRange`, `mainDiffLineOffsets`, `setMainDiffLineRangeState`, `getMainDiffLineSelection`, `clearSelection`, and `clampMainScroll` use the virtual adapter when active; eager behavior remains unchanged.
- `getMainPointerSelection` returns the virtual raw selection when active and `undefined` otherwise.

- [ ] **Step 4: Run the focused tests and verify GREEN**

Run:

```bash
bun test tests/ui/main-pane-virtual.test.ts
```

Expected: PASS; the native text buffer stays bounded while logical scroll metrics cover the full document.

- [ ] **Step 5: Commit**

```bash
git add src/ui/panes/virtual-main-pane.ts src/ui/panes/main-pane.ts tests/ui/main-pane-virtual.test.ts
git commit -m "feat: virtualize large main diff rows"
```

---

### Task 3: Preserve RootView Interaction Contracts

**Files:**
- Modify: `src/ui/root-view.ts:64,776-785,1810-1930,3388-3518,3521-3592,4295-4335,4788-4802,4918-4929,4615-4648`
- Modify: `tests/ui/main-diff.integration.test.ts:1-403`
- Modify: `tests/ui/main-scroll.integration.test.ts:1-210`

**Interfaces:**
- Consumes: `getMainPointerSelection`, `virtualMainPaneFor`, and the virtual scroll accessors from Task 2.
- Produces: unchanged user-facing key, wheel, scrollbar, search, pointer selection, copy, stage, discard, and hunk-cursor behavior for both eager and virtual documents.

- [ ] **Step 1: Write the failing integration tests**

Add a real temp-repository test with one file changed across more than `10_000` parsed diff lines. Assert:

- opening panel 0 renders the first changed row and `mainPane.text.lineCount` remains below the configured viewport-window bound;
- `.` repeatedly scrolls into the middle, `>` reaches the bottom, and the frame contains the last changed row;
- the main scrollbar's `scrollSize` equals the logical virtual `scrollHeight` and its position tracks `mainScrollY`;
- `v` plus shifted arrow selection still returns the expected raw changed-line indexes after the viewport has moved;
- a mouse drag selection spanning two visible rows produces the exact raw text through `Ctrl-C`, and stage/discard continues to use `changeLineIndexes` rather than visible-buffer indexes;
- main search jumps to the matching logical line without calling `split("\\n")` on a full rendered display string;
- selecting a different pane and returning leaves the virtual main document stable and does not reinstall the full buffer.

- [ ] **Step 2: Run the focused integration tests and verify RED**

Run:

```bash
bun test tests/ui/main-diff.integration.test.ts tests/ui/main-scroll.integration.test.ts
```

Expected: the new large-document assertions fail because RootView still reads native selection/scroll state and ignores virtual pointer selection.

- [ ] **Step 3: Implement RootView routing**

Modify RootView so:

- `mainChangeSelection` and `copyMainMode` prefer `getMainPointerSelection` before calling `selectionFromRenderable`.
- Main pointer gesture down/drag/up calls the virtual adapter with event coordinates when active; the existing native path remains untouched for eager documents.
- Main search scans `DiffDocument.lines` when a document is installed, preserving wrap-independent logical line numbers and avoiding a full `split("\\n")`; plain/ANSI content keeps its current string path.
- Main scroll/reveal/page/top/bottom paths continue to use the pane's logical `scrollY`/`scrollHeight` accessors and sync the existing scrollbar.
- Destroy and resize paths release virtual state without leaving mouse handlers or stale selection.
- Add comments citing lazygit's `ViewBufferManager.ReadLines` / main-view selection behavior where the virtual logical scroll contract mirrors it.

- [ ] **Step 4: Run the focused integration tests and verify GREEN**

Run:

```bash
bun test tests/ui/main-diff.integration.test.ts tests/ui/main-scroll.integration.test.ts
```

Expected: PASS for the new large-diff tests and all existing main interaction assertions.

- [ ] **Step 5: Commit**

```bash
git add src/ui/root-view.ts tests/ui/main-diff.integration.test.ts tests/ui/main-scroll.integration.test.ts
git commit -m "fix: preserve large diff main pane interactions"
```

---

### Task 4: Update Performance Coverage and Compatibility Notes

**Files:**
- Modify: `tests/ui/main-diff.integration.test.ts:127-153`
- Modify: `docs/lazygit-compatibility-v0.1.md:1-30`
- Modify: `docs/superpowers/specs/2026-08-25-lazygit-core-ui-parity-design.md:260-280`

**Interfaces:**
- Consumes: the finished virtual main pane and RootView behavior from Tasks 2–3.
- Produces: evidence-bound regression coverage and accurate compatibility wording; no user-visible API changes.

- [ ] **Step 1: Confirm the integrated performance assertion**

Run:

```bash
bun test tests/ui/main-diff.integration.test.ts
```

Expected: PASS for the deterministic above-threshold fixture added in Task 3, including the bounded native window and complete logical document assertions.

- [ ] **Step 2: Update the two documents**

Change the compatibility/spec wording from “full diff with no patch-size threshold” to “full raw patch retained; large main diffs use application-level virtual rows and do not silently truncate.” Keep panel 4 commit metadata/stat/patch semantics unchanged. Record that this is a githunk implementation extension motivated by lazygit's incremental main-view reading, not an OpenTUI-native virtual TextBuffer feature.

- [ ] **Step 3: Run the focused test after documentation changes**

Run:

```bash
bun test tests/ui/main-diff.integration.test.ts
```

Expected: PASS with the large native-window bound and existing colour/selection assertions.


- [ ] **Step 4: Commit**

```bash
git add tests/ui/main-diff.integration.test.ts docs/lazygit-compatibility-v0.1.md docs/superpowers/specs/2026-08-25-lazygit-core-ui-parity-design.md
git commit -m "docs: record virtual large-diff behavior"
```

---

### Task 5: Run Repository Verification

**Files:**
- No source changes expected.

- [ ] **Step 1: Run targeted changed-contract tests**

Run:

```bash
bun test tests/domain/diff/virtual.test.ts tests/ui/main-pane-virtual.test.ts tests/ui/main-diff.integration.test.ts tests/ui/main-scroll.integration.test.ts
```

Expected: PASS with no warnings or leaked test processes.

- [ ] **Step 2: Run the project gate**

Run:

```bash
bun run check
```

Expected: TypeScript no-emit and the full Bun test suite pass.

- [ ] **Step 3: Smoke the actual TUI path**

Run:

```bash
bun run start
```

In the repository workspace, open panel 0 on a repository containing more than `10_000` diff lines, scroll to the middle and bottom, select a short visible range, invoke exact copy, and return to panel 0. Confirm the process remains responsive, the frame shows the requested rows, and no patch lines are silently omitted.

- [ ] **Step 4: Commit verification notes only if requested**

Do not add generated output or local evidence files to the repository. Report commands and observed results in the task response.
