# Review Highlight — Full Hunk-Level Syntax Highlight Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add full hunk-level syntax highlighting to the Branch Review workspace's continuous review stream, using @pierre/diffs + shiki, while keeping viewport-windowed rendering and generation-qualified async.

**Architecture:** New isolated highlight adapter under `src/review/git/highlight/` converts Pierre `FileDiffMetadata` + shiki highlight into core `HighlightPayload` (no Pierre types leak). `row-planner` consumes optional `highlightByFileKey` to emit token `ReviewTextSpan`s. `review-workspace` paints via `paneTextBuffer` + `viewportHighlights` (same mechanism as `src/ui/panes/diff-text.ts`). Controller orchestrates async loads qualified by `ReviewGeneration.id` + request token. No React, no @opentui/react.

**Tech Stack:** Bun, TypeScript 5.9, @opentui/core 0.5.6, @pierre/diffs 1.3.5 (shiki inside), zod isolated elsewhere.

**Spec:** `docs/superpowers/specs/2026-08-27-branch-review-workspace-design.md` + this task's highlight requirement (full hunk-level, TDD, refer to learn-projects/hunk source).

## Global Constraints

- Branch Review is read-only: no Git mutation path may be reachable from highlight code.
- Review core (`src/review/core`) imports no OpenTUI, filesystem, Git runner, process, clipboard, Pierre, or Zod types.
- @pierre/diffs is isolated behind the Git/document adapter; zod isolated behind persistence/artifact boundaries. Do not add React, @opentui/react, hunk components, provider interface, fallback parser, compatibility aliases.
- Continuous rendering is viewport-windowed; do not construct terminal rows for entire changeset (highlight payload cached per file, rows windowed).
- All async results are qualified by review identity, generation, and request token before publication.
- Every task uses TDD, runs only focused tests, commits independently testable result.
- Do not run project-wide formatting/lint/full suite inside individual tasks; final task owns integrated verification.

## Locked file structure

```
src/review/git/highlight/
  highlight-adapter.ts   Pierre -> HighlightPayload (parseDiffFromFile, getSharedHighlighter, renderDiffWithHighlighter)
  highlight-cache.ts     LRU/per-file cache keyed by contentId + generation + theme
  highlight-payload.ts   Core highlight types (HighlightPayload, HighlightToken) — no Pierre leakage
  highlight-hast.ts      HAST -> token flatten (collectHastHighlightRuns copy-adapted)
src/ui/review-workspace/
  row-planner.ts         extended: highlightByFileKey param, token spans
  stream-pane.ts         exposes highlight-aware plan creation
  review-workspace.ts    paints via paneTextBuffer + viewportHighlights instead of plain join
  review-highlight-text.ts  viewportHighlights spec for review rows (new, like diff-text.ts)
src/review/git/
  load-review-document.ts  optionally attaches language metadata for highlight (via Pierre's getFiletypeFromFileName)
```

Tests mirror ownership: `tests/review/git/highlight-adapter.test.ts`, `tests/review/git/highlight-cache.test.ts`, `tests/ui/review-workspace/row-planner-highlight.test.ts`, `tests/ui/review-workspace/highlight.integration.test.ts`.

---

### Task 1: Highlight adapter boundary (Pierre -> HighlightPayload isolation)

**Files:**
- Create: `src/review/git/highlight/highlight-payload.ts`
- Create: `src/review/git/highlight/highlight-hast.ts`
- Create: `src/review/git/highlight/highlight-adapter.ts`
- Create: `tests/review/git/highlight-adapter.test.ts`

**Interfaces:**
- Consumes: raw patch string or FileDiffMetadata from Pierre, theme "dark"|"light"
- Produces: `HighlightPayload` { readonly fileKey: string; readonly language?: string; readonly deletionLines: readonly (readonly HighlightToken[] | null)[]; readonly additionLines: readonly (...)[] } where HighlightToken = { text: string; fg?: string }
- `loadHighlightForPatch(patch: string, fileKey: string, theme?: string): Promise<HighlightPayload | null>` — returns null for binary/empty/shouldSkip
- `parsePierreLanguage(fileName: string): string | undefined`

- [ ] **Step 1: Write failing test for adapter isolation and basic highlight**

```ts
import { describe, expect, test } from "bun:test"
import { loadHighlightForPatch } from "../../../src/review/git/highlight/highlight-adapter"

describe("highlight-adapter", () => {
  test("highlights a TS patch and returns token spans without leaking Pierre types", async () => {
    const patch = `diff --git a/foo.ts b/foo.ts
index 111..222 100644
--- a/foo.ts
+++ b/foo.ts
@@ -1,3 +1,3 @@
-const x: number = 1
+const y: string = "hi"
`
    const payload = await loadHighlightForPatch(patch, "foo.ts", "dark")
    expect(payload).not.toBeNull()
    expect(payload!.additionLines.length).toBeGreaterThan(0)
    // at least one token has fg
    const hasFg = payload!.additionLines.flat().flat().some(t => t?.fg)
    expect(hasFg).toBe(true)
    // no Pierre type leakage - payload is plain object
    expect(JSON.stringify(payload)).not.toContain("HastNode")
  })

  test("returns null for binary patch", async () => {
    const patch = "Binary files a/foo.png and b/foo.png differ\n"
    expect(await loadHighlightForPatch(patch, "foo.png")).toBeNull()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/review/git/highlight-adapter.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write minimal implementation**

Implement `highlight-payload.ts` with HighlightPayload/HighlightToken types (plain).
Copy-adapt `collectHastHighlightRuns` from learn-projects/hunk/src/ui/diff/worker/highlightHast.ts (no React) into `highlight-hast.ts`.
Implement `highlight-adapter.ts`:
  - sanitize patch like patch-adapter (strip terminal control) but reuse sanitizePatch
  - parse via `parsePatchFiles(sanitized, "patch", true)` to get metadata, or via `parseDiffFromFile` for single file (use parsePatchFiles result's FileDiffMetadata)
  - determine language via `getFiletypeFromFileName`
  - call `getSharedHighlighter(getHighlighterOptions(language, {theme:"pierre-dark"}))` then `renderDiffWithHighlighter`
  - flatten Hast lines via highlight-hast into token arrays
  - return HighlightPayload; catch errors -> null

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/review/git/highlight-adapter.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/review/git/highlight tests/review/git/highlight-adapter.test.ts
git commit -m "feat(review): add Pierre highlight adapter boundary"
```

---

### Task 2: Highlight cache + generation/request token invalidation

**Files:**
- Create: `src/review/git/highlight/highlight-cache.ts`
- Create: `tests/review/git/highlight-cache.test.ts`

**Interfaces:**
- Consumes: HighlightPayload from Task 1, ReviewGeneration.id, theme
- Produces: `HighlightCache` class with `get(key: string): HighlightPayload | undefined`, `set(key, payload)`, `invalidate(generationId: string)`, `cacheKey(fileKey, contentId, generationId, theme)` — LRU with max 50 entries

- [ ] **Step 1: Write failing test for cache invalidation**

```ts
test("cache hit within same generation, miss after generation change", async () => {
  const cache = new HighlightCache(5)
  cache.set(cache.cacheKey("foo.ts", "cid1", "gen1", "dark"), payload1)
  expect(cache.get(cache.cacheKey("foo.ts", "cid1", "gen1", "dark"))).toEqual(payload1)
  expect(cache.get(cache.cacheKey("foo.ts", "cid1", "gen2", "dark"))).toBeUndefined()
})
test("LRU evicts oldest", () => { ... })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/review/git/highlight-cache.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement LRU cache**

Simple Map with insertion order, evict on size > max.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/review/git/highlight-cache.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

---

### Task 3: Row-planner integration — windowed spans with highlight

**Files:**
- Modify: `src/ui/review-workspace/row-planner.ts`
- Create: `tests/ui/review-workspace/row-planner-highlight.test.ts`

**Interfaces:**
- Consumes: ReviewState, PlanReviewRowsOptions extended with `highlightByFileKey?: ReadonlyMap<string, HighlightPayload>`
- Produces: ReviewRow[].text now contains per-token spans with fg derived from highlight payload; fallback to plain addition/deletion when no highlight

- [ ] **Step 1: Write failing test**

```ts
test("emits highlighted spans for addition lines when payload present", () => {
  const state = makeStateWithOneTsFile()
  const payload = await loadHighlightForPatch(patch, "foo.ts")
  const plan = planReviewRows(state, { viewportStart:0, viewportHeight:20, width:80, effectiveMode:"stack", showLineNumbers:true, wrapLines:false, highlightByFileKey: new Map([["foo.ts", payload]]) })
  const additionRow = plan.rows.find(r=> r.text.some(s=> s.style==="addition"))
  expect(additionRow?.text.some(s=> s.fg !== undefined)).toBe(true)
})
test("binary file still renders binary row even with no highlight", () => { ... })
test("windowed: highlight only for visible window still correct after scroll", () => { ... })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/ui/review-workspace/row-planner-highlight.test.ts`
Expected: FAIL — highlight param ignored, no fg

- [ ] **Step 3: Implement**

In buildRowsForFile, when highlight payload present, for each diff line resolve side + lineIndex to token array, then produce spans with fg per token instead of single addition/deletion style. Map `addition ->` still addition style but with fg overrides. For OpenTUI we need to thread fg through ReviewTextSpan as optional `fg?: string`.

Add `fg` to ReviewTextSpan type.

Handle binary/too-large: no highlight, keep dim.

Handle expanded gaps: no highlight (synthetic lines plain).

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/ui/review-workspace/row-planner-highlight.test.ts tests/ui/review-workspace/row-planner.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

---

### Task 4: ViewportHighlights paint integration

**Files:**
- Create: `src/ui/review-workspace/review-highlight-text.ts` (like diff-text.ts)
- Modify: `src/ui/review-workspace/review-workspace.ts`
- Modify: `src/ui/review-workspace/stream-pane.ts` (if needed for viewportStart plumbing)
- Create: `tests/ui/review-workspace/highlight.integration.test.ts`

**Interfaces:**
- Creates `installReviewHighlightText(text: TextRenderable, content: { text: string; highlightsByRow: Map<number, Highlight> })` that uses `paneTextBuffer` + `createViewportHighlights`
- review-workspace.ts: replace `streamText.content = streamContent` with `installReviewHighlightText` when highlight payload present, falling back to plain for empty

- [ ] **Step 1: Write failing test**

```ts
test("installs highlights for visible rows and releases on unmount", async () => {
  const renderer = createMockRenderer()
  const workspace = new ReviewWorkspace(renderer, controller, {})
  // after highlight load, streamText's buffer has highlights for addition rows
  expect(bufferHasHighlightForRow(streamText, 5)).toBe(true)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/ui/review-workspace/highlight.integration.test.ts`
Expected: FAIL — no buffer highlights

- [ ] **Step 3: Implement review-highlight-text.ts**

Mirror `src/ui/panes/diff-text.ts` but for ReviewRow spans: derive per-row highlights from ReviewTextSpan.fg -> registerStyle -> addHighlight with start/end columns measured via cellWidth.

- [ ] **Step 4: Modify review-workspace.ts render()**

Compute full text via planReviewRows (full window), build highlight map per row index, then install via new module using paneTextBuffer; ensure release on destroy and on branch close.

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test tests/ui/review-workspace/highlight.integration.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

---

### Task 5: Worker/Async orchestration + cancellation + controller effects

**Files:**
- Modify: `src/ui/review-workspace/controller.ts` (ReviewWorkspaceController)
- Modify: `tests/ui/review-workspace/lifecycle.integration.test.ts` (existing)
- Create: `tests/ui/review-workspace/highlight-controller.test.ts`

**Interfaces:**
- Controller loads document, then for each file (up to MAX_HIGHLIGHTED_DIFF_LINES 10k) triggers `loadHighlightForPatch` qualified by generation.id and requestToken; stale results discarded.
- Cache shared, highlights published via state addition `highlightByFileKey?: ReadonlyMap<string, HighlightPayload>`

- [ ] **Step 1: Write failing test for generation-qualified async**

```ts
test("discards stale highlight from previous generation", async () => {
  const ctrl = new ReviewWorkspaceController({ runner: fakeRunnerGen1 })
  await ctrl.openReview()
  const gen1 = ctrl.state!.document.generation.id
  // start highlight for gen1, then refresh to gen2 before highlight resolves
  const p1 = ctrl.refreshGeneration()
  // ... assert second generation's highlight wins, first discarded
})
test("highlight load does not block initial render", async () => { ... })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/ui/review-workspace/highlight-controller.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement controller highlight orchestration**

Add HighlightCache instance, highlightGeneration token, request counter. After document load/reconcile, fire-and-forget highlight loads per file in parallel with concurrency limit 3, each qualified. On finish, patch state with new highlight map and notify subscribers.

Ensure generation change clears pending requests via token increment and cache lookup.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/ui/review-workspace/highlight-controller.test.ts tests/ui/review-workspace/lifecycle.integration.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

---

### Task 6: Theme + shiki bridging and performance guard

**Files:**
- Create: `src/ui/review-workspace/syntax-theme.ts` (adapt from hunk's syntaxHighlightTheme.ts but simplified to pierre-dark/light via terminal background)
- Modify: `src/review/git/highlight/highlight-adapter.ts` to accept theme param via syntax-theme
- Modify: `benchmarks/review-row-plan.ts` (extend with highlight cost) or create `benchmarks/highlight-payload.ts`
- Create: `tests/ui/review-workspace/syntax-theme.test.ts`

**Interfaces:**
- `syntaxThemeForAppearance(appearance: "dark"|"light"): string` -> "pierre-dark"/"pierre-light"
- `getEffectiveHighlightTheme(renderer): "dark"|"light"` — currently default dark, future reads terminal palette

- [ ] **Step 1: Write failing test**

```ts
test("picks dark theme by default and light when terminal background is light", () => { ... })
test("highlight payload byte length bounded for large diff", () => { ... })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/ui/review-workspace/syntax-theme.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement simplified theme resolver + large-diff guard (skip highlight >10k lines)**

Reuse `MAX_HIGHLIGHTED_DIFF_LINES = 10000` from hunk.

- [ ] **Step 4: Run test to verify it passes**

- [ ] **Step 5: Commit**

---

### Task 7: Integrated verification

- [ ] **Step 1: Run focused suites**

```bash
bun test tests/review/git/highlight-adapter.test.ts tests/review/git/highlight-cache.test.ts tests/ui/review-workspace/row-planner-highlight.test.ts tests/ui/review-workspace/highlight.integration.test.ts tests/ui/review-workspace/highlight-controller.test.ts --timeout 30000
```

- [ ] **Step 2: Run full review and conformance suite**

```bash
bun test tests/review tests/ui/review-workspace --timeout 60000
```

- [ ] **Step 3: Manual TUI smoke**

```bash
bun run src/main.ts  # open branch with `b`, verify right pane shows syntax colors for TS/JS/md files, split/stack/wrap still work, gap expansion still works, binary file shows dim without crash
```

- [ ] **Step 4: Benchmark guard**

```bash
bun run benchmarks/review-row-plan.ts  # ensure with highlight, row plan still <16ms for 1k rows
```

