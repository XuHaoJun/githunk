# Lazygit Core UI Parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Align githunk's core side panels, commit inspection, tabs, list selection, mouse input, scrolling, scrollbars, and Stash sizing with the vendored lazygit behavior.

**Architecture:** Numbered windows own focus and geometry; tab views and transient children own typed list state. Repository loaders return stable entities, while RootView owns inspection navigation and one global Main-preview generation. Shared list and pane primitives provide full-row selection, mouse hit testing, viewport scrolling, and interactive scrollbars without duplicating state in each pane.

**Tech Stack:** TypeScript 5.9, Bun 1.4 tests/runtime, OpenTUI 0.5.6, Git CLI, PTY-backed OpenTUI test harness.

**Spec:** `docs/superpowers/specs/2026-08-25-lazygit-core-ui-parity-design.md`

## Global Constraints

- The behavior reference is the vendored `learn-projects/lazygit/` checkout.
- Preserve exactly three githunk extensions: Main application-aware selection/copy, the lower-right review/command-log region, and draggable splitters.
- `[` and `]` switch tabs only in a focused multi-tab window; they are unhandled in Main and the single-view Files window.
- Commit browsing never changes `reviewTarget`, `branchReviewTarget`, or review-progress identity.
- Main owns one preview generation across every preview source; stale results never render.
- No patch-size threshold substitutes a file list for metadata + stat + patch.
- OpenTUI `TextRenderable` wheel and `ScrollBarRenderable` synchronization must be wired explicitly.
- Mouse gestures have one captured owner and cannot fall through to another interaction.
- Every task uses TDD and commits only its own files.

---

## File Structure

### New source files

- `src/ui/list-view.ts` — pure stable-selection reducer, typed display-row map, width-safe styled list rendering, and mouse row hit testing.
- `src/ui/panel-state.ts` — tab cycling and transient parent/child transitions for numbered windows.
- `src/ui/commit-graph.ts` — compact graph-lane calculation from ordered commit OIDs and parent OIDs.
- `src/domain/tag.ts` — tag summary and preview types.
- `src/git/tags.ts` — real tag list and preview loading.
- `src/ui/panes/tags-pane.ts` — Tags list rows and stable selection.
- `src/ui/panes/remotes-pane.ts` — configured Remotes and transient RemoteBranches list rows.

### Existing source files with changed responsibility

- `src/ui/panes/common.ts` — PaneHandle viewport API and two-way interactive scrollbar synchronization.
- `src/ui/panes/{files,branches,commits,stash}-pane.ts` — consume shared list state and render full-row highlight; no arrow markers.
- `src/ui/panes/main-pane.ts` — render commit preamble plus patch and enforce preview selection/viewport lifecycle.
- `src/ui/layout.ts` — lazygit normal/compact side-window sizing and current-side-window input.
- `src/ui/focus.ts` — retain the most recently focused side window.
- `src/ui/bindings.ts` — replace Main scope actions with panel tab actions.
- `src/ui/root-view.ts` — compose panel state, transient views, global preview generation, click/double-click dispatch, wheel routing, and drag capture.
- `src/domain/{branch,commit,repository}.ts` — richer branch/remote/commit/tag read models without changing review identity.
- `src/git/{branches,commits}.ts` — load row metadata, commit stat/preamble, and stable file identity.
- `src/app/controller.ts` — expose read-only inspection loaders and remove commit drill-down mutation of the global review target.
- `src/app/create-app.ts` — wire read-only inspection/tag callbacks.
- `docs/lazygit-compatibility-v0.1.md` — status matrix using only the spec's four statuses.

---

### Task 1: Shared Stable List and Panel State

**Files:**
- Create: `src/ui/list-view.ts`
- Create: `src/ui/panel-state.ts`
- Test: `tests/ui/list-view.test.ts`
- Test: `tests/ui/panel-state.test.ts`

**Interfaces:**
- Produces: `ListColumn`, `ListRow`, `ListDisplayRow`, `ListState`, `createListState`, `setListRows`, `moveListSelection`, `selectListRow`, `listRowAtPoint`, `renderListRows`.
- Produces: `PanelState<TTab, TChild>`, `createPanelState`, `updatePanelView`, `cyclePanelTab`, `enterPanelChild`, `leavePanelChild`.
- `ListRow.id` is the only persistent selection identity. `ListState.displayRows` explicitly maps item rows and excludes headers, blank states, and loading/error rows from selection.

- [ ] **Step 1: Write failing stable-selection and hit-test tests**

```ts
// tests/ui/list-view.test.ts
import { describe, expect, test } from "bun:test"
import { createListState, listRowAtPoint, moveListSelection, selectListRow, setListRows } from "../../src/ui/list-view"

const rows = [
  { id: "a", columns: [{ text: "alpha", priority: 0 }] },
  { id: "b", columns: [{ text: "beta", priority: 0 }] },
  { id: "c", columns: [{ text: "gamma", priority: 0 }] },
] as const

describe("stable list state", () => {
  test("preserves ID and clamps the previous numeric index when an item disappears", () => {
    let state = selectListRow(createListState(rows), "b")
    state = setListRows(state, [rows[0]!, rows[2]!])
    expect(state.selectedId).toBe("c")
    expect(state.selectedIndex).toBe(1)
  })

  test("maps a visible click through scrollY and rejects borders and blank rows", () => {
    const geometry = { screenX: 10, screenY: 5, width: 20, height: 2, scrollY: 1 }
    expect(listRowAtPoint(createListState(rows), geometry, 12, 5)?.id).toBe("b")
    expect(listRowAtPoint(createListState(rows), geometry, 12, 7)).toBeUndefined()
    expect(listRowAtPoint(createListState(rows), geometry, 9, 5)).toBeUndefined()
  })

  test("keyboard movement and direct selection share one state", () => {
    const selected = moveListSelection(selectListRow(createListState(rows), "a"), "next")
    expect(selected).toMatchObject({ selectedId: "b", selectedIndex: 1 })
  })
})
```

- [ ] **Step 2: Write failing tab/transient tests**

```ts
// tests/ui/panel-state.test.ts
import { describe, expect, test } from "bun:test"
import { createPanelState, cyclePanelTab, enterPanelChild, leavePanelChild, updatePanelView } from "../../src/ui/panel-state"
import { createListState, selectListRow } from "../../src/ui/list-view"

const panelRows = [
  { id: "a", columns: [{ text: "alpha", priority: 0 }] },
  { id: "b", columns: [{ text: "beta", priority: 0 }] },
] as const

describe("panel state", () => {
  test("cycles tabs with wraparound and preserves per-tab selection and scroll", () => {
    const views = { branches: createListState(panelRows), remotes: createListState(panelRows), tags: createListState(panelRows) }
    let panel = createPanelState(["branches", "remotes", "tags"] as const, "branches", views)
    panel = updatePanelView(panel, "branches", { ...selectListRow(panel.views.branches, "b"), scrollY: 2 })
    panel = cyclePanelTab(panel, "previous")
    expect(panel.activeTab).toBe("tags")
    panel = cyclePanelTab(panel, "next")
    expect(panel.activeTab).toBe("branches")
    expect(panel.views.branches).toMatchObject({ selectedId: "b", scrollY: 2 })
  })

  test("bracket navigation leaves a transient child before changing parent tab", () => {
    let panel = createPanelState(["branches", "remotes", "tags"] as const, "remotes", { branches: createListState([]), remotes: createListState([]), tags: createListState([]) })
    panel = enterPanelChild(panel, { kind: "remote-branches", remote: "origin" }, createListState([]))
    panel = cyclePanelTab(panel, "next")
    expect(panel.activeTab).toBe("tags")
    expect(panel.child).toBeUndefined()
  })

  test("escape restores the parent tab without changing it", () => {
    let panel = createPanelState(["branches", "remotes", "tags"] as const, "remotes", { branches: createListState([]), remotes: createListState([]), tags: createListState([]) })
    panel = leavePanelChild(enterPanelChild(panel, { kind: "remote-branches", remote: "origin" }, createListState([])))
    expect(panel.activeTab).toBe("remotes")
  })
})
```

- [ ] **Step 3: Run tests and verify missing-module failure**

Run: `bun test tests/ui/list-view.test.ts tests/ui/panel-state.test.ts`

Expected: FAIL because `src/ui/list-view.ts` and `src/ui/panel-state.ts` do not exist.

- [ ] **Step 4: Implement the pure interfaces**

```ts
// src/ui/list-view.ts
import { StyledText, bgBlue } from "@opentui/core"

export type ListColumn = {
  readonly text: string
  readonly priority: number
  readonly style?: "default" | "dim" | "cyan" | "green" | "yellow" | "magenta"
}
export type ListRow = { readonly id: string; readonly columns: readonly ListColumn[] }
export type ListDisplayRow =
  | { readonly kind: "item"; readonly id: string }
  | { readonly kind: "header" | "message"; readonly text: string }

export type ListState = {
  readonly rows: readonly ListRow[]
  readonly displayRows: readonly ListDisplayRow[]
  readonly selectedId?: string
  readonly selectedIndex: number
  readonly scrollY: number
}

export type ListViewport = {
  readonly screenX: number
  readonly screenY: number
  readonly width: number
  readonly height: number
  readonly scrollY: number
}

export function createListState(rows: readonly ListRow[], displayRows?: readonly ListDisplayRow[]): ListState
export function setListRows(state: ListState, rows: readonly ListRow[], displayRows?: readonly ListDisplayRow[]): ListState
export function moveListSelection(state: ListState, direction: "next" | "previous"): ListState
export function selectListRow(state: ListState, id: string): ListState
export function listRowAtPoint(state: ListState, viewport: ListViewport, x: number, y: number): ListRow | undefined
export function renderListRows(state: ListState, focused: boolean, width: number): StyledText
```

`setListRows` first searches for `selectedId`; if absent it retains `selectedIndex` when in range, otherwise clamps to the final row. Empty rows produce index `0` with no ID. `renderListRows` resolves `displayRows`, allocates columns by ascending priority, maps style tokens to OpenTUI chunks, pads the selected line to `width`, and applies `bgBlue`; it never adds a selection glyph.


```ts
// src/ui/panel-state.ts
import type { ListState } from "./list-view"

export type PanelState<TTab extends string, TChild> = {
  readonly tabs: readonly TTab[]
  readonly activeTab: TTab
  readonly views: Readonly<Record<TTab, ListState>>
  readonly child?: { readonly parentTab: TTab; readonly value: TChild; readonly view: ListState }
}

export function createPanelState<TTab extends string, TChild = never>(tabs: readonly TTab[], activeTab: TTab, views: Readonly<Record<TTab, ListState>>): PanelState<TTab, TChild>
export function updatePanelView<TTab extends string, TChild>(state: PanelState<TTab, TChild>, tab: TTab, view: ListState): PanelState<TTab, TChild>
export function cyclePanelTab<TTab extends string, TChild>(state: PanelState<TTab, TChild>, direction: "next" | "previous"): PanelState<TTab, TChild>
export function enterPanelChild<TTab extends string, TChild>(state: PanelState<TTab, TChild>, child: TChild, view: ListState): PanelState<TTab, TChild>
export function leavePanelChild<TTab extends string, TChild>(state: PanelState<TTab, TChild>): PanelState<TTab, TChild>
```

- [ ] **Step 5: Run focused tests**

Run: `bun test tests/ui/list-view.test.ts tests/ui/panel-state.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/ui/list-view.ts src/ui/panel-state.ts tests/ui/list-view.test.ts tests/ui/panel-state.test.ts
git commit -m "feat: add stable list and panel state"
```

---

### Task 2: Rich Git Read Models for Branches, Remotes, Tags, and Commit Preambles

**Files:**
- Create: `src/domain/tag.ts`
- Create: `src/git/tags.ts`
- Modify: `src/domain/branch.ts`
- Modify: `src/domain/commit.ts`
- Modify: `src/domain/repository.ts`
- Modify: `src/git/branches.ts`
- Modify: `src/git/commits.ts`
- Modify: `src/app/controller.ts`
- Modify: `tests/app/controller.test.ts`
- Test: `tests/git/branches.test.ts`
- Test: `tests/git/commits.test.ts`
- Test: `tests/git/tags.test.ts`

**Interfaces:**
- Produces `TagSummary`, `TagPreview`, `listTags(runner)`, and `loadTagPreview(runner, tag)`.
- Extends `LocalBranch` with `committedAt`, `subject`, and `upstreamTrack`; extends `Remote` with `fetchUrl` and `pushUrl`.
- Extends `CommitDetails` with `preamble`; `preamble` is the exact text before the first `diff --git`/`diff --cc` and includes metadata, message, and stat.
- Adds `AppModel.tags?: readonly TagSummary[]`, `TagListLoader = () => Promise<readonly TagSummary[]>`, and controller option `loadTags?: TagListLoader`.
- Produces read-only controller methods `loadCommitInspection`, `loadCommitFileInspection`, and `loadTagInspection`. These return data and do not mutate `AppModel.reviewTarget`.

- [ ] **Step 1: Add failing repository-backed branch and remote assertions**

Add to `tests/git/branches.test.ts`:

```ts
test("loads branch recency, subject, upstream track, and remote URLs", async () => {
  const listing = await listBranches(runner)
  const current = listing.localBranches.find((branch) => branch.isCurrent)!
  expect(current.committedAt).toMatch(/^\d+$/)
  expect(current.subject.length).toBeGreaterThan(0)
  expect(listing.remotes[0]).toMatchObject({
    name: "origin",
    fetchUrl: expect.any(String),
    pushUrl: expect.any(String),
  })
})
```

Use a bare temporary repository as `origin`, push the current branch, add one unpushed commit, and assert `current.upstreamTrack` contains the Git-provided ahead state.

- [ ] **Step 2: Add failing commit preamble assertion**

Extend the existing commit details test in `tests/git/commits.test.ts`:

```ts
expect(details.preamble).toContain("Author:")
expect(details.preamble).toContain("1 file changed")
expect(details.preamble).not.toContain("diff --git")
expect(details.document.text).toContain("diff --git")
```

- [ ] **Step 3: Add failing tag loader tests**

```ts
// tests/git/tags.test.ts
import { afterEach, describe, expect, test } from "bun:test"
import { GitRunner } from "../../src/git/runner"
import { listTags, loadTagPreview } from "../../src/git/tags"
import { createTempRepository, type TempRepository } from "../helpers/temp-repository"

describe("tag loaders", () => {
  let repository: TempRepository | undefined
  afterEach(async () => repository?.cleanup())

  test("distinguishes lightweight and annotated tags and loads annotated metadata", async () => {
    repository = await createTempRepository()
    await repository.write("a.txt", "a\n")
    await repository.git(["add", "."])
    await repository.git(["commit", "-m", "tag target"])
    await repository.git(["tag", "light"])
    await repository.git(["tag", "-a", "annotated", "-m", "release message"])
    const runner = new GitRunner(repository.path)
    const tags = await listTags(runner)
    expect(tags.map((tag) => [tag.name, tag.kind])).toEqual([
      ["annotated", "annotated"],
      ["light", "lightweight"],
    ])
    const preview = await loadTagPreview(runner, tags[0]!)
    expect(preview.message).toContain("release message")
    expect(preview.targetCommit.subject).toBe("tag target")
  })
})
```

Add to `tests/app/controller.test.ts`:

```ts
test("refresh publishes the real tag list", async () => {
  const tags = [{ name: "v1", ref: "refs/tags/v1", kind: "lightweight", objectOid: "a", targetOid: "a", subject: "release" }] as const
  const controller = new AppController({
    load: async (target) => snapshot(target.scope, ""),
    loadTags: async () => tags,
  })
  await controller.refresh()
  expect(controller.state.tags).toEqual(tags)
})
```

- [ ] **Step 4: Run focused tests and verify failures**

Run: `bun test tests/git/branches.test.ts tests/git/commits.test.ts tests/git/tags.test.ts tests/app/controller.test.ts`

Expected: FAIL on missing fields/module and absent commit stat.

- [ ] **Step 5: Implement exact read models and Git commands**

```ts
// src/domain/tag.ts
import type { CommitSummary } from "./commit"

export type TagSummary = {
  readonly name: string
  readonly ref: string
  readonly kind: "annotated" | "lightweight"
  readonly objectOid: string
  readonly targetOid: string
  readonly subject: string
  readonly taggerName?: string
  readonly taggedAt?: string
  readonly message?: string
}

export type TagPreview = TagSummary & { readonly targetCommit: CommitSummary }
```

Use one `for-each-ref` command with NUL fields:

```ts
[
  "for-each-ref",
  "--sort=refname",
  "--format=%(refname:short)%00%(refname)%00%(objecttype)%00%(objectname)%00%(*objectname)%00%(subject)%00%(taggername)%00%(taggerdate:iso-strict)%00%(contents)%00",
  "refs/tags",
]
```

For annotated tags, `targetOid` is `*objectname`; for lightweight tags it is `objectname`. Resolve the target commit with `listCommits(runner, `${targetOid}^!`)` and require exactly one result.

Extend branch `for-each-ref` format with `%(committerdate:unix)`, `%(subject)`, and `%(upstream:track)`. Load `git remote get-url <name>` and `git remote get-url --push <name>` for each configured remote. Preserve `--` safety where the Git subcommand accepts it.

Change `loadCommit` to pass `--stat` before `-m`; calculate `preamble` from the accepted patch offset instead of parsing display text.

Initialize `loadTagsListing` in the controller constructor from `options.loadTags`, or `() => listTags(runner)` when a runner exists. In `refresh()`, load branches, stashes, and tags together, publish all three only for the current refresh generation, and retain the last successful tag list on failure.

Add controller loaders:

```ts
async loadCommitInspection(oid: string): Promise<CommitDetails>
async loadCommitFileInspection(oid: string, path: string): Promise<DiffDocument>
async loadTagInspection(tag: TagSummary): Promise<TagPreview>
```

Remove mutation from these methods. Keep existing mutation-facing APIs until Task 5 performs the clean UI cutover.

- [ ] **Step 6: Run focused tests**

Run: `bun test tests/git/branches.test.ts tests/git/commits.test.ts tests/git/tags.test.ts tests/app/controller.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/domain/tag.ts src/domain/branch.ts src/domain/commit.ts src/domain/repository.ts src/git/tags.ts src/git/branches.ts src/git/commits.ts src/app/controller.ts tests/git/branches.test.ts tests/git/commits.test.ts tests/git/tags.test.ts tests/app/controller.test.ts
git commit -m "feat: load lazygit panel metadata"
```

---

### Task 3: Compact Commit Graph and Full-Row Commit Rendering

**Files:**
- Create: `src/ui/commit-graph.ts`
- Modify: `src/ui/panes/commits-pane.ts`
- Test: `tests/ui/commit-graph.test.ts`
- Test: `tests/ui/commits-pane.test.ts`

**Interfaces:**
- Consumes: Task 1 `ListState`/`renderListRows` and existing `CommitSummary.parentOids`.
- Produces: `commitGraphRows(commits): readonly string[]` with one fixed-width graph segment per commit.
- Commits pane returns the shared `ListState`; RootView uses Task 1 `selectListRow` and `listRowAtPoint` directly, so keyboard and mouse cannot diverge.

- [ ] **Step 1: Write failing graph topology tests**

```ts
// tests/ui/commit-graph.test.ts
import { describe, expect, test } from "bun:test"
import { commitGraphRows } from "../../src/ui/commit-graph"

const commit = (oid: string, parentOids: readonly string[]) => ({
  oid, shortOid: oid, parentOids, authorName: "A", authoredAt: "2026-01-01T00:00:00Z", subject: oid, body: "",
})

describe("commit graph", () => {
  test("renders aligned linear ancestry", () => {
    const rows = commitGraphRows([commit("c", ["b"]), commit("b", ["a"]), commit("a", [])])
    expect(rows).toHaveLength(3)
    expect(new Set(rows.map((row) => row.length)).size).toBe(1)
    expect(rows.every((row) => row.includes("●") || row.includes("│"))).toBe(true)
  })

  test("opens and converges lanes for a merge", () => {
    const rows = commitGraphRows([
      commit("m", ["left", "right"]), commit("right", ["base"]), commit("left", ["base"]), commit("base", []),
    ])
    expect(rows.join("\n")).toContain("┬")
    expect(rows.at(-1)).toContain("●")
  })

  test("keeps a side branch in a distinct lane until convergence", () => {
    const rows = commitGraphRows([
      commit("tip", ["main"]), commit("side", ["base"]), commit("main", ["base"]), commit("base", []),
    ])
    expect(rows[1]).not.toBe(rows[2])
    expect(rows.at(-1)?.trim()).toBe("●")
  })
})
```

- [ ] **Step 2: Write failing commit row tests**

```ts
// tests/ui/commits-pane.test.ts
expect(renderCommitRows(commits, { selectedId: commits[0]!.oid, focused: true, width: 80 }).plainText)
  .toContain("Author Name")
expect(renderCommitRows(commits, { selectedId: commits[0]!.oid, focused: true, width: 80 }).plainText)
  .not.toContain("▸")
expect(renderCommitRows(commits, { selectedId: commits[0]!.oid, focused: false, width: 30 }).plainText.length)
  .toBeLessThanOrEqual(30 * commits.length)
```

Also inspect the selected row's chunks and assert a background style exists only when `focused` is true.

- [ ] **Step 3: Run tests and verify failures**

Run: `bun test tests/ui/commit-graph.test.ts tests/ui/commits-pane.test.ts`

Expected: FAIL on missing graph renderer and current arrow marker.

- [ ] **Step 4: Implement graph lanes and commit columns**

Use an ordered `lanes: string[]`. For each commit, select or create its lane, render the node, replace that lane with its first parent, insert additional parents to the right, remove empty lanes, and emit convergence connectors. Pad every graph segment to the maximum lane width for the supplied commit set.

Expose:

```ts
export function renderCommitRows(
  commits: readonly CommitSummary[],
  options: { readonly selectedId?: string; readonly focused: boolean; readonly width: number },
): { readonly content: StyledText; readonly plainText: string; readonly state: ListState }
```

Allocate width in this order: graph, hash, subject, author, relative time. Drop time then author before truncating subject. Use `Intl.RelativeTimeFormat("en", { numeric: "auto" })` with a fixed injected `now` in unit tests.

- [ ] **Step 5: Run focused tests**

Run: `bun test tests/ui/commit-graph.test.ts tests/ui/commits-pane.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/ui/commit-graph.ts src/ui/panes/commits-pane.ts tests/ui/commit-graph.test.ts tests/ui/commits-pane.test.ts
git commit -m "feat: render lazygit commit rows"
```

---

### Task 4: Branches, Remotes, Tags Tabs and Remote Child

**Files:**
- Create: `src/ui/panes/remotes-pane.ts`
- Create: `src/ui/panes/tags-pane.ts`
- Modify: `src/ui/panes/branches-pane.ts`
- Modify: `src/ui/bindings.ts`
- Modify: `src/ui/root-view.ts`
- Modify: `src/app/create-app.ts`
- Test: `tests/ui/branches-pane.test.ts`
- Test: `tests/ui/panel-tabs.integration.test.ts`
- Test: `tests/ui/bindings.test.ts`
- Test: `tests/app/remote-checkout.test.ts`

**Interfaces:**
- Consumes: Task 1 panel/list state and Task 2 `AppModel.tags`, `TagSummary`, and enriched `BranchListing`.
- Produces RootView `branchesPanel: PanelState<"branches" | "remotes" | "tags", { kind: "remote-branches"; remote: string }>`.
- Adds actions `tab-next` and `tab-previous`; deletes `scope-next` and `scope-previous` from `ACTIONS`, bindings, handlers, menus, and hints.

- [ ] **Step 1: Replace mixed-pane tests with tab-specific failing tests**

```ts
// tests/ui/branches-pane.test.ts
expect(localBranchRows(model).every((row) => row.id.startsWith("local:"))).toBe(true)
expect(remoteRows(model).map((row) => row.id)).toEqual(["remote:origin"])
expect(remoteBranchRows(model, "origin").map((row) => row.id)).toEqual(["remote-branch:origin/feature/foo"])
expect(tagRows(model).map((row) => row.id)).toEqual(["tag:refs/tags/v1"])
```

Assert Local Branch rows show recency/current/upstream track without adding metadata headers as selectable rows.

- [ ] **Step 2: Add failing keyboard integration tests**

```ts
// tests/ui/panel-tabs.integration.test.ts
await harness.pressKey("3")
expect(view.activeBranchesTab).toBe("branches")
await harness.pressKey("]")
expect(view.activeBranchesTab).toBe("remotes")
await harness.pressKey("]")
expect(view.activeBranchesTab).toBe("tags")
await harness.pressKey("]")
expect(view.activeBranchesTab).toBe("branches")
await harness.pressKey("0")
await harness.pressKey("]")
expect(view.activeBranchesTab).toBe("branches")
expect(harness.app.controller.state.reviewTarget).toEqual(beforeTarget)
```

Add a configured remote, press Enter on Remotes, assert window 3 shows RemoteBranches and Escape restores the same remote selection. Press `]` inside RemoteBranches and assert it closes the child and activates Tags.

Run the existing remote checkout suite unchanged as a non-regression contract: created tracking branches, matching existing branches, and upstream mismatches must retain their current safe behavior.

- [ ] **Step 3: Run focused tests and verify failures**

Run: `bun test tests/ui/branches-pane.test.ts tests/ui/panel-tabs.integration.test.ts tests/ui/bindings.test.ts tests/app/remote-checkout.test.ts`

Expected: FAIL because tabs/actions/panes do not exist and Main still owns bracket scope bindings.

- [ ] **Step 4: Implement tab-specific panes and bindings**

Define row IDs exactly:

```ts
local:${branch.name}
remote:${remote.name}
remote-branch:${branch.ref}
tag:${tag.ref}
```

Render panel 3 title as `3 Local Branches | Remotes | Tags`, with the active tab title styled. Add `tab-next`/`tab-previous` bindings in `branches` context for `]`/`[` only. RootView's action handler calls `cyclePanelTab`; when a child exists, the reducer closes it before switching.

Remove `SCOPE_ORDER`, `actionScopeCycle`, `onScopeChange` from RootView options, and the corresponding `create-app.ts` callback. Do not remove `AppController.setWorkingTreeScope`; Files/staging parity owns that later cutover.

This task renders and navigates the three lists only. Tag, Remote, and RemoteBranches Main previews are wired through the global gate in Task 5, after that gate exists. Existing remote checkout callbacks remain functional.

- [ ] **Step 5: Run focused tests**

Run: `bun test tests/ui/branches-pane.test.ts tests/ui/panel-tabs.integration.test.ts tests/ui/bindings.test.ts tests/app/remote-checkout.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/ui/panes/branches-pane.ts src/ui/panes/remotes-pane.ts src/ui/panes/tags-pane.ts src/ui/bindings.ts src/ui/root-view.ts src/app/create-app.ts tests/ui/branches-pane.test.ts tests/ui/panel-tabs.integration.test.ts tests/ui/bindings.test.ts
git commit -m "feat: add lazygit branch panel tabs"
```

---

### Task 5: Global Main Preview Gate and CommitFiles Transient Context

**Files:**
- Create: `src/ui/main-preview.ts`
- Create: `src/ui/panes/commit-files-pane.ts`
- Modify: `src/domain/repository.ts`
- Modify: `src/app/controller.ts`
- Modify: `src/app/create-app.ts`
- Modify: `src/ui/panes/main-pane.ts`
- Modify: `src/ui/panes/commits-pane.ts`
- Modify: `src/ui/panes/files-pane.ts`
- Modify: `src/ui/panes/branches-pane.ts`
- Modify: `src/ui/panes/remotes-pane.ts`
- Modify: `src/ui/panes/tags-pane.ts`
- Modify: `src/ui/panes/stash-pane.ts`
- Modify: `src/ui/root-view.ts`
- Modify: `tests/app/commit-drilldown.test.ts`
- Modify: `tests/git/commits.test.ts`
- Modify: `tests/ui/dispatch.integration.test.ts`
- Test: `tests/ui/preview-generation.test.ts`

**Interfaces:**
- Consumes Task 2 inspection loaders, Task 4 panel tabs, and Task 1 transient panel state.
- RootView owns `commitsPanel: PanelState<"commits", { kind: "commit-files"; oid: string; details: CommitDetails }>`.
- Produces `MainPaneContent` and `MainPreviewGate`.
- Adds `RootViewOptions.loadCommitInspection`, `loadCommitFileInspection`, `loadTagInspection`, and `onPreviewError`.

```ts
export type MainPaneContent = {
  readonly source: "files" | "local-branch" | "remote" | "remote-branch" | "tag" | "commit" | "commit-file" | "stash"
  readonly stableId: string
  readonly label: string
  readonly preamble?: string
  readonly document?: DiffDocument
  readonly plainText?: string
}
```

- [ ] **Step 1: Change controller tests to require read-only inspection**

Replace current `reviewTarget.kind === "commit"` expectations in `tests/app/commit-drilldown.test.ts`:

```ts
const target = controller.state.reviewTarget
const branchTarget = controller.state.branchReviewTarget
const details = await controller.loadCommitInspection("commit-1")
expect(details.oid).toBe("commit-1")
expect(controller.state.reviewTarget).toEqual(target)
expect(controller.state.branchReviewTarget).toEqual(branchTarget)
expect("commitDetails" in controller.state).toBe(false)
expect("commitFilePath" in controller.state).toBe(false)
```

Add an allow-empty commit and assert `details.document.files` is empty without changing state. Reject `loadCommitInspection` and assert the prior state remains intact.

- [ ] **Step 2: Add failing global generation and Main lifecycle tests**

```ts
// tests/ui/preview-generation.test.ts
const installed: MainPaneContent[] = []
const loading: boolean[] = []
const errors: unknown[] = []
const gate = new MainPreviewGate({
  install: (content) => installed.push(content),
  setLoading: (value) => loading.push(value),
  reportError: (error) => errors.push(error),
})
const first = deferred<CommitDetails>()
const second = deferred<CommitDetails>()
const oldRequest = gate.request("commit", "old", () => first.promise, presentCommit)
const newRequest = gate.request("commit", "new", () => second.promise, presentCommit)
second.resolve(newDetails)
await newRequest
first.resolve(oldDetails)
await oldRequest
expect(installed.at(-1)?.stableId).toBe("new")
expect(installed.some((content) => content.stableId === "old")).toBe(false)
```

Add a cross-source case: begin a Tag request, call `installSynchronous(filesContent)`, then resolve Tag and assert Files remains installed and loading is false. Reject the current request and assert `errors` receives it while installed content remains.

Add Main pane lifecycle assertions:

```ts
view.installMainContent(sameIdentitySameText)
expect(view.mainScrollY).toBe(12)
expect(view.hasMainSelection).toBe(true)
view.installMainContent(sameIdentityChangedText)
expect(view.mainScrollY).toBeLessThanOrEqual(view.mainPane.text.maxScrollY)
expect(view.hasMainSelection).toBe(false)
view.installMainContent(otherIdentity)
expect(view.mainScrollY).toBe(0)
expect(view.mainScrollX).toBe(0)
```

While a request is loading, assert prior Main text and selection remain visible. A source or stable-ID replacement resets both viewport axes and clears selection. Same identity plus byte-for-byte identical rendered text preserves selection; changed text clears it and clamps the viewport.

- [ ] **Step 3: Add failing CommitFiles and large-patch tests**

In `tests/ui/dispatch.integration.test.ts`, press Enter in Commits:

```ts
const beforeTarget = controller.state.reviewTarget
await harness.pressKey("RETURN")
await harness.settle()
expect(controller.state.reviewTarget).toEqual(beforeTarget)
expect(view.commitsContextKind).toBe("commit-files")
expect(view.focusManager.active).toBe("commits")
```

Move through two commit files and assert Main stable ID/path changes. Escape restores the parent commit OID and metadata/stat/patch. A failed details load leaves `commitsContextKind === "commits"`. An allow-empty commit opens the child with a nonselectable `No files` message and retains its commit preview.

In `tests/git/commits.test.ts`, create a commit with 5,000 added lines:

```ts
const details = await loadCommit(runner, oid)
expect(details.preamble).toContain("5000 insertions")
expect(details.document.text).toContain("+line 1")
expect(details.document.text).toContain("+line 5000")
expect(details.document.files).toHaveLength(1)
```

This proves there is no size-triggered file-list fallback.

- [ ] **Step 4: Run focused tests and verify failures**

Run: `bun test tests/app/commit-drilldown.test.ts tests/ui/dispatch.integration.test.ts tests/ui/preview-generation.test.ts tests/git/commits.test.ts`

Expected: FAIL because Enter mutates `reviewTarget`, Main has no global gate, and large-patch behavior is not explicitly covered.

- [ ] **Step 5: Implement MainPreviewGate**

```ts
// src/ui/main-preview.ts
import type { MainPaneContent } from "./panes/main-pane"

export class MainPreviewGate {
  private generation = 0
  private requestedIdentity = ""

  constructor(private readonly sink: {
    readonly install: (content: MainPaneContent) => void
    readonly setLoading: (loading: boolean) => void
    readonly reportError: (error: unknown) => void
  }) {}

  installSynchronous(content: MainPaneContent): void {
    this.generation += 1
    this.requestedIdentity = `${content.source}:${content.stableId}`
    this.sink.setLoading(false)
    this.sink.install(content)
  }

  async request<T>(
    source: MainPaneContent["source"],
    stableId: string,
    load: () => Promise<T>,
    present: (value: T) => MainPaneContent,
  ): Promise<void> {
    const identity = `${source}:${stableId}`
    const generation = ++this.generation
    this.requestedIdentity = identity
    this.sink.setLoading(true)
    try {
      const value = await load()
      if (generation !== this.generation || this.requestedIdentity !== identity) return
      this.sink.install(present(value))
    } catch (error) {
      if (generation === this.generation && this.requestedIdentity === identity) this.sink.reportError(error)
    } finally {
      if (generation === this.generation && this.requestedIdentity === identity) this.sink.setLoading(false)
    }
  }
}
```

RootView owns one gate. Route every Main source through it: Files selection, Local Branches, Remotes, RemoteBranches, Tags, Commits, CommitFiles, and Stash. Synchronous sources use `installSynchronous`; asynchronous sources use `request`. No pane assigns Main directly after the cutover.

Wire `onPreviewError` to `AppController.recordInspectionError(error)`. That method uses the existing error-to-banner conversion and refreshes `commandLog` from `runner.log.records()` without changing review state or successful Main content.

- [ ] **Step 6: Implement MainPaneContent lifecycle**

Replace `MainPaneOverride` with `MainPaneContent`. Render `preamble` as non-patch text followed by `renderDiff(document)`.

Before installing content, compare `${source}:${stableId}` and rendered text with the installed content:

- different identity: clear native/document selection and set `scrollX = scrollY = 0`;
- same identity, identical text: preserve selection and clamp both viewport axes;
- same identity, changed text: clear selection and clamp both viewport axes.

Loading changes only the title; it retains content, viewport, and selection until success.

- [ ] **Step 7: Implement CommitFiles child and clean controller cutover**

Build file rows from `details.document.files`, with stable ID `${newPath}\\0${oldPath}` and status/path/rename columns. Enter awaits details; only success calls `enterPanelChild`. Moving selection calls `loadCommitFileInspection(oid, path)` through the gate. Escape calls `leavePanelChild` and requests the parent commit preview.

Delete in the same cutover:

- `AppModel.commitDetails` and `AppModel.commitFilePath`;
- `AppController.selectCommit`, `selectCommitFile`, `navigateBack`, `commitOriginTarget`, and their mutation paths;
- obsolete RootView callbacks `onSelectCommit`, `onSelectCommitFile`, and `onCommitBack`;
- old drill-down/back guards based on `reviewTarget.kind === "commit"`.

Before deleting exported controller methods, use LSP references and migrate every caller in `create-app.ts`, RootView, and tests.

- [ ] **Step 8: Run focused tests**

Run: `bun test tests/app/commit-drilldown.test.ts tests/ui/dispatch.integration.test.ts tests/ui/preview-generation.test.ts tests/git/commits.test.ts`

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/domain/repository.ts src/app/controller.ts src/app/create-app.ts src/ui/main-preview.ts src/ui/panes/main-pane.ts src/ui/panes/commits-pane.ts src/ui/panes/commit-files-pane.ts src/ui/panes/files-pane.ts src/ui/panes/branches-pane.ts src/ui/panes/remotes-pane.ts src/ui/panes/tags-pane.ts src/ui/panes/stash-pane.ts src/ui/root-view.ts tests/app/commit-drilldown.test.ts tests/ui/dispatch.integration.test.ts tests/ui/preview-generation.test.ts tests/git/commits.test.ts
git commit -m "feat: add global read-only inspection flow"
```

### Task 6: Lazygit Stash Folding and Current-Side-Window Layout

**Files:**
- Modify: `src/ui/focus.ts`
- Modify: `src/ui/layout.ts`
- Modify: `src/ui/root-view.ts`
- Modify: `tests/ui/focus.test.ts`
- Modify: `tests/ui/layout.test.ts`

**Interfaces:**
- FocusManager produces `currentSideWindow: SideWindow`, initialized to `files` and updated only when a side window receives focus.
- `LayoutRequest` consumes `currentSideWindow`; compact sizing no longer infers the absorber only from current global focus.

- [ ] **Step 1: Replace focus-independent layout assertions with failing lazygit invariants**

```ts
test("folds an unfocused stash to three rows and expands focused stash", () => {
  const unfocused = computeLayout({ width: 120, height: 40 }, { focus: "commits", currentSideWindow: "commits" })
  expect(heightOf(unfocused.windows.stash)).toBe(3)
  const focused = computeLayout({ width: 120, height: 40 }, { focus: "stash", currentSideWindow: "stash" })
  expect(heightOf(focused.windows.stash)).toBeGreaterThan(3)
})

test("uses the last side window as compact absorber while Main is focused", () => {
  const layout = computeLayout({ width: 120, height: 24 }, { focus: "main", currentSideWindow: "branches" })
  expect(heightOf(layout.windows.branches)).toBeGreaterThan(3)
  expect(heightOf(layout.windows.commits)).toBe(3)
  expect(heightOf(layout.windows.stash)).toBe(3)
})

test("lower-right log height does not reduce the left side-section height", () => {
  const hidden = computeLayout({ width: 120, height: 40 }, { logVisible: false, currentSideWindow: "files" })
  const shown = computeLayout({ width: 120, height: 40 }, { logVisible: true, logHeight: 12, currentSideWindow: "files" })
  for (const pane of SIDE_WINDOWS) expect(heightOf(shown.windows[pane])).toBe(heightOf(hidden.windows[pane]))
})
```

Add exact 28/21 boundary cases using available side rows after the hints row.

- [ ] **Step 2: Run layout tests and verify failure**

Run: `bun test tests/ui/layout.test.ts tests/ui/focus.test.ts`

Expected: FAIL because normal layout currently weights Stash and compact layout hard-codes Files as absorber.

- [ ] **Step 3: Implement current-side tracking and side box rules**

Add `lastSide: SideWindow = "files"` to FocusManager. Update it before `onChange` whenever `focus(id)` receives a side ID. Pass it through `RootView.recomputeLayout`.

In normal layout, emit Status size 3, Stash size 3 unless current side is Stash, and weight 1 for Files/Branches/Commits plus focused Stash. In compact layout, emit weight 1 only for `currentSideWindow`; every other side window receives size 3 at available heights 21–27 and size 1 below 21.

- [ ] **Step 4: Run focused tests**

Run: `bun test tests/ui/layout.test.ts tests/ui/focus.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ui/focus.ts src/ui/layout.ts src/ui/root-view.ts tests/ui/focus.test.ts tests/ui/layout.test.ts
git commit -m "fix: match lazygit side panel folding"
```

---

### Task 7: Mouse Row Selection, Wheel Routing, and Interactive Scrollbars

**Files:**
- Modify: `src/ui/panes/common.ts`
- Modify: `src/ui/panes/main-pane.ts`
- Modify: `src/ui/panes/command-log-pane.ts`
- Modify: `src/ui/root-view.ts`
- Modify: `tests/ui/scroll-reveal.test.ts`
- Modify: `tests/ui/splitter.test.ts`
- Test: `tests/ui/mouse-parity.integration.test.ts`
- Test: `tests/ui/scrollbar.integration.test.ts`

**Interfaces:**
- Consumes Task 1 `listRowAtPoint`/`selectListRow`, Task 4 tab panes, and Task 5 CommitFiles selection.
- `PaneHandle` adds `scrollBy(delta: number): void`, `scrollTo(position: number): void`, and `maxScrollY(): number`.
- RootView exposes `paneTextGeometry(id)` for mouse tests and owns `gestureOwner: { kind: "vertical-splitter" } | { kind: "horizontal-splitter" } | { kind: "scrollbar"; paneId: FocusId } | { kind: "main-selection" } | undefined`.

- [ ] **Step 1: Write failing pointer-local wheel and commit click tests**

```ts
// tests/ui/mouse-parity.integration.test.ts
import { createMockMouse } from "@opentui/core/testing"

test("clicking a scrolled commit selects its stable row and updates Main", async () => {
  const mouse = createMockMouse(harness.renderer)
  await harness.pressKey("4")
  const box = view.paneTextGeometry("commits")!
  await mouse.scroll(box.screenX + 2, box.screenY + 1, "down")
  const before = view.commitsSelectedOid
  await mouse.click(box.screenX + 3, box.screenY + 1)
  await harness.settle()
  expect(view.commitsSelectedOid).not.toBe(before)
  expect(view.focusManager.active).toBe("commits")
  expect(harness.frame()).not.toContain("▸")
})

test("wheel scrolls only the pane under the pointer without changing focus or selection", async () => {
  await harness.pressKey("4")
  const focus = view.focusManager.active
  const selected = view.commitsSelectedOid
  const mainBefore = view.mainScrollY
  const commitsBefore = view.paneScrollY("commits")
  const commitBox = view.paneTextGeometry("commits")!
  await mouse.scroll(commitBox.screenX + 1, commitBox.screenY + 1, "down")
  expect(view.paneScrollY("commits")).toBe(commitsBefore + 2)
  expect(view.mainScrollY).toBe(mainBefore)
  expect(view.focusManager.active).toBe(focus)
  expect(view.commitsSelectedOid).toBe(selected)
})
```

Add cases for border/title coordinates, wheel over Main, wheel over Command Log, wheel over splitter no-op, click blank area, and click after compact-pane focus relayout.

- [ ] **Step 2: Write failing scrollbar and gesture-capture tests**

```ts
// tests/ui/scrollbar.integration.test.ts
const bar = paneScrollbar(view.commitsPane.text)!
expect(bar.visible).toBe(true)
const focusBefore = view.focusManager.active
await mouse.click(bar.x, bar.y + Math.floor(bar.height / 2))
expect(view.paneScrollY("commits")).toBeGreaterThan(0)
expect(view.focusManager.active).toBe(focusBefore)
await mouse.drag(bar.x, bar.y + 1, bar.x, bar.y + bar.height - 1)
expect(view.paneScrollY("commits")).toBe(view.commitsPane.text.maxScrollY)
expect(bar.scrollPosition).toBe(view.commitsPane.text.scrollY)
```

Drag each splitter several cells outside its one-cell rule and assert resizing continues until release. Start a scrollbar drag and cross the splitter; assert only the scrollbar viewport changes. Force a degenerate geometry where both splitter hit regions overlap and assert vertical wins. Hide/destroy the captured owner and assert `cancelGesture()` clears capture. Start Main native selection, drag across a scrollbar/splitter, and assert RootView does not resize/scroll while OpenTUI continues updating the native selection.

- [ ] **Step 3: Run focused tests and verify failures**

Run: `bun test tests/ui/mouse-parity.integration.test.ts tests/ui/scrollbar.integration.test.ts tests/ui/splitter.test.ts tests/ui/scroll-reveal.test.ts`

Expected: FAIL because current wheel handlers only stop propagation, row clicks only focus, and scrollbar slider handlers are disabled.

- [ ] **Step 4: Wire two-way pane scrolling and restore slider interaction**

Construct `ScrollBarRenderable` with:

```ts
onChange: (position) => {
  text.scrollY = Math.max(0, Math.min(text.maxScrollY, position))
  syncVerticalScrollbar(bar, text)
  box.requestRender()
}
```

Do not clear `bar.slider.onMouseDown/onMouseDrag/onMouseUp`. Wrap scrollbar press/drag to claim `gestureOwner` and stop propagation; do not focus its pane. Every PaneHandle scroll method updates `text.scrollY`, calls `syncVerticalScrollbar`, and requests render.

- [ ] **Step 5: Implement click/double-click, wheel routing, and root gesture capture**

At mouse down, test scrollbar geometry, vertical splitter, horizontal splitter, then pane content. For list content, capture `{ viewId, stableId, x, y, at }` before focusing. Resolve the ID after focus/layout and call Task 1 `selectListRow`.

Use `DOUBLE_CLICK_MS = 400`, same view/stable ID, and one-cell tolerance. Clear the pending pair on drag, wheel, target change, scrollbar/splitter press, or timeout. `cancelGesture()` clears active ownership when its renderable becomes hidden/destroyed, a modal takes input ownership, Escape cancels the current gesture, or RootView is destroyed.

For wheel:

```ts
const direction = event.scroll?.direction
const signed = direction === "up" ? -1 : direction === "down" ? 1 : 0
pane.scrollBy(signed * 2 * Math.max(1, event.scroll?.delta ?? 1))
event.preventDefault()
event.stopPropagation()
```

Wheel on a splitter consumes without scrolling. Root `onMouse` routes drag/up to the captured splitter or scrollbar until release, regardless of hit target. For `main-selection`, RootView suppresses list/splitter/scrollbar handlers but does not call `preventDefault`, allowing OpenTUI's native selection manager to receive drag/release. If splitter hit regions overlap, vertical splitter claims the press before horizontal.

- [ ] **Step 6: Run focused tests**

Run: `bun test tests/ui/mouse-parity.integration.test.ts tests/ui/scrollbar.integration.test.ts tests/ui/splitter.test.ts tests/ui/scroll-reveal.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/ui/panes/common.ts src/ui/panes/main-pane.ts src/ui/panes/command-log-pane.ts src/ui/root-view.ts tests/ui/mouse-parity.integration.test.ts tests/ui/scrollbar.integration.test.ts tests/ui/splitter.test.ts tests/ui/scroll-reveal.test.ts
git commit -m "fix: align mouse and scrollbar behavior"
```

---

### Task 8: Migrate Remaining Lists to Full-Row Selection

**Files:**
- Modify: `src/ui/panes/files-pane.ts`
- Modify: `src/ui/panes/branches-pane.ts`
- Modify: `src/ui/panes/remotes-pane.ts`
- Modify: `src/ui/panes/tags-pane.ts`
- Modify: `src/ui/panes/stash-pane.ts`
- Modify: `src/ui/root-view.ts`
- Modify: `tests/ui/branches-pane.test.ts`
- Modify: `tests/ui/dispatch.integration.test.ts`
- Test: `tests/ui/list-selection.integration.test.ts`

**Interfaces:**
- Consumes Task 1 shared list state and Task 7 shared mouse selection path.
- Removes pane-specific cursor WeakMaps and RootView numeric cursors once every caller uses a stable `ListState`.

- [ ] **Step 1: Write failing all-list selection tests**

```ts
// tests/ui/list-selection.integration.test.ts
for (const pane of ["files", "branches", "commits", "stash"] as const) {
  await harness.pressKey(String({ files: 2, branches: 3, commits: 4, stash: 5 }[pane]))
  await harness.pressKey("j")
  expect(view.selectedListId(pane)).toBeDefined()
  expect(view.renderedListText(pane)).not.toMatch(/^[>▸]/m)
  expect(view.selectedRowHasBackground(pane)).toBe(true)
  await harness.pressKey("0")
  expect(view.selectedRowHasBackground(pane)).toBe(false)
}
```

Add refresh tests that remove the selected item and assert previous numeric index retention/clamping for files, branches, tags, commit files, commits, and stashes.

- [ ] **Step 2: Run tests and verify failures**

Run: `bun test tests/ui/list-selection.integration.test.ts tests/ui/branches-pane.test.ts tests/ui/dispatch.integration.test.ts`

Expected: FAIL because several panes still render `>` markers or keep independent numeric cursor state.

- [ ] **Step 3: Migrate every pane to shared state**

Each pane exports typed row construction plus `update...Pane(pane, model, state, focused): ListState`. RootView stores one `ListState` per actual view/tab and uses it for keyboard, mouse, refresh restoration, page movement, and Main preview identity.

Delete:

- `WeakMap<PaneHandle, number>` cursor stores;
- `selectedOids` WeakMap;
- RootView `branchesCursorIndex` and equivalent numeric-only fields;
- `>`/`▸` marker formatting;
- duplicate clamp/preserve code superseded by `setListRows`.

Empty/loading/error text is passed as nonselectable display content, not inserted into `ListState.rows`.

- [ ] **Step 4: Run focused tests**

Run: `bun test tests/ui/list-selection.integration.test.ts tests/ui/branches-pane.test.ts tests/ui/dispatch.integration.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ui/panes/files-pane.ts src/ui/panes/branches-pane.ts src/ui/panes/remotes-pane.ts src/ui/panes/tags-pane.ts src/ui/panes/stash-pane.ts src/ui/root-view.ts tests/ui/list-selection.integration.test.ts tests/ui/branches-pane.test.ts tests/ui/dispatch.integration.test.ts
git commit -m "refactor: unify lazygit list selection"
```

---

### Task 9: Compatibility Matrix and End-to-End TUI Acceptance

**Files:**
- Modify: `docs/lazygit-compatibility-v0.1.md`
- Modify: `tests/helpers/shell-harness.ts`
- Create: `tests/acceptance/lazygit-core-ui.test.ts`

**Interfaces:**
- Produces one repository-backed acceptance scenario covering keyboard, mouse, tabs, transient children, graph rows, Main preview lifecycle, layout, scrollbars, splitters, and Main copy.
- Compatibility statuses are exactly `compatible`, `githunk review extension`, `not yet implemented`, or `blocked by an identified external limitation`.

- [ ] **Step 1: Build the failing acceptance repository fixture**

Extend `ShellHarness` options with a repository setup callback and expose `renderer` plus stable pane geometry access for `createMockMouse`.

Create the fixture explicitly:

```ts
await repository.git(["config", "user.name", "Noah Reviewer"])
await repository.git(["config", "user.email", "noah@example.invalid"])
await repository.write("base.txt", "base\n")
await repository.git(["add", "base.txt"])
await repository.git(["commit", "-m", "base commit"])
await repository.git(["switch", "-c", "side"])
await repository.write("side.txt", "side\n")
await repository.git(["add", "side.txt"])
await repository.git(["commit", "-m", "side commit"])
await repository.git(["switch", "master"])
await repository.write("main.txt", "main\n")
await repository.git(["add", "main.txt"])
await repository.git(["commit", "-m", "main commit"])
await repository.git(["merge", "--no-ff", "side", "-m", "merge side"])
await repository.git(["tag", "light"])
await repository.git(["tag", "-a", "v1", "-m", "release one"])
await repository.write("stash.txt", "stash\n")
await repository.git(["add", "stash.txt"])
await repository.git(["stash", "push", "-m", "review stash"])
await repository.write("rename-before.txt", "before\n")
await repository.git(["add", "rename-before.txt"])
await repository.git(["commit", "-m", "rename base"])
await repository.git(["mv", "rename-before.txt", "rename-after.txt"])
await repository.write("staged.txt", "staged\n")
await repository.git(["add", "rename-after.txt", "staged.txt"])
await repository.write("unstaged.txt", "unstaged\n")
await repository.git(["remote", "add", "fetch-seed", fetchBare.path])
await repository.git(["push", "fetch-seed", "master"])
await repository.git(["remote", "remove", "fetch-seed"])
await repository.git(["remote", "add", "origin", fetchBare.path])
await repository.git(["remote", "set-url", "--push", "origin", pushBare.path])
await repository.git(["push", "origin", "master"])
await repository.git(["fetch", "origin"])
```

The harness creates both bare repositories and cleans them with the working repository. Expose `renderer` and `paneTextGeometry(id)` for `createMockMouse`.

- [ ] **Step 2: Write the complete real-surface acceptance test**

The test must assert, in order:

1. Commits rows contain `Noah Reviewer`, a short hash, graph glyphs, and no arrow cursor.
2. Keyboard and mouse commit selection update Main metadata + `file changed` stat + patch.
3. Selecting a different commit clears Main selection and resets both viewport axes; returning to the same unchanged preview preserves its stable identity.
4. Enter/double-click opens CommitFiles in window 4 without changing `reviewTarget`; file keyboard/mouse selection changes Main; Escape restores the OID.
5. Panel 3 `[`/`]` wraps Branches/Remotes/Tags and preserves each selection.
6. Remotes Enter/Escape child behavior and Tags preview fields are correct.
7. Main and Files do not consume `[`/`]`.
8. Stash is three rows while not current and expands when focused.
9. Wheel affects only the pointed pane; track click/thumb drag keep scrollbar synchronized without focus change.
10. Splitter drag outside the rule continues; Main Unicode selection copies exact patch text and never includes a left pane.

- [ ] **Step 3: Run acceptance test and verify it fails before final fixes**

Run: `bun test tests/acceptance/lazygit-core-ui.test.ts`

Expected: FAIL if integration remains incomplete. For a source defect, return to its owning Task 1–8, add the narrow regression there, stage its exact files, commit that fix, then rerun this acceptance test. Do not weaken the acceptance assertion or stage unrelated paths in Task 9.

- [ ] **Step 4: Replace compatibility prose with the status matrix**

The matrix must include at least:

- numbered focus and pane navigation;
- full-row list selection;
- commit graph/author/time;
- commit metadata/stat/patch preview;
- CommitFiles transient drill-down;
- Branches/Remotes/Tags tabs;
- RemoteBranches transient drill-down;
- Stash folding;
- mouse row selection and double-click;
- pointer-local wheel scrolling;
- interactive scrollbar;
- Main selection/copy;
- lower-right review/log area;
- splitters;
- every subsequent parity-program subsystem as `not yet implemented`, never `intentionally changed`.

- [ ] **Step 5: Run the acceptance test and project verification**

Run: `bun test tests/acceptance/lazygit-core-ui.test.ts`

Expected: PASS.

Run: `bun run typecheck`

Expected: exit 0 with no TypeScript diagnostics.

Run: `bun test`

Expected: all tests PASS with zero failures.

- [ ] **Step 6: Run the actual TUI smoke scenario**

Launch through the PTY harness or the real command in the fixture repository:

```bash
bun run src/main.ts
```

Exercise `4`, click a commit, wheel, Enter, click a commit file, Escape, `3`, `[`, `]`, remote Enter/Escape, `5`, both splitter drags, scrollbar thumb drag, and Main Unicode selection/copy. Record observed pane titles, selected IDs, Main source ID, scroll positions, and copied text in the acceptance test output or test recorder artifact.

Expected: every interaction matches the ordered acceptance list; no input is swallowed and no gesture affects two owners.

- [ ] **Step 7: Commit**

```bash
git add docs/lazygit-compatibility-v0.1.md tests/helpers/shell-harness.ts tests/acceptance/lazygit-core-ui.test.ts
git commit -m "test: verify lazygit core UI parity"
```
