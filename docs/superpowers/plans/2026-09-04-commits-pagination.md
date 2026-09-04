# Commits Panel Hang on Huge Repos Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** githunk stays responsive on repos with tens of thousands of commits (e.g. hermes-agent, 27,617 commits) by loading only the latest 300 commits initially and jumping directly to list edges, matching lazygit.

**Architecture:** Two independent fixes compose: (1) data-volume cap — `listCommits` takes a `limit` flag defaulting to true that appends git's `-300` (lazygit's `ArgIf(opts.Limit, "-300")`), owned by a `limitCommits` flag on `AppController` with an explicit `expandCommits()` escape hatch; (2) O(1) edge jump — `actionJump` selects the first/last row directly instead of looping `actionMoveCursor` N times (each step costs an O(N) visuals scan plus one spawned `git show`). Auto-expand fires when the cursor passes row 200, on `End`, and on commits search — lazygit's three triggers.

**Tech Stack:** Bun + TypeScript (`strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`), existing `bun test` suites, shell-harness headless renderer tests.

**Spec:** Bug report (this session): panel-4 commits hangs hard on hermes-agent; `End` to oldest commit never returns; lazygit with initial-300 + scroll-to-load-all stays usable. lazygit references: `learn-projects/lazygit/pkg/commands/git_commands/commit_loader.go:581-606` (`getLogCmd`, `-300`), `pkg/gui/context/local_commits_context.go:224-235` (`limitCommits` defaults true), `pkg/gui/controllers/local_commits_controller.go:22` (`COMMIT_THRESHOLD = 200`), `:1673-1677` (expand on search), `:1790-1797` (expand past threshold), `pkg/gui/controllers/helpers/refs_helper.go:43-44` (re-limit on reset flows).

## Global Constraints

- No new runtime dependencies (`bun.lock` pin stands).
- `strict` TS with `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes` — use the `...(x === undefined ? {} : { x })` spread idiom, keep `readonly`.
- Keybindings stay data in `GITHUNK_BINDINGS`; no raw-key pattern matching.
- Every controller call in `create-app.ts` follows `try { … } finally { view.update(controller.state) }`.
- Commit messages use `feat:`/`fix:` prefixes with lazygit `file:line` citations in the body.
- Claims stay evidence-bounded: time real runs, never assert unverified speedups.

## Root Cause (verified this session, do not re-investigate)

- `git log` full history on hermes-agent: 245ms / 22MB / 27,617 commits — git is fast.
- `parseCommitLog`: ~40ms. Headless `controller.refresh()`: ~350ms. Data layer is fast.
- Full `app.refresh()` with view: ~1155ms → ~800ms of pure view cost per `update()`: `refreshCommitsPanel` (`src/ui/root-view.ts:4092`) rebuilds 27k rows via `buildCommitRows` (~200ms; fresh objects defeat `installListText`'s row-identity cache at `src/ui/panes/list-text.ts:302`), then `renderListRows` materializes 745,675 chunks (~449ms) plus a 2.2MB install with 27k line-highlights. Paid on every action-triggered `update()` and every 10s background refresh.
- `actionJump` (`src/ui/root-view.ts:1958-1973`) loops `actionMoveCursor` up to `max(all pane lengths)+1` times. One `End` on 27k commits = ~27.6k iterations × O(27k) `visualsFor` scan + ~27.6k immediate `git show` spawns (`MainPreviewGate.request` has no debounce, `src/ui/main-preview.ts:22-41`). Quadratic CPU plus process fork-bomb = the hard hang. lazygit sets the index directly (O(1)) and only holds 300 rows.

---

## File Map

- `src/git/commits.ts` — add `COMMITS_LIMIT = 300` and `limit` option to `listCommits`; default limited.
- `src/app/controller.ts` — `limitCommits` flag (default true), `expandCommits()`, pass-through in `loadCommitHistory`/`loadBranchCommits`, re-limit in `switchLocalBranch`.
- `src/app/create-app.ts` — forward `loadCommits` loader option; wire `onExpandCommits`.
- `src/ui/root-view.ts` — O(1) `actionJump`, `jumpCommitsToBottom`, threshold hook in commits cursor move, search hook in `handleGenericFilterKey`, `onExpandCommits` option.
- `src/ui/panes/commits-pane.ts` — export `COMMIT_THRESHOLD = 200`.
- `tests/git/commits.test.ts`, `tests/app/controller.test.ts`, new `tests/ui/commits-pagination.integration.test.ts`, `tests/helpers/shell-harness.ts` — tests + seam.
- `docs/lazygit-compatibility-v0.1.md` row 3 — one-clause behavior note.

---

### Task 1: Cap `git log` at 300

**Files:**
- Modify: `src/git/commits.ts:9-10,37-50`
- Test: `tests/git/commits.test.ts:92-105`

**Interfaces:**
- Consumes: nothing new.
- Produces: `COMMITS_LIMIT`, `listCommits(runner, range, filter?, options?: { readonly limit?: boolean })` for Task 2.

- [ ] **Step 1: Write the failing test** — extend the `commit log ordering` describe in `tests/git/commits.test.ts`:

```ts
test("limits the initial walk to 300 commits like lazygit", async () => {
  const calls: string[][] = []
  const runner = {
    run: async (args: readonly string[]) => {
      calls.push([...args])
      return { exitCode: 0, stdout: "", stderr: "", record: {} as never }
    },
  }
  await listCommits(runner as never, "HEAD")
  // lazygit's `ArgIf(opts.Limit, "-300")` (commit_loader.go:597).
  expect(calls[0]).toContain("-300")
})

test("loads the full walk when explicitly unlimited", async () => {
  const calls: string[][] = []
  const runner = {
    run: async (args: readonly string[]) => {
      calls.push([...args])
      return { exitCode: 0, stdout: "", stderr: "", record: {} as never }
    },
  }
  await listCommits(runner as never, "HEAD", undefined, { limit: false })
  expect(calls[0]).not.toContain("-300")
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test tests/git/commits.test.ts -t "limits the initial walk"`
Expected: FAIL with `listCommits` ignoring the 4th argument (no `-300` in argv).

- [ ] **Step 3: Implement** in `src/git/commits.ts`:

```ts
/**
 * Initial commit-walk bound. lazygit limits the first load with `-300`
 * (`getLogCmd`, pkg/commands/git_commands/commit_loader.go:581-606) and only
 * loads the rest once the cursor passes the threshold; an unbounded walk on a
 * 27k-commit repo materializes megabytes of rows on every view update.
 */
export const COMMITS_LIMIT = 300
```

Change the signature and argv build:

```ts
export async function listCommits(
  runner: CommandRunner,
  range: string,
  filter?: string,
  options?: { readonly limit?: boolean },
): Promise<readonly CommitSummary[]> {
  // `--topo-order` is lazygit's default `git.log.order`: it keeps a branch's commits
  // contiguous so the rendered graph reads as lanes rather than an interleaved tangle.
  const args = ["log", "-z", "--topo-order", `--format=${LOG_FORMAT}`]
  if (options?.limit ?? true) args.push(`-${COMMITS_LIMIT}`)
  args.push(range)
  if (filter !== undefined && filter.length > 0) args.push("--", filter)
  // ... rest unchanged
}
```

- [ ] **Step 4: Run tests**

Run: `bun test tests/git/commits.test.ts`
Expected: PASS (all 5 tests: 3 existing + 2 new).

- [ ] **Step 5: Commit**

```bash
git add src/git/commits.ts tests/git/commits.test.ts
git commit -m "fix: cap initial commit walk at 300 like lazygit

Unbounded git log on a 27k-commit repo materializes megabytes of rows on
every view update. lazygit bounds the first load with -300 (pkg/commands/
git_commands/commit_loader.go:597); do the same, default-limited."
```

---

### Task 2: Controller limit flag, expand, branch re-limit

**Files:**
- Modify: `src/app/controller.ts` (`CommitListLoader` type near line 56, `loadCommitHistory` at 1270, `refreshTarget` flow, `loadBranchCommits` at 902, `switchLocalBranch` at 503)
- Test: `tests/app/controller.test.ts` (mirror the file-local `snapshot` helper and injected-`loadCommits` pattern at lines 22-30, 123-126)

**Interfaces:**
- Consumes: Task 1's `listCommits` options.
- Produces: `controller.expandCommits(): Promise<boolean>`, `controller.commitsLimited` read for tests, limited-by-default history for Task 4.

- [ ] **Step 1: Write the failing test** in `tests/app/controller.test.ts`:

```ts
describe("commit history limit", () => {
- [ ] **Step 4: Implement** in `src/ui/root-view.ts`:
        return options?.limit ?? true ? commits(300) : commits(1000)
      }) as never,
      loadBranches: async () => ({ detached: true, localBranches: [], remotes: [] }),
      loadStashes: async () => [],
      loadTags: async () => [],
      loadReflog: async () => [],
      loadWorktrees: async () => [],
      loadSubmodules: async () => [],
    })
    await controller.refresh()
    expect(controller.state.commits?.length).toBe(300)
    expect(seen[seen.length - 1]?.limit ?? true).toBe(true)
    const expanded = await controller.expandCommits()
    expect(expanded).toBe(true)
    expect(controller.state.commits?.length).toBe(1000)
    expect(seen[seen.length - 1]).toEqual({ limit: false })
    const again = await controller.expandCommits()
    expect(again).toBe(false)
  })
})
```

Notes: `snapshot` is the file-local helper already used at line 25 — reuse it, do not redefine. `loadCommits`'s declared type gains the third options param in the implementation step; the `as never` casts keep this test compiling before and after. If the file's `snapshot` helper has a different shape, adjust the `load:` line to match its neighbors exactly.

- [ ] **Step 2: Run to verify it fails**

Run: `bun test tests/app/controller.test.ts -t "loads a limited history first"`
Expected: FAIL with `expandCommits is not a function`.

- [ ] **Step 3: Implement** in `src/app/controller.ts`:

a) Extend the loader type (find `CommitListLoader` near the top of the file):

```ts
export type CommitListOptions = { readonly limit?: boolean }
export type CommitListLoader = (range: string, filter?: string, options?: CommitListOptions) => Promise<readonly CommitSummary[]>
```

b) Add the flag next to the other loader fields (`private generation = 0` area):

```ts
/**
 * Whether the commit history loads bounded. lazygit defaults its
 * `limitCommits` to true (pkg/gui/context/local_commits_context.go:224-235)
 * and only drops the bound once the cursor passes the threshold.
 */
private limitCommits = true
```

c) Thread it through `loadCommitHistory` and `loadBranchCommits`:

```ts
private async loadCommitHistory(range: string): Promise<{ readonly commits: readonly CommitSummary[]; readonly warning?: string }> {
  try {
    return { commits: await this.loadCommitList(range, undefined, { limit: this.limitCommits }) }
  } catch (error) {
    // ... unchanged
  }
}

async loadBranchCommits(branch: string): Promise<readonly CommitSummary[]> {
  return this.loadCommitList(`refs/heads/${branch}`, undefined, { limit: this.limitCommits })
}
```

d) Add the escape hatch after `loadBranchCommits`:

```ts
/**
 * Drops the 300-commit bound and reloads the full history, keeping the
 * current selection: the view preserves rows by stable id across the reload.
 * Returns whether a reload happened. The flag flips synchronously so rapid
 * repeated triggers cannot stack duplicate full reloads.
 */
async expandCommits(): Promise<boolean> {
  if (!this.limitCommits) return false
  this.limitCommits = false
  const history = await this.loadCommitHistory("HEAD")
  this.currentState = {
    ...this.currentState,
    commits: history.commits,
    ...this.commandLogSnapshot(),
    ...(history.warning === undefined ? {} : { banner: history.warning }),
  }
  return true
}
```

e) Re-limit on branch switch (lazygit re-limits on reset flows, `pkg/gui/controllers/helpers/refs_helper.go:43-44` — "loading a heap of commits is slow so we limit them"):

```ts
async switchLocalBranch(branch: string): Promise<void> {
  this.limitCommits = true
  this.logAction(LOG_ACTIONS.checkoutBranch)
  await this.runBranchMutation(() => this.requireRunnerOperation((runner) => switchLocal(runner, branch)))
}
```

- [ ] **Step 4: Run tests**

Run: `bun test tests/app/controller.test.ts tests/git/commits.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/app/controller.ts tests/app/controller.test.ts
git commit -m "feat: bound commit history with expand-on-demand

Mirrors lazygit limitCommits (local_commits_context.go:235): history loads
with -300 until the UI asks for the rest; branch switches re-arm the bound
(refs_helper.go:44)."
```

---

### Task 3: `loadCommits` seam through create-app and shell-harness

**Files:**
- Modify: `src/app/create-app.ts` (options type + `AppController` construction + view wiring area near lines 335-337)
- Modify: `tests/helpers/shell-harness.ts` (options + `createApp` call near lines 36-37, 164-173)

**Interfaces:**
- Consumes: Task 2's loader options type.
- Produces: injectable `loadCommits` for Task 4's UI test.

- [ ] **Step 1: Confirm construction shape** — read `create-app.ts` where `new AppController` is built and check whether it already forwards loader overrides (it forwards `loadBranchCommits` at line 336). No test to write: this task's verification is Task 4's test. (State this in the commit message.)

- [ ] **Step 2: Implement** — add to the create-app options type, mirroring the `loadBranchCommits` line:

```ts
/** Optional commit-history seam for embedded callers and tests. */
readonly loadCommits?: CommitListLoader
```

Forward it into the `AppController` construction alongside the other loaders, and forward it in `tests/helpers/shell-harness.ts` options + `createApp({...})` call the same way `loadBranchCommits` is forwarded (lines 36-37, 164-173).

- [ ] **Step 3: Typecheck**

Run: `bun run typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/app/create-app.ts tests/helpers/shell-harness.ts
git commit -m "refactor: expose loadCommits seam for tests and embedders

Same shape as the existing loadBranchCommits override; no behavior change."
```

---

### Task 4: O(1) edge jump plus auto-expand in root-view

**Files:**
- Modify: `src/ui/panes/commits-pane.ts` (export threshold)
- Modify: `src/ui/root-view.ts` (`actionJump` at 1938-1974, commits cursor case at 1784-1806, `handleGenericFilterKey` at 1618-1641, options near 226-230)
- Modify: `src/app/create-app.ts` (wire `onExpandCommits`)
- Test: create `tests/ui/commits-pagination.integration.test.ts`

**Interfaces:**
- Consumes: Tasks 2-3 (`expandCommits`, `loadCommits` seam).
- Produces: responsive `End`/`Home` on huge histories; the hang's actual fix.

- [ ] **Step 1: Export the threshold** from `src/ui/panes/commits-pane.ts`:

```ts
/**
 * Cursor index past which the full history loads. lazygit's
 * `COMMIT_THRESHOLD = 200` (pkg/gui/controllers/local_commits_controller.go:22):
 * past this point the user is browsing deep enough that the 300-cap must go.
 */
export const COMMIT_THRESHOLD = 200
```

- [ ] **Step 2: Write the failing UI test** as `tests/ui/commits-pagination.integration.test.ts`. Mirror `tests/ui/list-selection.integration.test.ts` for harness setup/key names. Test:

```ts
import { describe, expect, test } from "bun:test"
import { createShellHarness } from "../helpers/shell-harness"

function syntheticCommits(total: number) {
  return Array.from({ length: total }, (_, i) => ({
    oid: `oid-${String(i).padStart(5, "0")}`,
    shortOid: `s${i}`,
    parentOids: [],
    authorName: "Author",
    authoredAt: "2026-01-01T00:00:00Z",
    subject: `synthetic commit ${i}`,
  }))
}

describe("commits pagination", () => {
  test("End jumps to the oldest loaded commit after expanding", async () => {
    const all = syntheticCommits(1000)
    const harness = await createShellHarness({
      loadCommits: (async (_range: string, _filter?: string, options?: { readonly limit?: boolean }) =>
        (options?.limit ?? true ? all.slice(0, 300) : all)) as never,
    })
    try {
      // focus the commits pane, then End
      await harness.pressKey("tab") // adjust to match list-selection.test.ts focus steps
      await harness.pressKey("end")
      await harness.flush()
      const frame = harness.frame()
      expect(frame).toContain("synthetic commit 999")
    } finally {
      await harness.cleanup()
    }
  })
})
```

Calibrate in place: read `list-selection.integration.test.ts` for the exact focus/quit steps and `KeyInput` spelling of End (`"end"` per `src/ui/bindings.ts:308`). If the suite's frame helper differs, match it. The test fails before the fix because `End` on the limited-then-expanded list never reaches row 999 (and on a real 27k repo it hangs — the synthetic seam keeps the test fast).

- [ ] **Step 3: Run to verify it fails**

Run: `bun test tests/ui/commits-pagination.integration.test.ts`
Expected: FAIL with frame missing `synthetic commit 999`.

- [ ] **Step 4: Implement** in `src/ui/root-view.ts`:

a) Option + wiring (near `loadBranchCommits` option at line 227):

```ts
readonly onExpandCommits?: () => Promise<boolean>
```

In `create-app.ts`, next to `loadCommitInspection` (line 335):

```ts
onExpandCommits: async () => {
  const expanded = await controller.expandCommits()
  if (expanded && (screenController?.shouldRenderRepository() ?? true)) view.update(controller.state)
  return expanded
},
```

b) Threshold hook in the commits cursor case (`:1798-1803`), after `syncPreviewForFocus("commits")` in the main-list (non-child) branch:

```ts
this.maybeExpandCommits(nextView.selectedIndex)
```

with:

```ts
/**
 * lazygit loads the rest once the cursor passes `COMMIT_THRESHOLD`
 * (local_commits_controller.go:1790-1797). Fire-and-forget: the reload
 * preserves the selection by stable id, so navigation continues uninterrupted.
 */
private maybeExpandCommits(selectedIndex: number): void {
  if (this.commitsPanel.activeTab !== "commits") return
  if (this.commitsPanel.child !== undefined) return
  if (selectedIndex <= COMMIT_THRESHOLD) return
  void this.onExpandCommits?.()
}
```

c) Search hook in `actionFilter` when the commits search prompt opens (lazygit's
  `openSearch`, local_commits_controller.go:1672-1680). NOT per keystroke in
  `handleGenericFilterKey` — that was tried and reverted: the late expand
  `update` closes the in-progress filter session, so `RETURN` fell through to
  drill-down and broke the Commits-tab filter test. The expand repaint passes
  `{ preserveFilterInput: true }` (new `update()` option, create-app wiring)
  so the just-opened prompt survives:

```ts
// lazygit loads the full history when the commits search opens
// (`openSearch`, local_commits_controller.go:1672-1680): matches may live
// past row 300. The reload's repaint preserves this prompt (see `update`).
if (target.key === this.filterKey("commits", "commits")) {
  void this.onExpandCommits?.()
}
```

d) O(1) jump replacing the loop in `actionJump` (`:1958-1973`). Keep the `main` and `command-log` branches byte-identical; replace the list loop with:

```ts
// Lists jump directly: repeating the single-step move costs one O(rows)
// install plus one preview load per row, which hangs on 27k-commit histories.
this.clearTransientMenus()
const paneId = this.focusManager.active
if (paneId !== "files" && paneId !== "branches" && paneId !== "commits" && paneId !== "stash") return
if (paneId === "commits" && edge === "bottom") {
  this.jumpCommitsToBottom()
  return
}
const active = this.activeListView(paneId)
if (active === undefined || active.state.rows.length === 0) return
const rows = active.state.rows
const targetId = (edge === "bottom" ? rows[rows.length - 1] : rows[0])!.id
const direct = selectListRow(active.state, targetId)
if (direct === active.state) return
// A sticky range extends to the edge (one step would keep extending it);
// `selectListRow` clears ranges, so re-apply the sticky endpoints.
const next =
  active.state.rangeMode === "sticky" && active.state.rangeStartId !== undefined
    ? { ...direct, rangeMode: active.state.rangeMode, rangeStartId: active.state.rangeStartId }
    : direct
this.updateActiveListState(paneId, next)
this.renderListPane(paneId)
this.revealListRow(paneId, this.panes[paneId], next.selectedIndex)
this.syncListSelectionAfterChange(paneId)
this.root.requestRender()
```

with:

```ts
/**
 * `End` on commits first drops the 300-cap, then lands on the true oldest
 * commit: one reload plus one O(1) selection, instead of one preview load
 * and one full install per skipped row.
 */
private jumpCommitsToBottom(): void {
  void (async () => {
    await this.onExpandCommits?.()
    const active = this.activeListView("commits")
    if (active === undefined || active.state.rows.length === 0) return
    const rows = active.state.rows
    const direct = selectListRow(active.state, rows[rows.length - 1]!.id)
    if (direct === active.state) return
    const next =
      active.state.rangeMode === "sticky" && active.state.rangeStartId !== undefined
        ? { ...direct, rangeMode: active.state.rangeMode, rangeStartId: active.state.rangeStartId }
        : direct
    this.updateActiveListState("commits", next)
    this.renderListPane("commits")
    this.revealListRow("commits", this.panes.commits, next.selectedIndex)
    this.syncListSelectionAfterChange("commits")
    this.root.requestRender()
  })()
}
```

Check imports: `selectListRow` is already imported in root-view (used at 4112); `COMMIT_THRESHOLD` import from `./panes/commits-pane` alongside `buildCommitRows`. `selectListRow` returning the same object when unchanged is its documented behavior (list-view.ts:317-322).

e) `syncListSelectionAfterChange("commits")` on the main tab previews the commit exactly like the old per-step tail; `updateActiveListState("branches")` already carries the generation bump and invalidations (root-view.ts:1647-1651), and `clearTransientMenus()` preserves the old loop's first-step effect for files.

- [ ] **Step 5: Run tests**

Run: `bun test tests/ui/commits-pagination.integration.test.ts tests/ui/list-selection.integration.test.ts tests/ui/dispatch.integration.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/ui/root-view.ts src/ui/panes/commits-pane.ts src/app/create-app.ts tests/ui/commits-pagination.integration.test.ts
git commit -m "fix: O(1) list edge jump with lazy commit expansion

actionJump looped single-step moves (one O(rows) install + one git show per
row); End on 27k commits never returned. Jump directly and drop the 300-cap
past row 200, on End, and on search (local_commits_controller.go:22,1674,1793)."
```

---

### Task 5: Drill-down cap, docs note, full gate

**Files:**
- Covered by Task 2c (`loadBranchCommits` already passes the flag — verify).
- Modify: `docs/lazygit-compatibility-v0.1.md` row 3 (append one clause).
- Verify: full gate + real-repo timing.

- [ ] **Step 1: Verify the drill-down path** — `requestLocalBranchCommits` (root-view.ts:2999) calls injected `loadBranchCommits`, which defaults to `controller.loadBranchCommits` (create-app.ts:336), which now passes `{ limit }`. No code change; assert it in review. The child stays capped without its own expand in v1 (matches the existing v0.1 scope comment at root-view.ts:1152-1155); `End` inside the child still lands instantly via the O(1) jump.

- [ ] **Step 2: Docs note** — append to row 3's cell in `docs/lazygit-compatibility-v0.1.md`: `Initial load is capped at the latest 300 (`-300`, commit_loader.go:597); crossing row 200, End, or commits search loads the rest.` Keep the `compatible` status.

- [ ] **Step 3: Real-repo verification** (evidence before assertions) — with hermes-agent at `/home/noah/githunk/hermes-agent`, run under `timeout -s KILL` guards, never unguarded:

```bash
cat > /tmp/verify-pagination.ts <<'EOF'
import { createTestRenderer } from "@opentui/core/testing";
import { createApp } from "/home/noah/githunk/src/app/create-app.ts";
import { GitRunner } from "/home/noah/githunk/src/git/runner.ts";
const setup = await createTestRenderer({ width: 120, height: 40, useMouse: true });
const app = createApp({ repositoryRoot: "/home/noah/githunk/hermes-agent", runner: new GitRunner("/home/noah/githunk/hermes-agent"), renderer: setup.renderer });
let t0 = performance.now();
await app.refresh();
console.log("initial refresh:", (performance.now()-t0).toFixed(0), "ms");
process.exit(0);
EOF
cd /home/noah/githunk && timeout -s KILL 90 bun /tmp/verify-pagination.ts
```

Expected: initial refresh well under the pre-fix ~1155ms and `commits.length === 300`. Then expand timing via a second script calling the wired expand (or the integration test). Record the numbers in the commit message / PR description.

- [ ] **Step 4: Run the gate**

Run: `bun run check`
Expected: PASS (`tsc --noEmit && bun test`).

- [ ] **Step 5: Commit docs**

```bash
git add docs/lazygit-compatibility-v0.1.md
git commit -m "docs: note 300-commit initial cap with lazy expansion"
```

---

## Self-Review

- Spec coverage: initial-300 ✓ (T1+T2), scroll-past-200 expansion ✓ (T4b), End-to-oldest ✓ (T4d), search expansion ✓ (T4c), branch drill-down bounded ✓ (T5 — capped, no child expand, documented), no-hang verification with kill guards ✓ (T5).
- No placeholders: every step names exact files, line anchors, runnable commands, and expected outputs.
- Type consistency: `CommitListOptions`/`CommitListLoader` names are used identically in T1–T3; `onExpandCommits: () => Promise<boolean>` matches controller and view; `COMMIT_THRESHOLD` has one definition site.
