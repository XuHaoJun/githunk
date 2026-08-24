# githunk Review Shell UX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the githunk shell usable — discoverable keybindings, complete navigation, a proportional and resizable layout, and a Commits pane that is not empty.

**Architecture:** Two new pure-function seams. `src/ui/bindings.ts` becomes the single declarative source of keybinding truth, consumed by dispatch, the hints bar, and the `?` menu. `src/ui/boxlayout.ts` is a port of lazygit's `lazycore/pkg/boxlayout`, and `src/ui/layout.ts` is reduced to building a box tree. Separately, `AppController`'s loader-flag divergence is removed and the application wiring is extracted into `src/app/create-app.ts` so tests exercise the shipped path.

**Tech Stack:** TypeScript 5.9, Bun 1.4 (`bun test`, `bun run`), `@opentui/core` 0.5.6 (including `@opentui/core/testing`), real `git` CLI via `src/git/runner.ts`.

**Spec:** `docs/superpowers/specs/2026-08-24-githunk-review-shell-ux-design.md`
**Reference implementation:** `learn-projects/lazygit` (git submodule, read-only)

## Global Constraints

- Every task ends with `bun run check` passing (`tsc --noEmit && bun test`). Never commit with a red suite.
- TypeScript is `strict`. Prefer `readonly` fields and `readonly T[]` parameters, matching the existing code.
- No new runtime dependencies. `@opentui/core` 0.5.6 stays pinned.
- Layout defaults, copied verbatim from the spec: `sidePanelRatio` default `0.3333`; `EXPANDED_SIDE_PANEL_WEIGHT = 2`; `STATUS_PANE_HEIGHT = 3`; `FOLDED_PANE_HEIGHT = 3`; `MIN_HEIGHT_FOR_NORMAL_LAYOUT = 28`; `MIN_HEIGHT_FOR_TALL_SQUASHED = 21`. Existing minimums are unchanged: `MIN_LEFT_WIDTH = 18`, `MIN_MAIN_WIDTH = 40`, `MIN_MAIN_HEIGHT = 8`, `MIN_LOG_HEIGHT = 3`.
- Persisted UI state file: `.git/githunk/ui-state-v1.json`, mode `0600`. Fields: `sidePanelRatio`, `commandLogHeight`, `commandLogVisible`. Screen mode and focus are never persisted.
- The only existing binding whose meaning changes is `tab`: the main pane's scope toggle moves to `[` / `]`. Every other current binding keeps its meaning.
- Do not implement keyboard range-select (`v`), a user config file, `shrinkSidePanelsToContent`, or portrait mode. They are explicitly deferred in spec §14.
- Commit after every task with a `feat:` / `fix:` / `refactor:` / `test:` prefix.

---

## Implementation deltas — READ BEFORE RESUMING

Tasks 1-5 are complete and reviewed. Review found real defects in this plan's own
code; the fixes landed in the repository and this section records every place the
shipped code intentionally differs from the task text below. **Where they
conflict, the repository is correct and this plan's task text is stale.**

- **`normalizeKey` aliases `return` to `enter`** (`src/ui/keymap.ts`). OpenTUI reports a
  carriage return as `key.name === "return"`, so every `"enter"` binding and the nine
  pre-existing `key.name === "enter"` comparisons in v0.1 were dead — open file, inspect
  branch, inspect stash, commit drill-down and modal confirm all did nothing on a real
  Enter press. Verified empirically: CR is `return`, LF is `linefeed` (deliberately NOT
  aliased). Every other key name this plan guessed was correct: `pageup`, `pagedown`,
  `home`, `end`, `tab`, `escape`, `space`, `backspace`, `+`, `_`, `ctrl+d`, `ctrl+u`,
  and `shift+tab` (which arrives as name `tab` with shift set).
- **`resolve`/`dispatch` are availability-aware** and MUST be passed `model` and `ui`.
  An unavailable context binding falls through to the global binding for the same key;
  a modal never falls through. Without this the global `escape` -> `back` is unreachable
  from the main, files and commits panes.
- **`hintsFor`/`menuFor` derive from the same precedence rule as `resolve`**, via one
  shared `candidatesFor` helper. Computing precedence twice let the hints bar hide a key
  that dispatch would still route (the `f` key in the branches pane). An invariant test
  pins the agreement across 7 contexts x 4 review targets x 2 branch kinds x 2 stash
  selections, with a non-triviality floor derived from the declarations.
- **`handleModalKey`'s confirm tail routes through `resolveModalAction`**, which consults
  the registry with `model` and `ui`, instead of calling `action*` methods directly.
  Calling them directly bypassed every `available` predicate the extraction table traded
  inline guards for, and allowed deleting a local branch the user never selected from the
  remote-mismatch confirmation state.
- **`handleAction` ends with a `never` exhaustiveness default.** This plan claimed the
  switch was already exhaustive; it was not. `HANDLED_ACTIONS` and its
  `assertHandlersCover` call were removed as vacuous once the compile-time check existed
  (`BindingRegistry`'s constructor already rejects an unknown action).
  **Tasks 6-8 each add cases to this switch — the `never` default will now flag a miss.**
- **`UiState` carries `hasSelectedStash`**, and stash apply/pop/drop/inspect are gated by
  `stashOperation` (a stash is selected AND the review target is `working-tree` or
  `stash`), not by `writable`. Owner decision: match lazygit, which gates only on a
  selection; the old predicate was stricter than lazygit AND than githunk's own
  `AppController.ensureStashOperation`.
- **`{ name: "+" }` is declared as an object, not the string `"+"`**, because
  `parseKeyStroke` splits a key string on `"+"` as the modifier delimiter.
- **Shift+D is declared for force branch delete** (`{ keys: ["D"], action: "branch-delete" }`),
  reusing the action since `handleAction` already forwards `key.shift`. It was lost in the
  Task 5 migration. The `pendingBranchDelete` identity check requires the same force flag
  on both presses, so `d` then `D` does not complete a deletion.
- **The layout's width decision uses mutually exclusive `sideHidden`/`mainHidden`.** Testing
  `widthTooSmall` before `mainCollapsed` emptied the entire body on a terminal under 59
  columns with an enlarged focused side pane. Zero-extent windows are also filtered from
  the returned map, so "absent from `windows` means hidden" is literally true.
- **`tests/helpers/shell-harness.ts` exposes `settle()`**, which waits on
  `RootView.isMutating` rather than a fixed delay. `flush()` drains render passes, not the
  promise a mutation fires, so any test asserting a git-mutation outcome must `settle()`
  first. Task 10's acceptance tests must use it.

### Known gotcha for Task 7

OpenTUI **silently omits** a box `bottomTitle` that overflows the pane width — it does not
truncate it. Several refusal messages in `root-view.ts` are long enough to vanish on a
narrow pane. The hints bar is its own window rather than a box title, so it is not affected,
but Task 7 should not assume a `bottomTitle` assertion is observable at a normal terminal
width.

---

## File Structure

**Created**

| Path | Responsibility |
| --- | --- |
| `src/app/create-app.ts` | Wires a `GitRunner`, `AppController`, and `RootView` together. The single wiring path, used by both `main.ts` and tests. |
| `src/ui/boxlayout.ts` | Pure box-layout engine. Ported from lazygit. Knows nothing about githunk. |
| `src/ui/bindings.ts` | Declarative binding registry: declarations, dispatch resolution, hints formatting, menu grouping. |
| `src/ui/hints-bar.ts` | Renderables for the bottom row: hints segment plus right-aligned review status. |
| `src/ui/keybinding-menu.ts` | The `?` modal menu renderable. |
| `src/ui/splitter.ts` | Divider renderable: rule glyphs, hover state, grab affordance. |
| `src/storage/local-state-file.ts` | Atomic, symlink-refusing, `0600` file helper extracted from `src/review/store.ts`. Shared by both stores, hence not under `src/ui`. |
| `src/ui/ui-state-store.ts` | Loads and saves `.git/githunk/ui-state-v1.json` via `local-state-file.ts`. |
| `tests/helpers/shell-harness.ts` | Boots a real `RootView` over a real temp repository with a test renderer. |
| `tests/ui/boxlayout.test.ts` | Engine unit tests. |
| `tests/ui/bindings.test.ts` | Registry unit tests. |
| `tests/ui/hints-bar.test.ts` | Status text and menu rendering unit tests. |
| `tests/ui/splitter.test.ts` | Divider glyph unit tests. |
| `tests/ui/dispatch.integration.test.ts` | Real key and mouse input through a real view, grown by Tasks 5-9. |
| `tests/app/create-app.integration.test.ts` | Real temp repository through the real wiring. |
| `tests/storage/local-state-file.integration.test.ts` | Atomic write, permissions and quarantine against a real repository. |
| `tests/ui/ui-state-store.integration.test.ts` | Geometry round-trip and corrupt-file fallback. |
| `tests/ui/acceptance/shell.integration.test.ts` | The regression gate for every reported symptom. |

**Modified**

| Path | Change |
| --- | --- |
| `src/app/controller.ts:103-106,124,147,163,188-189,210,872` | Remove the three `automatic*` flags. |
| `src/main.ts` | Reduce to repository-root resolution, renderer creation, `createApp`, refresh. |
| `src/ui/layout.ts` | Rewritten to build a box tree. New request/geometry types. |
| `src/ui/root-view.ts` | Consume arranged dimensions and the binding registry instead of computing layout and comparing `key.name`. |
| `src/ui/focus.ts` | Add pane cycling (`nextPane` / `previousPane`) for `h` / `l` / `tab`. |
| `src/review/store.ts` | Use the extracted `local-state-file.ts`. |
| `tests/ui/layout.test.ts` | Rewritten against the new layout API. |

### Public members the tests read

`RootView.geometry` is already public (`src/ui/root-view.ts:89`), as is
`RootView.focusManager`. These tasks additionally make public:
`screenMode`, `sidePanelRatio`, `logHeight`, `mainScrollX`, `mainScrollY`,
`commitsCursorIndex`, and `applyPersistedGeometry`. Declare them public
deliberately rather than reaching into private state from tests.

---

## Task 1: Remove the loader-flag divergence and extract the app wiring

This is the fix for the empty Commits pane. `src/main.ts:23` constructs
`new AppController({ repositoryRoot, runner })`, which fails all three disjuncts
of `automaticCommitHistory` at `controller.ts:124`, so `loadCommitHistory`
returns `{ commits: [] }` unconditionally in the shipped app.

**Files:**
- Modify: `src/app/controller.ts:103-106`, `:124`, `:147`, `:163`, `:188-189`, `:210`, `:872`
- Create: `src/app/create-app.ts`
- Modify: `src/main.ts`
- Test: `tests/app/create-app.integration.test.ts`

**Interfaces:**
- Consumes: `AppController` from `src/app/controller.ts`, `RootView` from `src/ui/root-view.ts`, `GitRunner` from `src/git/runner.ts`.
- Produces:
  ```ts
  export type CreateAppOptions = {
    readonly repositoryRoot: string
    readonly runner: GitRunner
    readonly renderer?: CliRenderer
    readonly onQuit?: () => void
  }
  export type App = {
    readonly controller: AppController
    readonly view: RootView | undefined
    refresh(): Promise<void>
    destroy(): void
  }
  export function createApp(options: CreateAppOptions): App
  ```
  `renderer` is optional so the controller-level test can use `createApp` without
  a terminal; when it is omitted, `view` is `undefined` and `destroy()` is a
  no-op. Task 10 passes a real test renderer.

- [ ] **Step 1: Write the failing test**

Create `tests/app/create-app.integration.test.ts`:

```ts
import { afterEach, describe, expect, test } from "bun:test"
import { createTempRepository, type TempRepository } from "../helpers/temp-repository"
import { GitRunner } from "../../src/git/runner"
import { createApp } from "../../src/app/create-app"

describe("createApp real wiring", () => {
  let repository: TempRepository | undefined
  afterEach(async () => { await repository?.cleanup() })

  test("loads commit history, branches and stashes through the shipped wiring", async () => {
    repository = await createTempRepository()
    await repository.write("a.txt", "one\n")
    await repository.git(["add", "a.txt"])
    await repository.git(["commit", "-m", "first commit"])
    await repository.write("a.txt", "two\n")
    await repository.git(["commit", "-am", "second commit"])
    await repository.write("a.txt", "three\n")
    await repository.git(["commit", "-am", "third commit"])
    await repository.write("a.txt", "stashed\n")
    await repository.git(["stash", "push", "-m", "wip"])

    const app = createApp({ repositoryRoot: repository.path, runner: new GitRunner(repository.path) })
    await app.refresh()

    const subjects = (app.controller.state.commits ?? []).map((commit) => commit.subject)
    expect(subjects).toEqual(["third commit", "second commit", "first commit"])
    expect(app.controller.state.branches?.localBranches.length ?? 0).toBeGreaterThan(0)
    expect(app.controller.state.stashes?.length ?? 0).toBe(1)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test tests/app/create-app.integration.test.ts`
Expected: FAIL — `Cannot find module '../../src/app/create-app'`.

- [ ] **Step 3: Remove the three loader flags from the controller**

In `src/app/controller.ts`, delete these three field declarations (lines 103-106
currently, verify by reading before editing):

```ts
  private readonly automaticBranchListing: boolean
  private readonly automaticStashListing: boolean
  private readonly automaticCommitHistory: boolean
```

Delete the assignment at line 124 entirely:

```ts
    this.automaticCommitHistory = options instanceof GitRunner || options.loadCommits !== undefined || options.commitsLoader !== undefined
```

Delete the assignment at line 147:

```ts
    this.automaticBranchListing = options instanceof GitRunner || (options.loadBranches !== undefined || options.branchesLoader !== undefined) || (options.load === undefined && options.loader === undefined && runner !== undefined)
```

Delete the assignment at line 163:

```ts
    this.automaticStashListing = options instanceof GitRunner || options.loadStashes !== undefined || (load === undefined && runner !== undefined)
```

Replace the three read sites. At line 188-189:

```ts
    const stashWarning = this.automaticStashListing ? await this.refreshStashes() : undefined
    const branchWarning = this.automaticBranchListing ? await this.refreshBranches() : undefined
```

becomes:

```ts
    const stashWarning = await this.refreshStashes()
    const branchWarning = await this.refreshBranches()
```

At line 210, replace:

```ts
    if (!this.automaticStashListing) return undefined
```

with nothing — delete the line. `loadStashesListing` already falls back to
`async () => []` when there is no runner and no injected loader, so the guard is
redundant.

At line 872, replace:

```ts
    if (!this.automaticCommitHistory) return { commits: [] }
```

with nothing — delete the line. `loadCommitList` already falls back to
`async () => []` when there is no runner and no injected loader.

- [ ] **Step 4: Run the whole suite to find fallout**

Run: `bun test`

Two files pass both a `runner` and a `load`
(`tests/app/controller.test.ts`, `tests/app/commit-drilldown.test.ts`) and will
now invoke real `git log`. They use temp repositories, so their assertions are
expected to still pass. If any test fails because it now sees real commits where
it expected none, fix the **test** by injecting `loadCommits: async () => []`
explicitly — do not reintroduce the flag. Record which tests needed that in the
commit message.

- [ ] **Step 5: Create the wiring module**

Create `src/app/create-app.ts`. Move the entire callback object from
`src/main.ts` verbatim — every `on*` handler from `onStageFile` through
`onQuit` — into this file. The body below shows the structure and the first and
last handlers; **copy all the intervening handlers unchanged from
`src/main.ts:26-152`**, changing nothing but their indentation.

```ts
import type { CliRenderer } from "@opentui/core"
import { AppController } from "./controller"
import type { GitRunner } from "../git/runner"
import { RootView } from "../ui/root-view"

export type CreateAppOptions = {
  readonly repositoryRoot: string
  readonly runner: GitRunner
  readonly renderer?: CliRenderer
  readonly onQuit?: () => void
}

export type App = {
  readonly controller: AppController
  readonly view: RootView | undefined
  refresh(): Promise<void>
  destroy(): void
}

export function createApp(options: CreateAppOptions): App {
  const controller = new AppController({
    repositoryRoot: options.repositoryRoot,
    runner: options.runner,
  })
  const renderer = options.renderer
  if (renderer === undefined) {
    return {
      controller,
      view: undefined,
      refresh: () => controller.refresh(),
      destroy: () => undefined,
    }
  }

  let view: RootView
  view = new RootView(renderer, controller.state, {
    onStageFile: async (path) => {
      try { await controller.stageFile(path) } finally { view.update(controller.state) }
    },
    // ... every remaining handler from src/main.ts, copied unchanged ...
    onFilterBranches: async () => undefined,
    onQuit: () => options.onQuit?.(),
  })

  return {
    controller,
    view,
    refresh: async () => {
      await controller.refresh()
      view.update(controller.state)
    },
    destroy: () => view.destroy(),
  }
}
```

- [ ] **Step 6: Reduce `src/main.ts` to a shell**

Replace the whole body of `src/main.ts` with:

```ts
import { createCliRenderer } from "@opentui/core"
import { createApp } from "./app/create-app"
import { GitCommandError, GitRunner } from "./git/runner"

export async function startApp(): Promise<number> {
  const runner = new GitRunner()
  let repositoryRoot: string

  try {
    repositoryRoot = (await runner.run(["rev-parse", "--show-toplevel"])).stdout.trim()
  } catch (error) {
    const detail = error instanceof GitCommandError ? error.record.stderr.trim() : String(error)
    process.stderr.write(`githunk: not inside a Git repository. Start it from a repository or pass a repository path.\n${detail}\n`)
    return 1
  }

  const renderer = await createCliRenderer({
    exitOnCtrlC: true,
    useMouse: true,
    enableMouseMovement: true,
    targetFps: 30,
  })

  const app = createApp({
    repositoryRoot,
    runner,
    renderer,
    onQuit: () => renderer.destroy(),
  })
  renderer.once("destroy", () => app.destroy())

  try {
    await app.refresh()
  } catch (error) {
    app.destroy()
    renderer.destroy()
    throw error
  }

  return 0
}

if (import.meta.main) {
  process.exitCode = await startApp()
}
```

- [ ] **Step 7: Run the target test and the full check**

Run: `bun test tests/app/create-app.integration.test.ts`
Expected: PASS — three commit subjects in newest-first order, one stash.

Run: `bun run check`
Expected: typecheck clean, all tests pass.

- [ ] **Step 8: Verify the fix by hand in this repository**

Run: `bun run start`
Expected: press `4`; the Commits pane lists this repository's commits (58 or
more) rather than "No commits". Press `q` to exit.

- [ ] **Step 9: Commit**

```bash
git add src/app/controller.ts src/app/create-app.ts src/main.ts tests/app/create-app.integration.test.ts
git commit -m "fix: populate commits pane in the shipped app wiring

AppController gated commit, branch and stash loading behind flags that
main.ts's options shape did not satisfy, so the Commits pane was always
empty outside tests. Remove the flags and route both main.ts and the new
integration test through one createApp wiring."
```

---

## Task 2: Port lazygit's box-layout engine

**Files:**
- Create: `src/ui/boxlayout.ts`
- Test: `tests/ui/boxlayout.test.ts`
- Read for reference: `learn-projects/lazygit/vendor/github.com/jesseduffield/lazycore/pkg/boxlayout/boxlayout.go`

**Interfaces:**
- Consumes: nothing.
- Produces:
  ```ts
  export type Direction = "row" | "column"
  export type Dimensions = { readonly x0: number; readonly y0: number; readonly x1: number; readonly y1: number }
  export type Box = {
    readonly window?: string
    readonly direction?: Direction
    readonly conditionalDirection?: (width: number, height: number) => Direction
    readonly weight?: number
    readonly size?: number
    readonly children?: readonly Box[]
    readonly conditionalChildren?: (width: number, height: number) => readonly Box[]
  }
  export function normalizeWeights(weights: readonly number[]): readonly number[]
  export function calcSizes(boxes: readonly Box[], availableSpace: number): readonly number[]
  export function arrangeWindows(root: Box, x0: number, y0: number, width: number, height: number): Readonly<Record<string, Dimensions>>
  ```
  `Dimensions` is inclusive on both ends, matching lazygit: a box at `x0: 0`
  with width 10 has `x1: 9`.

- [ ] **Step 1: Write the failing tests**

Create `tests/ui/boxlayout.test.ts`:

```ts
import { describe, expect, test } from "bun:test"
import { arrangeWindows, calcSizes, normalizeWeights } from "../../src/ui/boxlayout"

describe("normalizeWeights", () => {
  test("divides weights by their lowest common factor", () => {
    expect(normalizeWeights([2, 4, 4])).toEqual([1, 2, 2])
    expect(normalizeWeights([3, 6, 9])).toEqual([1, 2, 3])
  })

  test("returns weights unchanged when any weight is already 1", () => {
    expect(normalizeWeights([1, 2, 2])).toEqual([1, 2, 2])
  })

  test("returns weights unchanged when there is no common factor", () => {
    expect(normalizeWeights([2, 3])).toEqual([2, 3])
  })

  test("ignores zero weights when finding the common factor", () => {
    expect(normalizeWeights([0, 4, 4])).toEqual([0, 1, 1])
  })

  test("handles the empty list", () => {
    expect(normalizeWeights([])).toEqual([])
  })
})

describe("calcSizes", () => {
  test("serves static sizes first, then splits the rest by weight", () => {
    expect(calcSizes([{ size: 3 }, { weight: 1 }, { weight: 1 }], 13)).toEqual([3, 5, 5])
  })

  test("distributes the remainder one cell at a time across weighted boxes", () => {
    expect(calcSizes([{ weight: 1 }, { weight: 1 }, { weight: 1 }], 10)).toEqual([4, 3, 3])
  })

  test("splits proportionally when weights differ", () => {
    expect(calcSizes([{ weight: 1 }, { weight: 2 }], 12)).toEqual([4, 8])
  })

  test("crops a static box larger than the available space", () => {
    expect(calcSizes([{ size: 40 }], 10)).toEqual([10])
  })

  test("gives weighted boxes nothing when static boxes consume everything", () => {
    expect(calcSizes([{ size: 10 }, { weight: 1 }], 10)).toEqual([10, 0])
  })
})

describe("arrangeWindows", () => {
  test("maps a leaf window to the full region, inclusive of both ends", () => {
    expect(arrangeWindows({ window: "main" }, 0, 0, 10, 4)).toEqual({
      main: { x0: 0, y0: 0, x1: 9, y1: 3 },
    })
  })

  test("returns nothing for a leaf with no window name", () => {
    expect(arrangeWindows({}, 0, 0, 10, 4)).toEqual({})
  })

  test("stacks row children vertically", () => {
    expect(arrangeWindows({
      direction: "row",
      children: [{ window: "top", size: 1 }, { window: "bottom", weight: 1 }],
    }, 0, 0, 8, 4)).toEqual({
      top: { x0: 0, y0: 0, x1: 7, y1: 0 },
      bottom: { x0: 0, y0: 1, x1: 7, y1: 3 },
    })
  })

  test("places column children side by side", () => {
    expect(arrangeWindows({
      direction: "column",
      children: [{ window: "left", size: 3 }, { window: "right", weight: 1 }],
    }, 0, 0, 8, 2)).toEqual({
      left: { x0: 0, y0: 0, x1: 2, y1: 1 },
      right: { x0: 3, y0: 0, x1: 7, y1: 1 },
    })
  })

  test("arranges nested boxes and merges their windows", () => {
    const result = arrangeWindows({
      direction: "column",
      children: [
        { window: "side", size: 2 },
        {
          direction: "row",
          weight: 1,
          children: [{ window: "main", weight: 1 }, { window: "log", size: 1 }],
        },
      ],
    }, 0, 0, 6, 3)
    expect(result).toEqual({
      side: { x0: 0, y0: 0, x1: 1, y1: 2 },
      main: { x0: 2, y0: 0, x1: 5, y1: 1 },
      log: { x0: 2, y0: 2, x1: 5, y1: 2 },
    })
  })

  test("resolves conditionalChildren with the region it was given", () => {
    const result = arrangeWindows({
      direction: "row",
      conditionalChildren: (_width, height) =>
        height >= 4 ? [{ window: "tall", weight: 1 }] : [{ window: "short", weight: 1 }],
    }, 0, 0, 5, 2)
    expect(Object.keys(result)).toEqual(["short"])
  })

  test("resolves conditionalDirection with the region it was given", () => {
    const box = {
      conditionalDirection: (width: number) => (width >= 10 ? "column" as const : "row" as const),
      children: [{ window: "a", weight: 1 }, { window: "b", weight: 1 }],
    }
    expect(arrangeWindows(box, 0, 0, 4, 4).a).toEqual({ x0: 0, y0: 0, x1: 3, y1: 1 })
    expect(arrangeWindows(box, 0, 0, 10, 4).a).toEqual({ x0: 0, y0: 0, x1: 4, y1: 3 })
  })

  test("gives a zero-sized child an empty region without going negative", () => {
    const result = arrangeWindows({
      direction: "column",
      children: [{ window: "hidden", size: 0, weight: 0 }, { window: "shown", weight: 1 }],
    }, 0, 0, 6, 1)
    expect(result.hidden).toEqual({ x0: 0, y0: 0, x1: -1, y1: 0 })
    expect(result.shown).toEqual({ x0: 0, y0: 0, x1: 5, y1: 0 })
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test tests/ui/boxlayout.test.ts`
Expected: FAIL — `Cannot find module '../../src/ui/boxlayout'`.

- [ ] **Step 3: Implement the engine**

Create `src/ui/boxlayout.ts`:

```ts
export type Direction = "row" | "column"

export type Dimensions = {
  readonly x0: number
  readonly y0: number
  readonly x1: number
  readonly y1: number
}

export type Box = {
  readonly window?: string
  readonly direction?: Direction
  readonly conditionalDirection?: (width: number, height: number) => Direction
  /** Dynamic share of whatever the statically sized siblings leave behind. Mutually exclusive with size. */
  readonly weight?: number
  /** Static extent along the parent's direction. Mutually exclusive with weight. */
  readonly size?: number
  readonly children?: readonly Box[]
  readonly conditionalChildren?: (width: number, height: number) => readonly Box[]
}

function isStatic(box: Box): boolean {
  return (box.size ?? 0) > 0
}

function factorsOf(value: number): number[] {
  const factors: number[] = []
  for (let candidate = 2; candidate <= value; candidate += 1) {
    if (value % candidate === 0) factors.push(candidate)
  }
  return factors
}

/**
 * Divides weights by their lowest common factor, so 2,4,4 becomes 1,2,2. The
 * remainder loop in calcSizes walks the normalized weights, so skipping this
 * step yields different cell allocations than lazygit's.
 */
export function normalizeWeights(weights: readonly number[]): readonly number[] {
  if (weights.length === 0) return []
  if (weights.some((weight) => weight === 1)) return weights

  const positive = weights.filter((weight) => weight > 0)
  if (positive.length === 0) return weights

  let common = factorsOf(positive[0]!)
  for (const weight of positive) {
    const factors = new Set(factorsOf(weight))
    common = common.filter((factor) => factors.has(factor))
  }
  if (common.length === 0) return weights

  return normalizeWeights(weights.map((weight) => Math.floor(weight / common[0]!)))
}

export function calcSizes(boxes: readonly Box[], availableSpace: number): readonly number[] {
  const weights = [...normalizeWeights(boxes.map((box) => box.weight ?? 0))]

  let totalWeight = 0
  let reservedSpace = 0
  for (const [index, box] of boxes.entries()) {
    if (isStatic(box)) reservedSpace += box.size ?? 0
    else totalWeight += weights[index] ?? 0
  }

  const dynamicSpace = Math.max(0, availableSpace - reservedSpace)
  const unitSize = totalWeight > 0 ? Math.floor(dynamicSpace / totalWeight) : 0
  let extraSpace = totalWeight > 0 ? dynamicSpace % totalWeight : 0

  const result = boxes.map((box, index) =>
    isStatic(box)
      ? Math.min(availableSpace, box.size ?? 0)
      : unitSize * (weights[index] ?? 0),
  )

  // Deal the remainder out one cell at a time, decrementing the weight each
  // time a box is served, so wider boxes take proportionally more of it.
  while (extraSpace > 0) {
    let served = false
    for (const [index, weight] of weights.entries()) {
      if (weight <= 0) continue
      result[index] = (result[index] ?? 0) + 1
      weights[index] = weight - 1
      extraSpace -= 1
      served = true
      if (extraSpace === 0) break
    }
    if (!served) break
  }

  return result
}

export function arrangeWindows(
  root: Box,
  x0: number,
  y0: number,
  width: number,
  height: number,
): Readonly<Record<string, Dimensions>> {
  const children = root.conditionalChildren?.(width, height) ?? root.children ?? []
  if (children.length === 0) {
    if (root.window === undefined || root.window === "") return {}
    return { [root.window]: { x0, y0, x1: x0 + width - 1, y1: y0 + height - 1 } }
  }

  const direction = root.conditionalDirection?.(width, height) ?? root.direction ?? "row"
  const sizes = calcSizes(children, direction === "column" ? width : height)

  const result: Record<string, Dimensions> = {}
  let offset = 0
  for (const [index, child] of children.entries()) {
    const boxSize = sizes[index] ?? 0
    const arranged = direction === "column"
      ? arrangeWindows(child, x0 + offset, y0, boxSize, height)
      : arrangeWindows(child, x0, y0 + offset, width, boxSize)
    Object.assign(result, arranged)
    offset += boxSize
  }
  return result
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test tests/ui/boxlayout.test.ts`
Expected: PASS — all cases in all three describe blocks.

- [ ] **Step 5: Run the full check**

Run: `bun run check`
Expected: typecheck clean, all tests pass. Nothing consumes the new module yet.

- [ ] **Step 6: Commit**

```bash
git add src/ui/boxlayout.ts tests/ui/boxlayout.test.ts
git commit -m "feat: add box-layout engine ported from lazygit

Pure port of lazycore/pkg/boxlayout, including normalizeWeights and the
one-cell-at-a-time remainder distribution. No githunk concepts and no
minimum-size logic: those belong to the caller that builds the tree."
```

---

## Task 3: Rewrite the layout module onto a box tree

**Files:**
- Modify: `src/ui/layout.ts` (full rewrite)
- Test: `tests/ui/layout.test.ts` (full rewrite)
- Read for reference: `learn-projects/lazygit/pkg/gui/controllers/helpers/window_arrangement_helper.go`

Nothing consumes the new signature yet — `root-view.ts` is migrated in Task 6.
To keep the suite green in between, this task leaves the two old helpers
`resizeLeftPane` and `resizeCommandLog` exported as thin deprecated wrappers,
which Task 6 deletes.

**Interfaces:**
- Consumes: `arrangeWindows`, `Box`, `Dimensions` from `src/ui/boxlayout.ts`; `FocusId` from `src/ui/focus.ts`.
- Produces:
  ```ts
  export type ScreenMode = "normal" | "half" | "full"
  export const SCREEN_MODES: readonly ScreenMode[]
  export type SideWindow = "status" | "files" | "branches" | "commits" | "stash"
  export const SIDE_WINDOWS: readonly SideWindow[]
  export type WindowName = SideWindow | "vsplit" | "main" | "hsplit" | "log" | "hints" | "info"

  export type TerminalSize = { readonly width: number; readonly height: number }
  export type LayoutRequest = {
    readonly sidePanelRatio?: number   // default DEFAULT_SIDE_PANEL_RATIO
    readonly logHeight?: number        // default 8
    readonly logVisible?: boolean      // default false
    readonly focus?: FocusId           // default "main"
    readonly screenMode?: ScreenMode   // default "normal"
    readonly hintsVisible?: boolean    // default true
    readonly statusWidth?: number      // default 0
    readonly accordion?: boolean       // default true
  }
  export type LayoutGeometry = {
    readonly terminalWidth: number
    readonly terminalHeight: number
    readonly windows: Readonly<Partial<Record<WindowName, Dimensions>>>
    readonly sidePanelRatio: number
    readonly sideWidth: number
    readonly logHeight: number
    readonly logVisible: boolean
    readonly screenMode: ScreenMode
    readonly hintsVisible: boolean
    readonly tooSmall: boolean
  }

  export function computeLayout(terminal: TerminalSize, requested?: LayoutRequest): LayoutGeometry
  export function widthOf(dimensions: Dimensions | undefined): number
  export function heightOf(dimensions: Dimensions | undefined): number
  export function ratioForMouseX(geometry: LayoutGeometry, mouseX: number): number
  export function logHeightForMouseY(geometry: LayoutGeometry, mouseY: number): number
  export function nextScreenMode(current: ScreenMode): ScreenMode
  export function previousScreenMode(current: ScreenMode): ScreenMode
  ```
  **A window absent from `geometry.windows` means that region is hidden.** This
  is the contract Task 6 relies on: `root-view.ts` sets
  `renderable.visible = windows[name] !== undefined`.

- [ ] **Step 1: Write the failing tests**

Replace the whole contents of `tests/ui/layout.test.ts`:

```ts
import { describe, expect, test } from "bun:test"
import {
  computeLayout,
  heightOf,
  logHeightForMouseY,
  nextScreenMode,
  previousScreenMode,
  ratioForMouseX,
  widthOf,
  DEFAULT_SIDE_PANEL_RATIO,
  MIN_LEFT_WIDTH,
  MIN_MAIN_WIDTH,
  SIDE_WINDOWS,
  STATUS_PANE_HEIGHT,
  FOLDED_PANE_HEIGHT,
} from "../../src/ui/layout"

describe("computeLayout side region", () => {
  test("sizes the side region by ratio rather than a fixed column count", () => {
    const layout = computeLayout({ width: 200, height: 40 })
    expect(layout.sidePanelRatio).toBe(DEFAULT_SIDE_PANEL_RATIO)
    expect(layout.sideWidth).toBe(Math.round(200 * DEFAULT_SIDE_PANEL_RATIO))
    // Each side pane spans the full side width, so any of them measures it.
    expect(widthOf(layout.windows.files)).toBe(layout.sideWidth)
  })

  test("honours an explicit ratio", () => {
    expect(computeLayout({ width: 120, height: 40 }, { sidePanelRatio: 0.5 }).sideWidth).toBe(60)
  })

  test("clamps the ratio to the side and main minimums", () => {
    const tiny = computeLayout({ width: 120, height: 40 }, { sidePanelRatio: 0.01 })
    expect(tiny.sideWidth).toBe(MIN_LEFT_WIDTH)
    const huge = computeLayout({ width: 120, height: 40 }, { sidePanelRatio: 0.99 })
    expect(widthOf(huge.windows.main)).toBe(MIN_MAIN_WIDTH)
  })

  test("partitions the width exactly across side, splitter and main", () => {
    const layout = computeLayout({ width: 137, height: 41 }, { logVisible: true })
    expect(layout.sideWidth + widthOf(layout.windows.vsplit) + widthOf(layout.windows.main)).toBe(137)
  })
})

describe("computeLayout left stack", () => {
  test("pins the status pane and folds an unfocused stash", () => {
    const layout = computeLayout({ width: 120, height: 40 }, { focus: "files" })
    expect(heightOf(layout.windows.status)).toBe(STATUS_PANE_HEIGHT)
    expect(heightOf(layout.windows.stash)).toBe(FOLDED_PANE_HEIGHT)
  })

  test("expands the focused pane and never the status pane", () => {
    const focused = computeLayout({ width: 120, height: 40 }, { focus: "commits" })
    expect(heightOf(focused.windows.commits)).toBeGreaterThan(heightOf(focused.windows.files))
    expect(heightOf(focused.windows.status)).toBe(STATUS_PANE_HEIGHT)
  })

  test("expands the stash pane when it is focused", () => {
    const layout = computeLayout({ width: 120, height: 40 }, { focus: "stash" })
    expect(heightOf(layout.windows.stash)).toBeGreaterThan(FOLDED_PANE_HEIGHT)
  })

  test("gives every pane an equal share when the accordion is disabled", () => {
    const layout = computeLayout({ width: 120, height: 40 }, { focus: "commits", accordion: false })
    expect(heightOf(layout.windows.commits)).toBe(heightOf(layout.windows.files))
  })

  test("partitions the side height exactly across the five panes", () => {
    for (const height of [40, 33, 26, 19, 12]) {
      const layout = computeLayout({ width: 120, height }, { focus: "files", hintsVisible: true })
      const total = SIDE_WINDOWS.reduce((sum, name) => sum + heightOf(layout.windows[name]), 0)
      expect(total).toBe(height - 1)
    }
  })

  test("squashes unfocused panes on a short terminal and keeps the focused one usable", () => {
    const short = computeLayout({ width: 120, height: 24 }, { focus: "files" })
    expect(heightOf(short.windows.branches)).toBe(FOLDED_PANE_HEIGHT)
    expect(heightOf(short.windows.files)).toBeGreaterThan(FOLDED_PANE_HEIGHT)

    const shorter = computeLayout({ width: 120, height: 18 }, { focus: "files" })
    expect(heightOf(shorter.windows.branches)).toBe(1)
    expect(heightOf(shorter.windows.files)).toBeGreaterThan(1)
  })

  test("keeps a weighted absorber when focus is on the main pane", () => {
    for (const height of [24, 18]) {
      const layout = computeLayout({ width: 120, height }, { focus: "main" })
      const total = SIDE_WINDOWS.reduce((sum, name) => sum + heightOf(layout.windows[name]), 0)
      expect(total).toBe(height - 1)
    }
  })
})

describe("computeLayout command log", () => {
  test("omits the log and its splitter when hidden", () => {
    const layout = computeLayout({ width: 120, height: 40 }, { logVisible: false })
    expect(layout.windows.log).toBeUndefined()
    expect(layout.windows.hsplit).toBeUndefined()
    expect(layout.logHeight).toBe(0)
  })

  test("partitions the main column exactly when the log is shown", () => {
    const layout = computeLayout({ width: 120, height: 40 }, { logVisible: true, logHeight: 8 })
    expect(layout.logHeight).toBe(8)
    expect(heightOf(layout.windows.main) + heightOf(layout.windows.hsplit) + layout.logHeight).toBe(39)
  })

  test("clamps an oversized log request", () => {
    const layout = computeLayout({ width: 120, height: 20 }, { logVisible: true, logHeight: 999 })
    expect(heightOf(layout.windows.main)).toBeGreaterThanOrEqual(8)
  })
})

describe("computeLayout hints row", () => {
  test("reserves one row and right-aligns the status segment", () => {
    const layout = computeLayout({ width: 100, height: 40 }, { hintsVisible: true, statusWidth: 12 })
    expect(heightOf(layout.windows.hints)).toBe(1)
    expect(widthOf(layout.windows.info)).toBe(12)
    expect(layout.windows.info?.x1).toBe(99)
    expect(widthOf(layout.windows.hints)).toBe(88)
  })

  test("reclaims the row when hints are hidden", () => {
    const layout = computeLayout({ width: 100, height: 40 }, { hintsVisible: false, logVisible: false })
    expect(layout.windows.hints).toBeUndefined()
    expect(heightOf(layout.windows.main)).toBe(40)
  })
})

describe("computeLayout screen modes", () => {
  test("collapses the side region in half and full mode when main has focus", () => {
    for (const screenMode of ["half", "full"] as const) {
      const layout = computeLayout({ width: 120, height: 40 }, { focus: "main", screenMode })
      expect(layout.sideWidth).toBe(0)
      expect(layout.windows.files).toBeUndefined()
      expect(layout.windows.vsplit).toBeUndefined()
      expect(widthOf(layout.windows.main)).toBe(120)
    }
  })

  test("half mode with side focus splits the width and shows only the focused pane", () => {
    const layout = computeLayout({ width: 120, height: 40 }, { focus: "commits", screenMode: "half" })
    expect(layout.sideWidth).toBe(60)
    expect(heightOf(layout.windows.commits)).toBeGreaterThan(0)
    expect(heightOf(layout.windows.files)).toBe(0)
  })

  test("full mode with side focus collapses main", () => {
    const layout = computeLayout({ width: 120, height: 40 }, { focus: "commits", screenMode: "full" })
    expect(layout.windows.main).toBeUndefined()
    expect(layout.windows.vsplit).toBeUndefined()
    expect(widthOf(layout.windows.commits)).toBe(120)
  })

  test("cycles forward and backward without wrapping past the ends", () => {
    expect(nextScreenMode("normal")).toBe("half")
    expect(nextScreenMode("half")).toBe("full")
    expect(nextScreenMode("full")).toBe("full")
    expect(previousScreenMode("full")).toBe("half")
    expect(previousScreenMode("half")).toBe("normal")
    expect(previousScreenMode("normal")).toBe("normal")
  })
})

describe("computeLayout robustness", () => {
  test("reports terminals that cannot host the normal layout", () => {
    expect(computeLayout({ width: 58, height: 40 }, { logVisible: false }).tooSmall).toBe(true)
    expect(computeLayout({ width: 120, height: 11 }, { logVisible: true }).tooSmall).toBe(true)
    expect(computeLayout({ width: 120, height: 40 }, { logVisible: true }).tooSmall).toBe(false)
  })

  test("never produces a negative or empty main region at tiny sizes", () => {
    for (const width of [1, 2, 10, 20, 59]) {
      for (const height of [1, 2, 5, 10, 12]) {
        const layout = computeLayout({ width, height }, { logVisible: true, logHeight: 8 })
        expect(widthOf(layout.windows.main)).toBeGreaterThanOrEqual(1)
        expect(heightOf(layout.windows.main)).toBeGreaterThanOrEqual(1)
        for (const dimensions of Object.values(layout.windows)) {
          expect(dimensions.x0).toBeGreaterThanOrEqual(0)
          expect(dimensions.y0).toBeGreaterThanOrEqual(0)
        }
      }
    }
  })

  test("tolerates non-finite terminal sizes", () => {
    const layout = computeLayout({ width: Number.NaN, height: Number.POSITIVE_INFINITY })
    expect(layout.terminalWidth).toBeGreaterThanOrEqual(1)
    expect(layout.terminalHeight).toBeGreaterThanOrEqual(1)
  })
})

describe("mouse mapping", () => {
  test("maps a drag x coordinate to a ratio of the terminal width", () => {
    const layout = computeLayout({ width: 200, height: 40 })
    expect(ratioForMouseX(layout, 50)).toBeCloseTo(0.25, 5)
    expect(ratioForMouseX(layout, -10)).toBe(0)
    expect(ratioForMouseX(layout, 999)).toBe(1)
  })

  test("maps a drag y coordinate to a command log height", () => {
    const layout = computeLayout({ width: 120, height: 41 }, { logVisible: true, logHeight: 8 })
    expect(logHeightForMouseY(layout, 30)).toBe(9)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test tests/ui/layout.test.ts`
Expected: FAIL — `computeLayout` does not accept the new request fields and the
named exports (`widthOf`, `SIDE_WINDOWS`, `nextScreenMode`, ...) do not exist.

- [ ] **Step 3: Implement the layout module**

Replace the whole contents of `src/ui/layout.ts`:

```ts
import { arrangeWindows, type Box, type Dimensions } from "./boxlayout"
import type { FocusId } from "./focus"

export const MIN_LEFT_WIDTH = 18
export const MIN_MAIN_WIDTH = 40
export const MIN_MAIN_HEIGHT = 8
export const MIN_LOG_HEIGHT = 3
export const SPLITTER_SIZE = 1
export const DEFAULT_SIDE_PANEL_RATIO = 0.3333
export const DEFAULT_LOG_HEIGHT = 8
/** Focused side pane height relative to its siblings. lazygit's expandedSidePanelWeight. */
export const EXPANDED_SIDE_PANEL_WEIGHT = 2
export const STATUS_PANE_HEIGHT = 3
export const FOLDED_PANE_HEIGHT = 3
export const MIN_HEIGHT_FOR_NORMAL_LAYOUT = 28
export const MIN_HEIGHT_FOR_TALL_SQUASHED = 21

export type ScreenMode = "normal" | "half" | "full"
export const SCREEN_MODES: readonly ScreenMode[] = ["normal", "half", "full"]

export type SideWindow = "status" | "files" | "branches" | "commits" | "stash"
export const SIDE_WINDOWS: readonly SideWindow[] = ["status", "files", "branches", "commits", "stash"]

export type WindowName = SideWindow | "vsplit" | "main" | "hsplit" | "log" | "hints" | "info"

export type TerminalSize = {
  readonly width: number
  readonly height: number
}

export type LayoutRequest = {
  readonly sidePanelRatio?: number
  readonly logHeight?: number
  readonly logVisible?: boolean
  readonly focus?: FocusId
  readonly screenMode?: ScreenMode
  readonly hintsVisible?: boolean
  readonly statusWidth?: number
  readonly accordion?: boolean
}

export type LayoutGeometry = {
  readonly terminalWidth: number
  readonly terminalHeight: number
  /** A window absent from this map is hidden. */
  readonly windows: Readonly<Partial<Record<WindowName, Dimensions>>>
  readonly sidePanelRatio: number
  readonly sideWidth: number
  readonly logHeight: number
  readonly logVisible: boolean
  readonly screenMode: ScreenMode
  readonly hintsVisible: boolean
  readonly tooSmall: boolean
}

export function widthOf(dimensions: Dimensions | undefined): number {
  return dimensions === undefined ? 0 : Math.max(0, dimensions.x1 - dimensions.x0 + 1)
}

export function heightOf(dimensions: Dimensions | undefined): number {
  return dimensions === undefined ? 0 : Math.max(0, dimensions.y1 - dimensions.y0 + 1)
}

function safeDimension(value: number): number {
  return Number.isFinite(value) ? Math.max(1, Math.floor(value)) : 1
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

function isSideWindow(focus: FocusId): focus is FocusId & SideWindow {
  return (SIDE_WINDOWS as readonly string[]).includes(focus)
}

export function nextScreenMode(current: ScreenMode): ScreenMode {
  const index = SCREEN_MODES.indexOf(current)
  return SCREEN_MODES[Math.min(SCREEN_MODES.length - 1, index + 1)] ?? current
}

export function previousScreenMode(current: ScreenMode): ScreenMode {
  const index = SCREEN_MODES.indexOf(current)
  return SCREEN_MODES[Math.max(0, index - 1)] ?? current
}

/**
 * The five left panes. `focusedSide` is undefined when focus is on the main
 * pane or the command log; `absorber` is the pane that takes a weight in the
 * layouts where every other pane is statically sized, because boxlayout needs
 * at least one weighted box to soak up the remaining rows.
 */
function sideChildren(
  focusedSide: SideWindow | undefined,
  accordion: boolean,
  enlargedSide: boolean,
): (width: number, height: number) => readonly Box[] {
  const absorber = focusedSide ?? "files"
  return (_width, height) => {
    if (enlargedSide) {
      // Only the focused pane, so the documented "absent means hidden" contract
      // stays literally true rather than emitting zero-extent entries.
      return [{ window: absorber, weight: 1 }]
    }
    if (height >= MIN_HEIGHT_FOR_NORMAL_LAYOUT) {
      return SIDE_WINDOWS.map((window): Box => {
        if (window === "status") return { window, size: STATUS_PANE_HEIGHT }
        const focused = window === focusedSide
        if (window === "stash" && !focused) return { window, size: FOLDED_PANE_HEIGHT }
        return { window, weight: accordion && focused ? EXPANDED_SIDE_PANEL_WEIGHT : 1 }
      })
    }
    const squashed = height >= MIN_HEIGHT_FOR_TALL_SQUASHED ? FOLDED_PANE_HEIGHT : 1
    return SIDE_WINDOWS.map((window) =>
      window === absorber ? { window, weight: 1 } : { window, size: squashed },
    )
  }
}

export function computeLayout(terminal: TerminalSize, requested: LayoutRequest = {}): LayoutGeometry {
  const terminalWidth = safeDimension(terminal.width)
  const terminalHeight = safeDimension(terminal.height)
  const focus: FocusId = requested.focus ?? "main"
  const screenMode = requested.screenMode ?? "normal"
  const accordion = requested.accordion !== false
  const hintsVisible = requested.hintsVisible !== false
  const logVisible = requested.logVisible === true
  const requestedRatio = Number.isFinite(requested.sidePanelRatio ?? Number.NaN)
    ? clamp(requested.sidePanelRatio as number, 0, 1)
    : DEFAULT_SIDE_PANEL_RATIO
  const requestedLog = Number.isFinite(requested.logHeight ?? Number.NaN)
    ? Math.floor(requested.logHeight as number)
    : DEFAULT_LOG_HEIGHT

  const infoHeight = hintsVisible && terminalHeight >= 2 ? 1 : 0
  const bodyHeight = terminalHeight - infoHeight

  const widthTooSmall = terminalWidth < MIN_LEFT_WIDTH + SPLITTER_SIZE + MIN_MAIN_WIDTH
  const heightTooSmall = logVisible
    ? bodyHeight < MIN_MAIN_HEIGHT + SPLITTER_SIZE + MIN_LOG_HEIGHT
    : bodyHeight < MIN_MAIN_HEIGHT
  const tooSmall = widthTooSmall || heightTooSmall

  const focusedSide = isSideWindow(focus) ? focus : undefined
  const enlargedSide = screenMode !== "normal" && focusedSide !== undefined
  const sideCollapsed = screenMode !== "normal" && focusedSide === undefined
  const mainCollapsed = screenMode === "full" && focusedSide !== undefined

  // A terminal too narrow to host both regions hides whichever one the user did
  // not just ask to enlarge, rather than hiding both. sideHidden and mainHidden
  // are mutually exclusive: sideCollapsed requires no focused side pane, while
  // mainCollapsed and enlargedSide require one, and the two widthTooSmall terms
  // are negations of each other.
  const sideHidden = sideCollapsed || (widthTooSmall && !enlargedSide)
  const mainHidden = mainCollapsed || (widthTooSmall && enlargedSide)

  let sideWidth: number
  if (sideHidden) sideWidth = 0
  else if (mainHidden) sideWidth = terminalWidth
  else {
    const target = screenMode === "half" ? Math.floor(terminalWidth / 2) : Math.round(terminalWidth * requestedRatio)
    sideWidth = clamp(target, MIN_LEFT_WIDTH, terminalWidth - SPLITTER_SIZE - MIN_MAIN_WIDTH)
  }
  const splitterWidth = sideWidth > 0 && !mainHidden ? SPLITTER_SIZE : 0
  const mainWidth = mainHidden ? 0 : terminalWidth - sideWidth - splitterWidth

  const logCapacity = bodyHeight - SPLITTER_SIZE - MIN_MAIN_HEIGHT
  const logHeight = !logVisible || mainWidth === 0 || logCapacity < MIN_LOG_HEIGHT
    ? 0
    : clamp(requestedLog, MIN_LOG_HEIGHT, logCapacity)
  const logSplitterHeight = logHeight > 0 ? SPLITTER_SIZE : 0

  const mainSectionChildren: Box[] = [{ window: "main", weight: 1 }]
  if (logHeight > 0) {
    mainSectionChildren.push({ window: "hsplit", size: logSplitterHeight })
    mainSectionChildren.push({ window: "log", size: logHeight })
  }

  const bodyChildren: Box[] = []
  if (sideWidth > 0) {
    bodyChildren.push({
      direction: "row",
      ...(mainWidth === 0 ? { weight: 1 } : { size: sideWidth }),
      conditionalChildren: sideChildren(focusedSide, accordion, enlargedSide),
    })
  }
  if (splitterWidth > 0) bodyChildren.push({ window: "vsplit", size: splitterWidth })
  if (mainWidth > 0) bodyChildren.push({ direction: "row", weight: 1, children: mainSectionChildren })

  const statusWidth = Number.isFinite(requested.statusWidth ?? Number.NaN)
    ? clamp(Math.floor(requested.statusWidth as number), 0, terminalWidth)
    : 0
  const infoChildren: Box[] = [{ window: "hints", weight: 1 }]
  if (statusWidth > 0) infoChildren.push({ window: "info", size: statusWidth })

  const rootChildren: Box[] = [{ direction: "column", weight: 1, children: bodyChildren }]
  if (infoHeight > 0) rootChildren.push({ direction: "column", size: infoHeight, children: infoChildren })

  const rawWindows = arrangeWindows(
    { direction: "row", children: rootChildren },
    0,
    0,
    terminalWidth,
    terminalHeight,
  )
  // Drop zero-extent entries so "absent from this map means hidden" is literally
  // true for every consumer, including a pane squeezed to nothing by a degenerate
  // terminal size.
  const windows: Partial<Record<WindowName, Dimensions>> = {}
  for (const [name, dimensions] of Object.entries(rawWindows)) {
    if (widthOf(dimensions) > 0 && heightOf(dimensions) > 0) windows[name as WindowName] = dimensions
  }

  return {
    terminalWidth,
    terminalHeight,
    windows,
    sidePanelRatio: requestedRatio,
    sideWidth,
    logHeight,
    logVisible,
    screenMode,
    hintsVisible: infoHeight > 0,
    tooSmall,
  }
}

export function ratioForMouseX(geometry: LayoutGeometry, mouseX: number): number {
  if (!Number.isFinite(mouseX) || geometry.terminalWidth <= 0) return geometry.sidePanelRatio
  return clamp(mouseX / geometry.terminalWidth, 0, 1)
}

export function logHeightForMouseY(geometry: LayoutGeometry, mouseY: number): number {
  if (!Number.isFinite(mouseY)) return geometry.logHeight
  const bodyHeight = geometry.terminalHeight - (geometry.hintsVisible ? 1 : 0)
  return Math.max(0, bodyHeight - Math.floor(mouseY) - SPLITTER_SIZE)
}
```

- [ ] **Step 4: Add the temporary compatibility wrappers**

`root-view.ts` still imports `resizeLeftPane` and `resizeCommandLog`. Append to
`src/ui/layout.ts` so the suite stays green until Task 6 removes them:

```ts
/** @deprecated Removed in the root-view migration. Use ratioForMouseX. */
export function resizeLeftPane(current: LayoutGeometry, mouseX: number): LayoutGeometry {
  return computeLayout(
    { width: current.terminalWidth, height: current.terminalHeight },
    { sidePanelRatio: ratioForMouseX(current, mouseX), logHeight: current.logHeight, logVisible: current.logVisible },
  )
}

/** @deprecated Removed in the root-view migration. Use logHeightForMouseY. */
export function resizeCommandLog(current: LayoutGeometry, mouseY: number): LayoutGeometry {
  return computeLayout(
    { width: current.terminalWidth, height: current.terminalHeight },
    { sidePanelRatio: current.sidePanelRatio, logHeight: logHeightForMouseY(current, mouseY), logVisible: current.logVisible },
  )
}
```

- [ ] **Step 5: Patch `root-view.ts` just enough to typecheck**

`root-view.ts` reads `geometry.leftWidth`, `geometry.rightX`, `geometry.mainY`,
`geometry.mainHeight`, `geometry.mainWidth`, `geometry.verticalSplitterX`,
`geometry.verticalSplitterWidth`, `geometry.horizontalSplitterY`,
`geometry.horizontalSplitterHeight`, `geometry.logY`, `geometry.leftX`, and
`geometry.leftHeight`, none of which exist any more. Do **not** rewrite
`applyLayout` here — that is Task 6. Instead, in `applyLayout`, derive the old
names from the new geometry at the top of the method and leave the body
untouched:

```ts
  private applyLayout(): void {
    const geometry = this.geometry
    const side = geometry.windows.status
    const main = geometry.windows.main
    const log = geometry.windows.log
    const legacy = {
      leftX: 0,
      leftWidth: geometry.sideWidth,
      leftHeight: geometry.terminalHeight,
      verticalSplitterX: geometry.sideWidth,
      verticalSplitterWidth: geometry.windows.vsplit === undefined ? 0 : 1,
      rightX: main?.x0 ?? 0,
      mainY: main?.y0 ?? 0,
      mainWidth: widthOf(main),
      mainHeight: heightOf(main),
      horizontalSplitterY: heightOf(main),
      horizontalSplitterHeight: geometry.windows.hsplit === undefined ? 0 : 1,
      logY: log?.y0 ?? 0,
      logHeight: geometry.logHeight,
      logVisible: geometry.logVisible,
      terminalHeight: geometry.terminalHeight,
      tooSmall: geometry.tooSmall,
    }
    void side
    // ... existing body, reading `legacy` instead of `geometry` ...
  }
```

Mechanically rename every `geometry.<oldField>` in the existing `applyLayout`
body to `legacy.<oldField>`. Also update the three `computeLayout(...)` call
sites in the constructor and in `handleResize` / `focusManager.onChange` to pass
`sidePanelRatio: this.geometry.sidePanelRatio` in place of
`leftWidth: this.geometry.leftWidth`, and add
`import { widthOf, heightOf } from "./layout"`. This is deliberate scaffolding
with a one-task lifetime.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `bun test tests/ui/layout.test.ts`
Expected: PASS — all seven describe blocks.

Run: `bun run check`
Expected: typecheck clean, all tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/ui/layout.ts src/ui/root-view.ts tests/ui/layout.test.ts
git commit -m "feat: build the layout from a box tree

Replaces the fixed-column arithmetic with a box tree over the new engine:
proportional side region, accordion left stack with a pinned status pane
and a folded stash pane, short-terminal fallbacks, three screen modes and
a reserved hints row. root-view keeps a temporary legacy adapter until it
is migrated."
```

---

## Task 4: The declarative binding registry

**Files:**
- Create: `src/ui/bindings.ts`
- Test: `tests/ui/bindings.test.ts`
- Read for reference: `learn-projects/lazygit/pkg/gui/options_map.go`

`src/ui/keymap.ts` stays as-is in this task: `normalizeKey`, `KeyLike` and
`KeyStroke` are reused by the registry. Only `CORE_KEYMAP` becomes dead, and
Task 5 deletes it.

**Interfaces:**
- Consumes: `normalizeKey`, `type KeyLike`, `type KeyStroke` from `src/ui/keymap.ts`; `type AppModel` from `src/app/model.ts`; `type FocusId` from `src/ui/focus.ts`; `type ScreenMode` from `src/ui/layout.ts`.
- Produces:
  ```ts
  export const ACTIONS: readonly string[]              // frozen tuple, see Step 3
  export type Action = (typeof ACTIONS)[number]
  export type BindingContext = FocusId | "global" | "modal"

  export type UiState = {
    readonly focus: FocusId
    readonly screenMode: ScreenMode
    readonly modal: boolean
    readonly mainScope: "all" | "staged" | "unstaged" | undefined
    readonly selectedBranchKind: "local" | "remote" | "remote-branch" | undefined
    readonly hasSelectedStash: boolean
  }

  export type Binding = {
    readonly keys: readonly (string | KeyLike)[]
    readonly action: Action
    readonly description: string
    readonly menuDescription?: string
    readonly displayKeys?: string
    readonly contexts?: readonly BindingContext[]
    readonly displayOnScreen?: boolean
    readonly available?: (model: AppModel, ui: UiState) => boolean
  }

  export type MenuEntry = {
    readonly group: "context" | "global"
    readonly keys: string
    readonly description: string
    readonly enabled: boolean
  }

  export function formatHints(entries: readonly { readonly description: string; readonly key: string }[], width: number): string
  export class BindingRegistry {
    constructor(bindings: readonly Binding[])
    readonly bindings: readonly Binding[]
    // When both model and ui are supplied, a binding whose `available` predicate is
    // false is skipped and resolution falls through to the next priority level, so an
    // unavailable context binding does not shadow a global one (e.g. `escape` declared
    // as commit-back in `main` must not hide the global `back`). A modal never falls
    // through. Omitting model/ui skips availability filtering entirely.
    resolve(key: KeyLike, options?: { readonly context?: BindingContext; readonly modal?: boolean; readonly model?: AppModel; readonly ui?: UiState }): Binding | undefined
    dispatch(key: KeyLike, options?: { readonly context?: BindingContext; readonly modal?: boolean; readonly model?: AppModel; readonly ui?: UiState }): Action | undefined
    hintsFor(context: BindingContext, model: AppModel, ui: UiState, width: number): string
    menuFor(context: BindingContext, model: AppModel, ui: UiState): readonly MenuEntry[]
  }
  export function assertHandlersCover(registry: BindingRegistry, handlers: ReadonlySet<string>): void
  export const GITHUNK_BINDINGS: readonly Binding[]
  export function createRegistry(bindings?: readonly Binding[]): BindingRegistry
  ```

- [ ] **Step 1: Write the failing tests**

Create `tests/ui/bindings.test.ts`:

```ts
import { describe, expect, test } from "bun:test"
import {
  ACTIONS,
  BindingRegistry,
  GITHUNK_BINDINGS,
  assertHandlersCover,
  createRegistry,
  formatHints,
  type Binding,
  type UiState,
} from "../../src/ui/bindings"
import type { AppModel } from "../../src/app/model"

function model(overrides: Partial<AppModel> = {}): AppModel {
  return {
    repositoryRoot: "/tmp/repo",
    branch: "feature",
    reviewTarget: { kind: "working-tree", scope: "unstaged" },
    files: [],
    patches: [],
    rawPatchSections: [],
    reviewStatuses: {},
    reviewSummary: { reviewed: 0, invalidated: 0, commits: 0, files: 0, additions: 0, deletions: 0 },
    loading: false,
    commandLog: [],
    title: "Working Tree — Unstaged",
    commits: [],
    ...overrides,
  } as AppModel
}

function ui(overrides: Partial<UiState> = {}): UiState {
  return {
    focus: "files",
    screenMode: "normal",
    modal: false,
    mainScope: "unstaged",
    selectedBranchKind: undefined,
    ...overrides,
  }
}

describe("formatHints", () => {
  test("renders description then key, joined by a pipe", () => {
    expect(formatHints([
      { description: "stage", key: "space" },
      { description: "reviewed", key: "r" },
    ], 80)).toBe("stage: space | reviewed: r")
  })

  test("truncates with an ellipsis rather than overflowing", () => {
    const rendered = formatHints([
      { description: "stage", key: "space" },
      { description: "reviewed", key: "r" },
      { description: "discard", key: "d" },
    ], 20)
    expect(rendered).toBe("stage: space | …")
    expect(rendered.length).toBeLessThanOrEqual(20)
  })

  test("keeps the first entry even when it alone exceeds the width", () => {
    expect(formatHints([{ description: "a-very-long-description", key: "x" }], 5))
      .toBe("a-very-long-description: x")
  })

  test("renders nothing for no entries", () => {
    expect(formatHints([], 80)).toBe("")
  })
})

describe("BindingRegistry validation", () => {
  test("rejects two bindings sharing a keystroke in one context", () => {
    expect(() => new BindingRegistry([
      { keys: ["x"], action: "quit", description: "one" },
      { keys: ["x"], action: "refresh", description: "two" },
    ])).toThrow(/collision/i)
  })

  test("treats a physical uppercase name as shift plus the lowercase key", () => {
    expect(() => new BindingRegistry([
      { keys: ["X"], action: "quit", description: "one" },
      { keys: ["shift+x"], action: "refresh", description: "two" },
    ])).toThrow(/collision/i)
  })

  test("allows the same keystroke in different contexts", () => {
    expect(() => new BindingRegistry([
      { keys: ["d"], action: "discard-file", description: "discard", contexts: ["files"] },
      { keys: ["d"], action: "stash-drop", description: "drop", contexts: ["stash"] },
    ])).not.toThrow()
  })

  test("rejects a binding with an empty description", () => {
    expect(() => new BindingRegistry([
      { keys: ["x"], action: "quit", description: "" },
    ])).toThrow(/description/i)
  })

  test("rejects an action outside the declared action list", () => {
    expect(() => new BindingRegistry([
      { keys: ["x"], action: "not-a-real-action" as Binding["action"], description: "nope" },
    ])).toThrow(/action/i)
  })
})

describe("BindingRegistry resolution", () => {
  const registry = new BindingRegistry([
    { keys: ["escape"], action: "back", description: "back" },
    { keys: ["escape"], action: "commit-back", description: "back", contexts: ["commits"] },
    { keys: ["escape"], action: "modal-cancel", description: "cancel", contexts: ["modal"] },
    { keys: ["h", "left"], action: "pane-previous", description: "pane" },
  ])

  test("prefers modal over context over global", () => {
    expect(registry.dispatch({ name: "escape" }, { context: "commits", modal: true })).toBe("modal-cancel")
    expect(registry.dispatch({ name: "escape" }, { context: "commits" })).toBe("commit-back")
    expect(registry.dispatch({ name: "escape" }, { context: "files" })).toBe("back")
  })

  test("does not fall through to global bindings while a modal is open", () => {
    expect(registry.dispatch({ name: "h" }, { context: "files", modal: true })).toBeUndefined()
  })

  test("matches every declared alias for a binding", () => {
    expect(registry.dispatch({ name: "h" })).toBe("pane-previous")
    expect(registry.dispatch({ name: "left" })).toBe("pane-previous")
  })
})

describe("BindingRegistry hints", () => {
  const registry = new BindingRegistry([
    { keys: ["space"], action: "stage-file", description: "stage", contexts: ["files"], displayOnScreen: true },
    { keys: ["r"], action: "mark-reviewed", description: "reviewed", contexts: ["files"], displayOnScreen: true },
    { keys: ["d"], action: "discard-file", description: "discard", contexts: ["files"], displayOnScreen: true, available: (m) => m.reviewTarget.kind === "working-tree" },
    { keys: ["enter"], action: "inspect", description: "open", contexts: ["files"] },
    { keys: ["l", "right"], action: "pane-next", description: "pane", displayKeys: "h/l", displayOnScreen: true },
    { keys: ["q"], action: "quit", description: "quit" },
  ])

  test("includes only bindings marked for the screen", () => {
    const hints = registry.hintsFor("files", model(), ui(), 200)
    expect(hints).toContain("stage: space")
    expect(hints).not.toContain("open: enter")
    expect(hints).not.toContain("quit")
  })

  test("uses displayKeys when a binding overrides its rendered key", () => {
    expect(registry.hintsFor("files", model(), ui(), 200)).toContain("pane: h/l")
  })

  test("drops bindings that are unavailable rather than showing them", () => {
    const branchReview = model({ reviewTarget: { kind: "branch", baseRef: "origin/main" } })
    const hints = registry.hintsFor("files", branchReview, ui(), 200)
    expect(hints).toContain("stage: space")
    expect(hints).not.toContain("discard: d")
  })

  test("lists context bindings before global ones", () => {
    const hints = registry.hintsFor("files", model(), ui(), 200)
    expect(hints.indexOf("stage: space")).toBeLessThan(hints.indexOf("pane: h/l"))
  })

  test("does not repeat a global binding whose key the context overrides", () => {
    const shadowing = new BindingRegistry([
      { keys: ["d"], action: "discard-file", description: "discard file", contexts: ["files"], displayOnScreen: true },
      { keys: ["d"], action: "discard-selection", description: "discard lines", displayOnScreen: true },
    ])
    expect(shadowing.hintsFor("files", model(), ui(), 200)).toBe("discard file: d")
  })
})

describe("BindingRegistry menu", () => {
  const registry = new BindingRegistry([
    { keys: ["space"], action: "stage-file", description: "stage", menuDescription: "stage the selected file", contexts: ["files"] },
    { keys: ["d"], action: "discard-file", description: "discard", contexts: ["files"], available: (m) => m.reviewTarget.kind === "working-tree" },
    { keys: ["q"], action: "quit", description: "quit" },
  ])

  test("groups context bindings first and uses the long description", () => {
    const entries = registry.menuFor("files", model(), ui())
    expect(entries[0]).toEqual({ group: "context", keys: "space", description: "stage the selected file", enabled: true })
    expect(entries.at(-1)).toEqual({ group: "global", keys: "q", description: "quit", enabled: true })
  })

  test("lists unavailable bindings as disabled rather than omitting them", () => {
    const entries = registry.menuFor("files", model({ reviewTarget: { kind: "branch", baseRef: "origin/main" } }), ui())
    expect(entries.find((entry) => entry.keys === "d")).toEqual({ group: "context", keys: "d", description: "discard", enabled: false })
  })
})

describe("assertHandlersCover", () => {
  test("names every action with no handler", () => {
    const registry = new BindingRegistry([
      { keys: ["x"], action: "quit", description: "quit" },
      { keys: ["y"], action: "refresh", description: "refresh" },
    ])
    expect(() => assertHandlersCover(registry, new Set(["quit"]))).toThrow(/refresh/)
    expect(() => assertHandlersCover(registry, new Set(["quit", "refresh"]))).not.toThrow()
  })
})

describe("GITHUNK_BINDINGS", () => {
  const registry = createRegistry()

  test("constructs without collisions and with a description on every binding", () => {
    expect(() => createRegistry()).not.toThrow()
    for (const binding of GITHUNK_BINDINGS) expect(binding.description.length).toBeGreaterThan(0)
  })

  test("declares only actions from the action list", () => {
    for (const binding of GITHUNK_BINDINGS) expect(ACTIONS).toContain(binding.action)
  })

  test("keeps the pane numbers, mode switches and Git verbs from v0.1", () => {
    expect(registry.dispatch({ name: "0" })).toBe("focus-main")
    expect(registry.dispatch({ name: "5" })).toBe("focus-stash")
    expect(registry.dispatch({ name: "b" })).toBe("mode-branch")
    expect(registry.dispatch({ name: "w" })).toBe("mode-working-tree")
    expect(registry.dispatch({ name: "P" })).toBe("push")
    expect(registry.dispatch({ name: "p" })).toBe("pull")
    expect(registry.dispatch({ name: "R" })).toBe("refresh")
    expect(registry.dispatch({ name: "o", ctrl: true })).toBe("copy-exact")
  })

  test("completes hjkl: h and l move between panes", () => {
    expect(registry.dispatch({ name: "h" })).toBe("pane-previous")
    expect(registry.dispatch({ name: "l" })).toBe("pane-next")
    expect(registry.dispatch({ name: "tab" })).toBe("pane-next")
    expect(registry.dispatch({ name: "tab", shift: true })).toBe("pane-previous")
  })

  test("overrides h and l as hunk navigation inside the main pane", () => {
    expect(registry.dispatch({ name: "h" }, { context: "main" })).toBe("hunk-previous")
    expect(registry.dispatch({ name: "l" }, { context: "main" })).toBe("hunk-next")
  })

  test("moves the main scope toggle off tab and onto bracket keys", () => {
    expect(registry.dispatch({ name: "tab" }, { context: "main" })).toBe("pane-next")
    expect(registry.dispatch({ name: "]" }, { context: "main" })).toBe("scope-next")
    expect(registry.dispatch({ name: "[" }, { context: "main" })).toBe("scope-previous")
  })

  test("declares paging, jumping, main scrolling, screen modes and the menu", () => {
    expect(registry.dispatch({ name: "." })).toBe("page-next")
    expect(registry.dispatch({ name: "," })).toBe("page-previous")
    expect(registry.dispatch({ name: ">" })).toBe("goto-bottom")
    expect(registry.dispatch({ name: "<" })).toBe("goto-top")
    expect(registry.dispatch({ name: "end" })).toBe("goto-bottom")
    expect(registry.dispatch({ name: "J" })).toBe("main-scroll-down")
    expect(registry.dispatch({ name: "K" })).toBe("main-scroll-up")
    expect(registry.dispatch({ name: "L" })).toBe("main-scroll-right")
    expect(registry.dispatch({ name: "H" })).toBe("main-scroll-left")
    expect(registry.dispatch({ name: "d", ctrl: true })).toBe("main-half-page-down")
    expect(registry.dispatch({ name: "u", ctrl: true })).toBe("main-half-page-up")
    expect(registry.dispatch({ name: "+" })).toBe("screen-mode-next")
    expect(registry.dispatch({ name: "_" })).toBe("screen-mode-previous")
    expect(registry.dispatch({ name: "?" })).toBe("keybinding-menu")
  })

  test("keeps the per-pane meanings of space, d, enter, r, g, n and f", () => {
    expect(registry.dispatch({ name: "space" }, { context: "files" })).toBe("stage-file")
    expect(registry.dispatch({ name: "space" }, { context: "main" })).toBe("stage-selection")
    expect(registry.dispatch({ name: "space" }, { context: "branches" })).toBe("branch-checkout")
    expect(registry.dispatch({ name: "space" }, { context: "stash" })).toBe("stash-apply")
    expect(registry.dispatch({ name: "d" }, { context: "files" })).toBe("discard-file")
    expect(registry.dispatch({ name: "d" }, { context: "main" })).toBe("discard-selection")
    expect(registry.dispatch({ name: "d" }, { context: "branches" })).toBe("branch-delete")
    expect(registry.dispatch({ name: "d" }, { context: "stash" })).toBe("stash-drop")
    expect(registry.dispatch({ name: "g" }, { context: "stash" })).toBe("stash-pop")
    expect(registry.dispatch({ name: "r" }, { context: "files" })).toBe("mark-reviewed")
    expect(registry.dispatch({ name: "r" }, { context: "branches" })).toBe("branch-rename")
    expect(registry.dispatch({ name: "n" }, { context: "branches" })).toBe("branch-create")
    expect(registry.dispatch({ name: "f" }, { context: "branches" })).toBe("fetch-remote")
  })

  test("hides staging hints when the review target is read-only", () => {
    const branchReview = model({ reviewTarget: { kind: "branch", baseRef: "origin/main" } })
    const hints = registry.hintsFor("files", branchReview, ui(), 300)
    expect(hints).not.toContain("stage: space")
    expect(hints).not.toContain("discard: d")
    expect(hints).toContain("reviewed: r")
  })

  test("hides line actions in the All scope, where they are unavailable", () => {
    const all = model({ reviewTarget: { kind: "working-tree", scope: "all" } })
    const hints = registry.hintsFor("main", all, ui({ focus: "main", mainScope: "all" }), 300)
    expect(hints).not.toContain("stage: space")
    expect(hints).toContain("scope: ")
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test tests/ui/bindings.test.ts`
Expected: FAIL — `Cannot find module '../../src/ui/bindings'`.

- [ ] **Step 3: Implement the registry core**

Create `src/ui/bindings.ts` with the action list, types and class:

```ts
import type { AppModel } from "../app/model"
import type { FocusId } from "./focus"
import type { ScreenMode } from "./layout"
import { normalizeKey, type KeyLike, type KeyStroke } from "./keymap"

export const ACTIONS = [
  // focus and layout
  "focus-main", "focus-status", "focus-files", "focus-branches", "focus-commits", "focus-stash",
  "command-log", "pane-next", "pane-previous",
  "screen-mode-next", "screen-mode-previous", "keybinding-menu",
  // list and document navigation
  "next", "previous", "page-next", "page-previous", "goto-top", "goto-bottom",
  "main-scroll-down", "main-scroll-up", "main-scroll-left", "main-scroll-right",
  "main-half-page-down", "main-half-page-up",
  "hunk-next", "hunk-previous", "scope-next", "scope-previous",
  // review targets
  "mode-branch", "mode-working-tree", "mark-reviewed",
  // working tree
  "stage-file", "discard-file", "stage-all", "stage-selection", "discard-selection",
  // commits
  "commit", "amend", "commit-drilldown", "commit-back",
  // branches and remotes
  "branch-checkout", "branch-create", "branch-delete", "branch-rename", "fetch-remote",
  // stash
  "stash-create", "stash-apply", "stash-pop", "stash-drop", "stash-inspect",
  // sync
  "fetch", "pull", "push", "refresh",
  // copy
  "copy-menu", "copy-exact",
  // generic
  "filter", "inspect", "back", "modal-cancel", "modal-confirm", "filter-backspace", "quit",
] as const

export type Action = (typeof ACTIONS)[number]

export type BindingContext = FocusId | "global" | "modal"

export type UiState = {
  readonly focus: FocusId
  readonly screenMode: ScreenMode
  readonly modal: boolean
  readonly mainScope: "all" | "staged" | "unstaged" | undefined
  readonly selectedBranchKind: "local" | "remote" | "remote-branch" | undefined
  /** Whether the stash pane currently has an entry selected. */
  readonly hasSelectedStash: boolean
}

export type Binding = {
  readonly keys: readonly (string | KeyLike)[]
  readonly action: Action
  /** Short label for the hints bar, e.g. "stage". */
  readonly description: string
  /** Long label for the ? menu. Falls back to description. */
  readonly menuDescription?: string
  /** Overrides the rendered key text, so a pair can render as "h/l". */
  readonly displayKeys?: string
  /** Omitted means the binding is global. */
  readonly contexts?: readonly BindingContext[]
  readonly displayOnScreen?: boolean
  readonly available?: (model: AppModel, ui: UiState) => boolean
}

export type MenuEntry = {
  readonly group: "context" | "global"
  readonly keys: string
  readonly description: string
  readonly enabled: boolean
}

const HINT_SEPARATOR = " | "
const HINT_ELLIPSIS = "…"

function strokeId(stroke: KeyStroke): string {
  const modifiers = [stroke.ctrl ? "c" : "", stroke.shift ? "s" : "", stroke.meta ? "m" : "", stroke.option ? "o" : "", stroke.super ? "w" : ""]
  return [stroke.name, ...modifiers].join("/")
}

function keyLabel(key: string | KeyLike): string {
  const stroke = normalizeKey(key)
  const modifiers = [stroke.ctrl && "ctrl", stroke.option && "alt", stroke.meta && "meta", stroke.super && "super"].filter(Boolean)
  const name = stroke.shift && stroke.name.length === 1 ? stroke.name.toLocaleUpperCase() : stroke.name
  return [...modifiers, name].join("+")
}

function displayKeyFor(binding: Binding): string {
  return binding.displayKeys ?? keyLabel(binding.keys[0] ?? "")
}

function isAvailable(binding: Binding, model: AppModel, ui: UiState): boolean {
  return binding.available === undefined || binding.available(model, ui)
}

/** Mirrors lazygit's formatBindingInfos: "description: key" joined by pipes, truncated with an ellipsis. */
export function formatHints(entries: readonly { readonly description: string; readonly key: string }[], width: number): string {
  const parts: string[] = []
  let length = 0
  for (const [index, entry] of entries.entries()) {
    const text = `${entry.description}: ${entry.key}`
    if (index > 0 && length + HINT_SEPARATOR.length + text.length > width) {
      parts.push(HINT_ELLIPSIS)
      break
    }
    parts.push(text)
    length += (index > 0 ? HINT_SEPARATOR.length : 0) + text.length
  }
  return parts.join(HINT_SEPARATOR)
}

export class BindingRegistry {
  readonly bindings: readonly Binding[]
  private readonly byContext: Map<BindingContext, Map<string, Binding>>

  constructor(bindings: readonly Binding[]) {
    this.bindings = bindings
    this.byContext = new Map()
    const actions = new Set<string>(ACTIONS)

    for (const binding of bindings) {
      if (binding.description.trim().length === 0) {
        throw new Error(`Binding for ${binding.action} has an empty description`)
      }
      if (!actions.has(binding.action)) {
        throw new Error(`Binding declares unknown action ${binding.action}`)
      }
      for (const context of binding.contexts ?? ["global"]) {
        let table = this.byContext.get(context)
        if (table === undefined) {
          table = new Map()
          this.byContext.set(context, table)
        }
        for (const key of binding.keys) {
          const id = strokeId(normalizeKey(key))
          const previous = table.get(id)
          if (previous !== undefined) {
            throw new Error(`Key collision in ${context}: ${keyLabel(key)} maps to ${previous.action} and ${binding.action}`)
          }
          table.set(id, binding)
        }
      }
    }
  }

  resolve(key: KeyLike, options: { readonly context?: BindingContext; readonly modal?: boolean } = {}): Binding | undefined {
    const id = strokeId(normalizeKey(key))
    // A modal is a hard input boundary: it never falls through to pane or global bindings.
    if (options.modal === true) return this.byContext.get("modal")?.get(id)
    const context = options.context
    const focused = context === undefined ? undefined : this.byContext.get(context)?.get(id)
    return focused ?? this.byContext.get("global")?.get(id)
  }

  dispatch(key: KeyLike, options: { readonly context?: BindingContext; readonly modal?: boolean } = {}): Action | undefined {
    return this.resolve(key, options)?.action
  }

  /** Context bindings first, then global bindings whose keys the context has not overridden. */
  private orderedFor(context: BindingContext): readonly Binding[] {
    const contextBindings = this.bindings.filter((binding) => (binding.contexts ?? []).includes(context))
    const shadowed = new Set(contextBindings.flatMap((binding) => binding.keys.map((key) => strokeId(normalizeKey(key)))))
    const globalBindings = this.bindings.filter((binding) =>
      binding.contexts === undefined &&
      !binding.keys.some((key) => shadowed.has(strokeId(normalizeKey(key)))),
    )
    return [...contextBindings, ...globalBindings]
  }

  hintsFor(context: BindingContext, model: AppModel, ui: UiState, width: number): string {
    const entries = this.orderedFor(context)
      .filter((binding) => binding.displayOnScreen === true && isAvailable(binding, model, ui))
      .map((binding) => ({ description: binding.description, key: displayKeyFor(binding) }))
    return formatHints(entries, width)
  }

  menuFor(context: BindingContext, model: AppModel, ui: UiState): readonly MenuEntry[] {
    const contextActions = new Set(this.bindings
      .filter((binding) => (binding.contexts ?? []).includes(context))
      .map((binding) => binding.action))
    return this.orderedFor(context).map((binding) => ({
      group: contextActions.has(binding.action) ? "context" as const : "global" as const,
      keys: displayKeyFor(binding),
      description: binding.menuDescription ?? binding.description,
      enabled: isAvailable(binding, model, ui),
    }))
  }
}

export function assertHandlersCover(registry: BindingRegistry, handlers: ReadonlySet<string>): void {
  const missing = [...new Set(registry.bindings.map((binding) => binding.action))]
    .filter((action) => !handlers.has(action))
    .sort()
  if (missing.length > 0) throw new Error(`Bindings declare actions with no handler: ${missing.join(", ")}`)
}
```

- [ ] **Step 4: Declare githunk's bindings**

Append to `src/ui/bindings.ts`. The `available` predicates encode the refusal
conditions `root-view.ts` currently checks inline; Task 5 removes the duplicated
inline checks.

```ts
const writable = (model: AppModel): boolean => model.reviewTarget.kind === "working-tree"
const lineActions = (model: AppModel, ui: UiState): boolean => writable(model) && ui.mainScope !== "all"
const inCommit = (model: AppModel): boolean => model.reviewTarget.kind === "commit"
/**
 * Mirrors lazygit, which gates stash actions only on having a stash selected, and
 * AppController.ensureStashOperation, which permits them from a working-tree or a
 * stash review target but refuses a branch or commit one.
 */
const stashOperation = (model: AppModel, ui: UiState): boolean =>
  ui.hasSelectedStash &&
  (model.reviewTarget.kind === "working-tree" || model.reviewTarget.kind === "stash")

export const GITHUNK_BINDINGS: readonly Binding[] = [
  // ---- focus and layout ----
  { keys: ["0"], action: "focus-main", description: "main pane" },
  { keys: ["1"], action: "focus-status", description: "review pane" },
  { keys: ["2"], action: "focus-files", description: "files pane" },
  { keys: ["3"], action: "focus-branches", description: "branches pane" },
  { keys: ["4"], action: "focus-commits", description: "commits pane" },
  { keys: ["5"], action: "focus-stash", description: "stash pane" },
  { keys: ["@"], action: "command-log", description: "log", menuDescription: "show, focus or hide the command log" },
  { keys: ["l", "right", "tab"], action: "pane-next", description: "pane", displayKeys: "h/l", displayOnScreen: true, menuDescription: "focus the next pane" },
  { keys: ["h", "left", "shift+tab"], action: "pane-previous", description: "previous pane", menuDescription: "focus the previous pane" },
  // Declared as an object, not the string "+": keymap.ts's parseKeyStroke splits
  // a string on "+" as the modifier delimiter, so "+" parses to an empty name.
  { keys: [{ name: "+" }], action: "screen-mode-next", description: "zoom in", menuDescription: "enlarge the focused region" },
  { keys: ["_"], action: "screen-mode-previous", description: "zoom out", menuDescription: "shrink the focused region" },
  { keys: ["?"], action: "keybinding-menu", description: "help", displayOnScreen: true, menuDescription: "show all keybindings" },

  // ---- navigation ----
  { keys: ["."], action: "page-next", description: "page down" },
  { keys: [","], action: "page-previous", description: "page up" },
  { keys: [">", "end"], action: "goto-bottom", description: "go to bottom" },
  { keys: ["<", "home"], action: "goto-top", description: "go to top" },
  { keys: ["J"], action: "main-scroll-down", description: "scroll main down" },
  { keys: ["K"], action: "main-scroll-up", description: "scroll main up" },
  { keys: ["L"], action: "main-scroll-right", description: "scroll main right" },
  { keys: ["H"], action: "main-scroll-left", description: "scroll main left" },
  { keys: ["ctrl+d", "pagedown"], action: "main-half-page-down", description: "main half page down" },
  { keys: ["ctrl+u", "pageup"], action: "main-half-page-up", description: "main half page up" },

  // ---- review targets ----
  { keys: ["b"], action: "mode-branch", description: "branch review", displayOnScreen: true, available: (model) => model.reviewTarget.kind !== "branch" },
  { keys: ["w"], action: "mode-working-tree", description: "working tree", displayOnScreen: true, available: (model) => model.reviewTarget.kind !== "working-tree" },

  // ---- sync ----
  { keys: ["R"], action: "refresh", description: "refresh" },
  { keys: ["f"], action: "fetch", description: "fetch", displayOnScreen: true },
  { keys: ["p"], action: "pull", description: "pull", displayOnScreen: true },
  { keys: ["P"], action: "push", description: "push", displayOnScreen: true },

  // ---- commit and stash creation ----
  { keys: ["c"], action: "commit", description: "commit", displayOnScreen: true, available: writable },
  { keys: ["A"], action: "amend", description: "amend", available: writable },
  { keys: ["s"], action: "stash-create", description: "stash", displayOnScreen: true, available: writable },

  // ---- copy ----
  { keys: ["y"], action: "copy-menu", description: "copy", displayOnScreen: true, available: (_model, ui) => ui.focus === "main", menuDescription: "open the copy menu" },
  { keys: ["ctrl+o"], action: "copy-exact", description: "copy selection", available: (_model, ui) => ui.focus === "main" },

  // ---- generic ----
  { keys: ["/"], action: "filter", description: "filter" },
  { keys: ["escape"], action: "back", description: "back" },
  { keys: ["enter"], action: "inspect", description: "inspect" },
  { keys: ["q"], action: "quit", description: "quit" },
  { keys: ["ctrl+c"], action: "quit", description: "quit" },

  // ---- main pane ----
  { keys: ["l"], action: "hunk-next", description: "hunk", displayKeys: "h/l", contexts: ["main"], displayOnScreen: true, menuDescription: "next hunk" },
  { keys: ["h"], action: "hunk-previous", description: "previous hunk", contexts: ["main"] },
  { keys: ["]"], action: "scope-next", description: "scope", contexts: ["main"], displayOnScreen: true, available: writable, menuDescription: "next scope: all, staged, unstaged" },
  { keys: ["["], action: "scope-previous", description: "previous scope", contexts: ["main"], available: writable },
  { keys: ["space"], action: "stage-selection", description: "stage", contexts: ["main"], displayOnScreen: true, available: lineActions, menuDescription: "stage the selected lines" },
  { keys: ["d"], action: "discard-selection", description: "discard", contexts: ["main"], displayOnScreen: true, available: (model, ui) => lineActions(model, ui) && ui.mainScope !== "staged", menuDescription: "discard the selected lines" },
  { keys: ["j", "down"], action: "next", description: "down", contexts: ["main"] },
  { keys: ["k", "up"], action: "previous", description: "up", contexts: ["main"] },
  { keys: ["escape"], action: "commit-back", description: "back", contexts: ["main"], available: inCommit },

  // ---- files pane ----
  { keys: ["space"], action: "stage-file", description: "stage", contexts: ["files"], displayOnScreen: true, available: writable, menuDescription: "stage or unstage the selected file" },
  { keys: ["d"], action: "discard-file", description: "discard", contexts: ["files"], displayOnScreen: true, available: writable, menuDescription: "discard the file's changes" },
  { keys: ["a"], action: "stage-all", description: "all", contexts: ["files"], displayOnScreen: true, available: writable, menuDescription: "stage or unstage every file" },
  { keys: ["r"], action: "mark-reviewed", description: "reviewed", contexts: ["files"], displayOnScreen: true, menuDescription: "mark the file reviewed" },
  { keys: ["enter"], action: "inspect", description: "open", contexts: ["files"], displayOnScreen: true, menuDescription: "open the file in the main pane" },
  { keys: ["j", "down"], action: "next", description: "down", contexts: ["files"] },
  { keys: ["k", "up"], action: "previous", description: "up", contexts: ["files"] },
  { keys: ["escape"], action: "commit-back", description: "back", contexts: ["files"], available: inCommit },

  // ---- branches pane ----
  { keys: ["space"], action: "branch-checkout", description: "checkout", contexts: ["branches"], displayOnScreen: true, menuDescription: "switch to the branch, creating a local tracking branch if needed" },
  { keys: ["n"], action: "branch-create", description: "new", contexts: ["branches"], displayOnScreen: true },
  { keys: ["d"], action: "branch-delete", description: "delete", contexts: ["branches"], displayOnScreen: true, available: (_model, ui) => ui.selectedBranchKind === "local" },
  { keys: ["r"], action: "branch-rename", description: "rename", contexts: ["branches"], displayOnScreen: true, available: (_model, ui) => ui.selectedBranchKind === "local" },
  { keys: ["f"], action: "fetch-remote", description: "fetch", contexts: ["branches"], displayOnScreen: true, available: (_model, ui) => ui.selectedBranchKind === "remote" },
  { keys: ["enter"], action: "inspect", description: "inspect", contexts: ["branches"], displayOnScreen: true },
  { keys: ["/"], action: "filter", description: "filter", contexts: ["branches"], displayOnScreen: true },
  { keys: ["j", "down"], action: "next", description: "down", contexts: ["branches"] },
  { keys: ["k", "up"], action: "previous", description: "up", contexts: ["branches"] },

  // ---- commits pane ----
  { keys: ["enter"], action: "commit-drilldown", description: "inspect", contexts: ["commits"], displayOnScreen: true, menuDescription: "inspect this commit on its own" },
  { keys: ["escape"], action: "commit-back", description: "back", contexts: ["commits"], displayOnScreen: true, available: inCommit },
  { keys: ["j", "down"], action: "next", description: "down", contexts: ["commits"] },
  { keys: ["k", "up"], action: "previous", description: "up", contexts: ["commits"] },

  // ---- stash pane ----
  { keys: ["space"], action: "stash-apply", description: "apply", contexts: ["stash"], displayOnScreen: true, available: stashOperation },
  { keys: ["g"], action: "stash-pop", description: "pop", contexts: ["stash"], displayOnScreen: true, available: stashOperation },
  { keys: ["d"], action: "stash-drop", description: "drop", contexts: ["stash"], displayOnScreen: true, available: stashOperation },
  { keys: ["enter"], action: "stash-inspect", description: "inspect", contexts: ["stash"], displayOnScreen: true, available: stashOperation },
  { keys: ["j", "down"], action: "next", description: "down", contexts: ["stash"] },
  { keys: ["k", "up"], action: "previous", description: "up", contexts: ["stash"] },

  // ---- command log ----
  { keys: ["j", "down"], action: "next", description: "down", contexts: ["command-log"] },
  { keys: ["k", "up"], action: "previous", description: "up", contexts: ["command-log"] },

  // ---- status pane ----
  { keys: ["j", "down"], action: "next", description: "down", contexts: ["status"] },
  { keys: ["k", "up"], action: "previous", description: "up", contexts: ["status"] },

  // ---- modal ----
  { keys: ["escape"], action: "modal-cancel", description: "cancel", contexts: ["modal"] },
  { keys: ["enter"], action: "modal-confirm", description: "confirm", contexts: ["modal"] },
  { keys: ["backspace"], action: "filter-backspace", description: "delete", contexts: ["modal"] },
]

export function createRegistry(bindings: readonly Binding[] = GITHUNK_BINDINGS): BindingRegistry {
  return new BindingRegistry(bindings)
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bun test tests/ui/bindings.test.ts`
Expected: PASS.

If a collision is thrown, the message names the context and both actions; fix
the declarations, never the collision check. Note the deliberate overlap: `l`
maps to `pane-next` globally and to `hunk-next` in `main`. That is not a
collision — they live in different context tables, and the `main` entry wins
there.

`pagedown` / `pageup` are the OpenTUI key names for those keys. If the test for
`ctrl+d` passes but a manual check shows Page Down doing nothing, log
`key.name` for the real keypress and correct the alias; do not remove the
`ctrl+d` binding.

- [ ] **Step 6: Run the full check**

Run: `bun run check`
Expected: typecheck clean, all tests pass. Nothing consumes the registry yet.

- [ ] **Step 7: Commit**

```bash
git add src/ui/bindings.ts tests/ui/bindings.test.ts
git commit -m "feat: declare keybindings in one enumerable registry

Bindings become data: keys, action, short and long descriptions, context,
whether they belong on the hints bar, and an availability predicate. One
declaration now feeds dispatch, the hints bar and the ? menu, so they
cannot drift apart."
```

---

## Task 5: Route root-view input through the registry

No test currently constructs `RootView`, which is why key handling has never
been tested end to end. This task builds the harness that makes that possible
and then migrates dispatch onto it.

**Files:**
- Create: `tests/helpers/shell-harness.ts`
- Create: `tests/ui/dispatch.integration.test.ts`
- Modify: `src/ui/root-view.ts`
- Modify: `src/ui/focus.ts`
- Modify: `src/ui/keymap.ts` (delete `CORE_KEYMAP` and `Keymap`)
- Modify: `tests/ui/keymap.test.ts` (drop the `CORE_KEYMAP` and `Keymap` cases)

**Interfaces:**
- Consumes: `createRegistry`, `assertHandlersCover`, `type Action`, `type UiState` from `src/ui/bindings.ts`; `createApp` from `src/app/create-app.ts`; `createTestRenderer` from `@opentui/core/testing`.
- Produces:
  ```ts
  // tests/helpers/shell-harness.ts
  export type ShellHarness = {
    readonly app: App
    readonly renderer: TestRenderer
    readonly repository: TempRepository
    pressKey(key: KeyInput, modifiers?: { shift?: boolean; ctrl?: boolean }): Promise<void>
    drag(startX: number, startY: number, endX: number, endY: number): Promise<void>
    resize(width: number, height: number): Promise<void>
    frame(): string
    cleanup(): Promise<void>
  }
  export type ShellHarnessOptions = {
    readonly width?: number      // default 120
    readonly height?: number     // default 40
    readonly commits?: readonly string[]  // commit subjects to create, oldest first
    readonly stash?: boolean
  }
  export function createShellHarness(options?: ShellHarnessOptions): Promise<ShellHarness>

  // src/ui/focus.ts additions
  export function nextFocus(current: FocusId, logVisible: boolean): FocusId
  export function previousFocus(current: FocusId, logVisible: boolean): FocusId
  // and on FocusManager:
  //   cycle(direction: "next" | "previous"): void

  // src/ui/root-view.ts additions
  // (private) uiState(): UiState
  // (private) handleAction(action: Action, key: KeyEvent): void
  ```

- [ ] **Step 1: Write the harness**

Create `tests/helpers/shell-harness.ts`:

```ts
import { createTestRenderer, type KeyInput } from "@opentui/core/testing"
import { createApp, type App } from "../../src/app/create-app"
import { GitRunner } from "../../src/git/runner"
import { createTempRepository, type TempRepository } from "./temp-repository"

export type ShellHarnessOptions = {
  readonly width?: number
  readonly height?: number
  /** Commit subjects to create, oldest first. */
  readonly commits?: readonly string[]
  readonly stash?: boolean
}

export type ShellHarness = {
  readonly app: App
  readonly repository: TempRepository
  pressKey(key: KeyInput, modifiers?: { shift?: boolean; ctrl?: boolean }): Promise<void>
  drag(startX: number, startY: number, endX: number, endY: number): Promise<void>
  resize(width: number, height: number): Promise<void>
  frame(): string
  cleanup(): Promise<void>
}

export async function createShellHarness(options: ShellHarnessOptions = {}): Promise<ShellHarness> {
  const repository = await createTempRepository()
  const subjects = options.commits ?? ["first commit", "second commit", "third commit"]
  for (const [index, subject] of subjects.entries()) {
    await repository.write("a.txt", `revision ${index}\n`)
    await repository.git(["add", "a.txt"])
    await repository.git(["commit", "-m", subject])
  }
  if (options.stash === true) {
    await repository.write("a.txt", "stashed\n")
    await repository.git(["stash", "push", "-m", "wip"])
  }
  // Leave one unstaged change so the working-tree target is never empty.
  await repository.write("b.txt", "unstaged\n")

  const setup = await createTestRenderer({
    width: options.width ?? 120,
    height: options.height ?? 40,
    useMouse: true,
    enableMouseMovement: true,
  })

  const app = createApp({
    repositoryRoot: repository.path,
    runner: new GitRunner(repository.path),
    renderer: setup.renderer,
  })
  await app.refresh()
  await setup.flush()

  return {
    app,
    repository,
    async pressKey(key, modifiers) {
      setup.mockInput.pressKey(key, modifiers)
      await setup.flush()
    },
    async drag(startX, startY, endX, endY) {
      await setup.mockMouse.drag(startX, startY, endX, endY)
      await setup.flush()
    },
    async resize(width, height) {
      setup.resize(width, height)
      await setup.flush()
    },
    frame: () => setup.captureCharFrame(),
    async cleanup() {
      app.destroy()
      setup.renderer.destroy()
      await repository.cleanup()
    },
  }
}
```

- [ ] **Step 2: Write the failing dispatch test**

Create `tests/ui/dispatch.integration.test.ts`:

```ts
import { afterEach, describe, expect, test } from "bun:test"
import { createShellHarness, type ShellHarness } from "../helpers/shell-harness"
import { getMainCursorTarget } from "../../src/ui/panes/main-pane"

describe("root view dispatch", () => {
  let harness: ShellHarness | undefined
  afterEach(async () => { await harness?.cleanup() })

  test("h and l move focus between panes", async () => {
    harness = await createShellHarness()
    const view = harness.app.view
    expect(view).toBeDefined()

    await harness.pressKey("2")
    expect(view!.focusManager.active).toBe("files")
    await harness.pressKey("l")
    expect(view!.focusManager.active).toBe("branches")
    await harness.pressKey("l")
    expect(view!.focusManager.active).toBe("commits")
    await harness.pressKey("h")
    expect(view!.focusManager.active).toBe("branches")
  })

  test("tab and shift+tab cycle panes in the same order as l and h", async () => {
    harness = await createShellHarness()
    const view = harness.app.view!

    await harness.pressKey("2")
    await harness.pressKey("TAB")
    expect(view.focusManager.active).toBe("branches")
    await harness.pressKey("TAB", { shift: true })
    expect(view.focusManager.active).toBe("files")
  })

  test("j and k move the commits cursor over real commits", async () => {
    harness = await createShellHarness({ commits: ["alpha commit", "beta commit", "gamma commit"] })

    await harness.pressKey("4")
    expect(harness.frame()).toContain("gamma commit")
    await harness.pressKey("j")
    expect(harness.frame()).toContain("beta commit")
  })

  test("bracket keys change the main scope and tab no longer does", async () => {
    harness = await createShellHarness()

    await harness.pressKey("0")
    const before = harness.app.controller.state.title
    await harness.pressKey("TAB")
    expect(harness.app.controller.state.title).toBe(before)
    // TAB moved focus off main, and ] is declared only in the main context,
    // so re-focus main before checking that ] does change the scope.
    await harness.pressKey("0")
    await harness.pressKey("]")
    expect(harness.app.controller.state.title).not.toBe(before)
  })

  test("every declared action has a handler", async () => {
    // RootView calls assertHandlersCover in its constructor, so construction
    // failing at all is the assertion. An explicit case documents the intent.
    harness = await createShellHarness()
    expect(harness.app.view).toBeDefined()
  })
})
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `bun test tests/ui/dispatch.integration.test.ts`
Expected: FAIL — `h` and `l` are unbound, so focus does not move.

- [ ] **Step 4: Add pane cycling to the focus manager**

In `src/ui/focus.ts`, append:

```ts
/** Cycle order for h/l and tab: the main pane, then the five left panes, then the log when it is shown. */
function cycleOrder(logVisible: boolean): readonly FocusId[] {
  return logVisible ? [...FOCUS_IDS, COMMAND_LOG_FOCUS_ID] : FOCUS_IDS
}

export function nextFocus(current: FocusId, logVisible: boolean): FocusId {
  const order = cycleOrder(logVisible)
  const index = order.indexOf(current)
  return order[(index + 1) % order.length] ?? current
}

export function previousFocus(current: FocusId, logVisible: boolean): FocusId {
  const order = cycleOrder(logVisible)
  const index = order.indexOf(current)
  return order[(index - 1 + order.length) % order.length] ?? current
}
```

And add a method to `FocusManager`:

```ts
  cycle(direction: "next" | "previous"): void {
    const next = direction === "next"
      ? nextFocus(this.active, this.logVisible)
      : previousFocus(this.active, this.logVisible)
    this.focus(next)
  }
```

- [ ] **Step 5: Extract the existing inline key blocks into named action methods**

This is the bulk of the task and it is a mechanical extraction, not a rewrite.
In `src/ui/root-view.ts`, for each row below, move the body of the matching
`if (key.name === ...)` block into a private method with the given name,
**deleting the `key.name` comparison and the modifier guards** (the registry has
already matched the key) and **deleting the availability guard whose condition
is now the binding's `available` predicate** (listed in the third column). Keep
every other guard, especially `this.mutationInFlight` and the two-press
confirmation state.

| New method | Body comes from | Delete this guard, now covered by `available` |
| --- | --- | --- |
| `actionStageFile()` | `handleMutationKey`, files branch, `key.name === "space"` | — |
| `actionDiscardFile()` | files branch, `key.name === "d"` | — |
| `actionStageAll()` | files branch, `key.name === "a"` | — |
| `actionMarkReviewed()` | files branch, `key.name === "r"` | — |
| `actionOpenFile()` | files branch, `key.name === "enter"` | — |
| `actionStageSelection()` | main branch, `key.name === "space"` | the `scope === "all"` early return at the top of the main branch |
| `actionDiscardSelection()` | main branch, `key.name === "d"` | the same `scope === "all"` early return |
| `actionScopeCycle(direction)` | main branch, `key.name === "tab"` | — |
| `actionBranchCheckout()` | branches branch, `key.name === "space"` | — |
| `actionBranchCreate()` | branches branch, `key.name === "n"` | — |
| `actionBranchDelete(force)` | branches branch, `key.name === "d"` | `selected?.kind === "local"` |
| `actionBranchRename()` | branches branch, `key.name === "r"` | `selected?.kind === "local"` |
| `actionFetchRemote()` | branches branch, `key.name === "f"` | the `else` that sets "Fetch is available for a selected remote" |
| `actionBranchInspect()` | branches branch, `key.name === "enter"` | — |
| `actionCommitDrilldown()` | commits branch, `key.name === "enter"` | — |
| `actionCommitBack()` | the three `key.name === "escape"` commit-back blocks | `reviewTarget.kind === "commit"` |
| `actionStashApply()` | stash branch, `key.name === "space"` | `reviewTarget.kind === "working-tree"` |
| `actionStashPop()` | stash branch, `key.name === "g"` | same |
| `actionStashDrop()` | stash branch, `key.name === "d"` | same |
| `actionStashInspect()` | stash branch, `key.name === "enter"` | same |
| `actionStashCreate()` | `key.name === "s"` | — |
| `actionCommit()` / `actionAmend()` | the `key.name === "c"` / `amendShortcut` block | — |
| `actionFetch()` / `actionPull()` / `actionPush()` / `actionRefresh()` | the matching blocks | — |
| `actionModeBranch()` / `actionModeWorkingTree()` | `key.name === "b"` / `key.name === "w"` | — |
| `actionFilter()` | branches branch, `key.name === "/"` | — |
| `actionCopyMenu()` / `actionCopyExact()` | `handleCopyKey` | `this.focusManager.active !== "main"` |
| `actionMoveCursor(direction)` | the six `j`/`k` blocks, dispatching on `this.focusManager.active` | — |

Each `available` guard removed above is already asserted by a test in
`tests/ui/bindings.test.ts`, so removing it does not lose coverage.

Keep the refusal messages that tell the user how to proceed — for example
`"Line actions disabled in All scope; press ] to choose staged or unstaged"`
(note the updated key) — but move them into the branch that runs when the
action arrives despite being unavailable, which can only happen via the mouse.

- [ ] **Step 6: Replace the key handler with a registry dispatch**

In the `RootView` constructor, replace the `Keymap` field with the registry, and
assert handler coverage so a declared action with no `case` fails at
construction:

```ts
  private readonly registry = createRegistry()
```

Add the handler set and the assertion at the end of the constructor:

```ts
    assertHandlersCover(this.registry, HANDLED_ACTIONS)
```

with, at module scope:

```ts
const HANDLED_ACTIONS: ReadonlySet<string> = new Set<Action>([
  "focus-main", "focus-status", "focus-files", "focus-branches", "focus-commits", "focus-stash",
  "command-log", "pane-next", "pane-previous",
  "screen-mode-next", "screen-mode-previous", "keybinding-menu",
  "next", "previous", "page-next", "page-previous", "goto-top", "goto-bottom",
  "main-scroll-down", "main-scroll-up", "main-scroll-left", "main-scroll-right",
  "main-half-page-down", "main-half-page-up",
  "hunk-next", "hunk-previous", "scope-next", "scope-previous",
  "mode-branch", "mode-working-tree", "mark-reviewed",
  "stage-file", "discard-file", "stage-all", "stage-selection", "discard-selection",
  "commit", "amend", "commit-drilldown", "commit-back",
  "branch-checkout", "branch-create", "branch-delete", "branch-rename", "fetch-remote",
  "stash-create", "stash-apply", "stash-pop", "stash-drop", "stash-inspect",
  "fetch", "pull", "push", "refresh",
  "copy-menu", "copy-exact",
  "filter", "inspect", "back", "modal-cancel", "modal-confirm", "filter-backspace", "quit",
])
```

Replace `this.handleKey` with:

```ts
    this.handleKey = (key: KeyEvent) => {
      const normalized = normalizeKey(key)
      const routedKey = {
        ...key,
        name: normalized.name,
        ctrl: normalized.ctrl,
        shift: normalized.shift,
        meta: normalized.meta,
        option: normalized.option,
      } as KeyEvent

      // Dialogs consume raw characters, so modal input keeps its own path.
      if (this.modalInputActive()) {
        this.handleModalKey(routedKey)
        key.preventDefault()
        key.stopPropagation()
        return
      }

      const action = this.registry.dispatch(routedKey, {
        context: this.focusManager.active,
        model: this.model,
        ui: this.uiState(),
      })
      if (action === undefined) return
      this.handleAction(action, routedKey)
      key.preventDefault()
      key.stopPropagation()
    }
```

Add the UI state accessor and the action switch:

```ts
  private uiState(): UiState {
    const target = this.model.reviewTarget
    const selected = selectedBranchItem(this.model, this.branchCursorIndex, this.branchFilter)
    return {
      focus: this.focusManager.active,
      screenMode: this.geometry.screenMode,
      modal: this.modalInputActive(),
      mainScope: target.kind === "working-tree" ? target.scope : undefined,
      selectedBranchKind: selected?.kind,
      hasSelectedStash: selectedStashEntry(this.panes.stash, this.model) !== undefined,
    }
  }

  private handleAction(action: Action, key: KeyEvent): void {
    switch (action) {
      case "quit": this.onQuit?.(); return
      case "focus-main": this.focusManager.focus("main"); return
      case "focus-status": this.focusManager.focus("status"); return
      case "focus-files": this.focusManager.focus("files"); return
      case "focus-branches": this.focusManager.focus("branches"); return
      case "focus-commits": this.focusManager.focus("commits"); return
      case "focus-stash": this.focusManager.focus("stash"); return
      case "command-log": this.focusManager.handleKey("@"); return
      case "pane-next": this.focusManager.cycle("next"); return
      case "pane-previous": this.focusManager.cycle("previous"); return
      case "next": this.actionMoveCursor("next"); return
      case "previous": this.actionMoveCursor("previous"); return
      case "stage-file": this.actionStageFile(); return
      case "discard-file": this.actionDiscardFile(); return
      case "stage-all": this.actionStageAll(); return
      case "mark-reviewed": this.actionMarkReviewed(); return
      case "inspect": this.actionInspect(); return
      case "stage-selection": this.actionStageSelection(); return
      case "discard-selection": this.actionDiscardSelection(); return
      case "scope-next": this.actionScopeCycle("next"); return
      case "scope-previous": this.actionScopeCycle("previous"); return
      case "branch-checkout": this.actionBranchCheckout(); return
      case "branch-create": this.actionBranchCreate(); return
      case "branch-delete": this.actionBranchDelete(key.shift === true); return
      case "branch-rename": this.actionBranchRename(); return
      case "fetch-remote": this.actionFetchRemote(); return
      case "commit-drilldown": this.actionCommitDrilldown(); return
      case "commit-back": this.actionCommitBack(); return
      case "back": this.actionBack(); return
      case "stash-create": this.actionStashCreate(); return
      case "stash-apply": this.actionStashApply(); return
      case "stash-pop": this.actionStashPop(); return
      case "stash-drop": this.actionStashDrop(); return
      case "stash-inspect": this.actionStashInspect(); return
      case "commit": this.actionCommit(); return
      case "amend": this.actionAmend(); return
      case "fetch": this.actionFetch(); return
      case "pull": this.actionPull(); return
      case "push": this.actionPush(); return
      case "refresh": this.actionRefresh(); return
      case "mode-branch": this.actionModeBranch(); return
      case "mode-working-tree": this.actionModeWorkingTree(); return
      case "filter": this.actionFilter(); return
      case "copy-menu": this.actionCopyMenu(); return
      case "copy-exact": this.actionCopyExact(); return
      case "modal-cancel": case "modal-confirm": case "filter-backspace":
        this.handleModalKey(key); return
      // Implemented in Task 6.
      case "screen-mode-next": case "screen-mode-previous":
        return
      // Implemented in Task 7.
      case "keybinding-menu":
        return
      // Implemented in Task 8.
      case "page-next": case "page-previous": case "goto-top": case "goto-bottom":
      case "main-scroll-down": case "main-scroll-up": case "main-scroll-left": case "main-scroll-right":
      case "main-half-page-down": case "main-half-page-up":
      case "hunk-next": case "hunk-previous":
        return
    }
  }
```

The three groups that `return` without doing anything are filled in by the
named tasks. They are listed in `HANDLED_ACTIONS` so `assertHandlersCover`
passes, and the switch is exhaustive so TypeScript flags any action added later
with no case.

`actionInspect()` dispatches on focus, because `enter` means "open the file",
"inspect the branch" or "inspect the stash" depending on the pane: move the
three `key.name === "enter"` bodies into it behind a
`switch (this.focusManager.active)`.

`actionBack()` is the global `escape`: it clears whichever pending
confirmation is set (`pendingBranchDelete`, `pendingStashDrop`,
`pendingFileDiscard`, `pendingRemoteMismatch`, the branch filter) and does
nothing when none is.

- [ ] **Step 7: Delete the dead key handling**

Delete `handleMutationKey`, `handleCopyKey` and the `handleFilterKey` early
return that duplicated dispatch — their bodies now live in the action methods.
Keep `handleFilterKey` itself; `handleModalKey` still calls it.

Delete `CORE_KEYMAP`, `Keymap`, `createKeymap`, `assertNoKeyCollisions` and
`KeyBinding` / `KeymapDefinition` / `ResolveOptions` from `src/ui/keymap.ts`.
Keep `KeyLike`, `KeyStroke` and `normalizeKey`, which `bindings.ts` imports.
Delete the corresponding cases from `tests/ui/keymap.test.ts`, keeping the
`normalizeKey` cases.

- [ ] **Step 8: Update the refusal message that names the moved key**

Search for `press Tab to choose staged or unstaged` and change it to
`press ] to choose staged or unstaged`.

- [ ] **Step 9: Run the tests**

Run: `bun test tests/ui/dispatch.integration.test.ts`
Expected: PASS — all five cases.

Run: `bun run check`
Expected: typecheck clean, all tests pass. TypeScript will name any action with
no `case`; add the case rather than widening the switch.

- [ ] **Step 10: Commit**

```bash
git add src/ui/root-view.ts src/ui/focus.ts src/ui/keymap.ts tests/helpers/shell-harness.ts tests/ui/dispatch.integration.test.ts tests/ui/keymap.test.ts
git commit -m "refactor: dispatch root-view input from the binding registry

Twenty-six hardcoded key comparisons spread across three handlers become
named action methods behind one exhaustive switch, with availability moved
onto the bindings. Adds a test harness that drives a real RootView over a
real repository, so h/l, tab and the relocated scope keys are covered."
```

---

## Task 6: Consume the arranged layout and add screen modes

**Files:**
- Modify: `src/ui/root-view.ts`
- Modify: `src/ui/layout.ts` (delete the two deprecated wrappers)
- Test: `tests/ui/dispatch.integration.test.ts` (extend)

**Interfaces:**
- Consumes: `computeLayout`, `widthOf`, `heightOf`, `ratioForMouseX`, `logHeightForMouseY`, `nextScreenMode`, `previousScreenMode`, `SIDE_WINDOWS`, `type LayoutGeometry`, `type ScreenMode`, `type WindowName` from `src/ui/layout.ts`.
- Produces: `RootView.screenMode: ScreenMode` (readable by tests), and `RootView` accepting `sidePanelRatio` in `RootViewOptions` in place of `leftWidth`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/ui/dispatch.integration.test.ts`:

```ts
describe("screen modes and layout", () => {
  let harness: ShellHarness | undefined
  afterEach(async () => { await harness?.cleanup() })

  test("the side region takes a third of the width by default, not thirty columns", async () => {
    harness = await createShellHarness({ width: 200, height: 40 })
    expect(harness.app.view!.geometry.sideWidth).toBe(Math.round(200 * 0.3333))
  })

  test("plus and underscore move through the screen modes", async () => {
    harness = await createShellHarness()
    const view = harness.app.view!

    await harness.pressKey("0")
    expect(view.screenMode).toBe("normal")
    await harness.pressKey("+")
    expect(view.screenMode).toBe("half")
    expect(view.geometry.sideWidth).toBe(0)
    await harness.pressKey("+")
    expect(view.screenMode).toBe("full")
    await harness.pressKey("_")
    await harness.pressKey("_")
    expect(view.screenMode).toBe("normal")
    expect(view.geometry.sideWidth).toBeGreaterThan(0)
  })

  test("the focused left pane is taller than its siblings and stash folds when unfocused", async () => {
    harness = await createShellHarness({ height: 40 })
    const view = harness.app.view!

    await harness.pressKey("4")
    const commits = view.geometry.windows.commits
    const branches = view.geometry.windows.branches
    const stash = view.geometry.windows.stash
    expect((commits!.y1 - commits!.y0 + 1)).toBeGreaterThan(branches!.y1 - branches!.y0 + 1)
    expect((stash!.y1 - stash!.y0 + 1)).toBe(3)

    await harness.pressKey("5")
    const focusedStash = view.geometry.windows.stash!
    expect(focusedStash.y1 - focusedStash.y0 + 1).toBeGreaterThan(3)
  })

  test("a terminal resize keeps the layout consistent", async () => {
    harness = await createShellHarness({ width: 200, height: 50 })
    await harness.resize(90, 30)
    const view = harness.app.view!
    expect(view.geometry.terminalWidth).toBe(90)
    expect(view.geometry.sideWidth).toBeGreaterThanOrEqual(18)
    expect(view.geometry.windows.main).toBeDefined()
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test tests/ui/dispatch.integration.test.ts -t "screen modes"`
Expected: FAIL — `view.screenMode` is undefined and `+` does nothing.

- [ ] **Step 3: Give the view a screen mode and a ratio**

In `src/ui/root-view.ts`:

- Add `screenMode: ScreenMode = "normal"` and `sidePanelRatio = DEFAULT_SIDE_PANEL_RATIO` as public fields.
- Replace `readonly leftWidth?: number` in `RootViewOptions` with `readonly sidePanelRatio?: number`, and read it into `this.sidePanelRatio` in the constructor.
- Add a single place that rebuilds the geometry, and call it from the constructor, `handleResize`, `focusManager.onChange`, and the new screen-mode and drag handlers:

```ts
  private recomputeLayout(): void {
    this.geometry = computeLayout(
      { width: this.renderer.terminalWidth, height: this.renderer.terminalHeight },
      {
        sidePanelRatio: this.sidePanelRatio,
        logHeight: this.logHeight,
        logVisible: this.focusManager.logVisible,
        focus: this.focusManager.active,
        screenMode: this.screenMode,
        hintsVisible: true,
        statusWidth: this.statusSegmentWidth(),
      },
    )
    this.applyLayout()
  }
```

`this.logHeight` is a new number field initialised from
`options.logHeight ?? DEFAULT_LOG_HEIGHT`; the geometry is no longer the place
the requested log height is stored, because screen modes can zero it.

`statusSegmentWidth()` returns `0` in this task. Task 7 makes it return the
rendered status string's width.

- [ ] **Step 4: Rewrite `applyLayout` against the window map**

Replace the whole `applyLayout` method — including the `legacy` scaffolding from
Task 3 — with:

```ts
  private applyLayout(): void {
    const windows = this.geometry.windows
    const place = (renderable: BoxRenderable, name: WindowName): void => {
      const dimensions = windows[name]
      if (dimensions === undefined) {
        renderable.visible = false
        return
      }
      renderable.left = dimensions.x0
      renderable.top = dimensions.y0
      renderable.width = Math.max(1, widthOf(dimensions))
      renderable.height = Math.max(1, heightOf(dimensions))
      renderable.visible = widthOf(dimensions) > 0 && heightOf(dimensions) > 0
    }

    for (const name of SIDE_WINDOWS) place(this.panes[name].box, name)
    place(this.panes.main.box, "main")
    place(this.commandLog.box, "log")
    place(this.verticalSplitter, "vsplit")
    place(this.horizontalSplitter, "hsplit")

    const log = windows.log
    if (log !== undefined) {
      this.commandLog.resize(Math.max(1, widthOf(log)), Math.max(1, heightOf(log)))
      this.commandLog.update(this.model.commandLog)
    }
    updateMainPane(this.panes.main, this.model, this.geometry.tooSmall)
    this.root.requestRender()
  }
```

`SIDE_WINDOWS` and `FOCUS_IDS` list the same five names in the same order, so
`this.panes[name]` type-checks. Delete `stackedHeights` from
`src/ui/root-view.ts` — nothing calls it any more.

- [ ] **Step 5: Implement the screen-mode actions**

Replace the placeholder cases in `handleAction`:

```ts
      case "screen-mode-next":
        this.screenMode = nextScreenMode(this.screenMode)
        this.recomputeLayout()
        return
      case "screen-mode-previous":
        this.screenMode = previousScreenMode(this.screenMode)
        this.recomputeLayout()
        return
```

- [ ] **Step 6: Move the splitter drag handlers onto the new mapping**

In `installMouseHandlers`, replace the two drag handlers:

```ts
    this.verticalSplitter.onMouseDrag = (event: MouseEvent) => {
      this.sidePanelRatio = ratioForMouseX(this.geometry, event.x)
      this.recomputeLayout()
    }
    this.horizontalSplitter.onMouseDrag = (event: MouseEvent) => {
      this.logHeight = logHeightForMouseY(this.geometry, event.y)
      this.recomputeLayout()
    }
```

Then delete `resizeLeftPane` and `resizeCommandLog` from `src/ui/layout.ts` and
their imports in `root-view.ts`.

- [ ] **Step 7: Run the tests**

Run: `bun test tests/ui/dispatch.integration.test.ts`
Expected: PASS — the four new cases plus the five from Task 5.

Run: `bun run check`
Expected: typecheck clean, all tests pass.

- [ ] **Step 8: Verify by hand on a wide terminal**

Run: `bun run start` in a terminal at least 160 columns wide.
Expected: the left region is roughly a third of the width; pressing `5` expands
Stash and pressing `4` folds it back to three rows; `+` twice hides the left
region entirely and `_` twice brings it back.

- [ ] **Step 9: Commit**

```bash
git add src/ui/root-view.ts src/ui/layout.ts tests/ui/dispatch.integration.test.ts
git commit -m "feat: proportional layout, accordion panes and screen modes

root-view now positions renderables from the arranged window map, so an
absent window simply hides. The side region is a ratio of the width rather
than a fixed 30 columns, the focused left pane expands, stash folds when
unfocused, and +/_ cycle the three screen modes."
```

---

## Task 7: The hints bar and the `?` menu

**Files:**
- Create: `src/ui/hints-bar.ts`
- Create: `src/ui/keybinding-menu.ts`
- Create: `tests/ui/hints-bar.test.ts`
- Modify: `src/ui/root-view.ts`
- Test: `tests/ui/dispatch.integration.test.ts` (extend)

**Interfaces:**
- Consumes: `BindingRegistry`, `type MenuEntry`, `type UiState` from `src/ui/bindings.ts`; `widthOf`, `heightOf` from `src/ui/layout.ts`.
- Produces:
  ```ts
  // src/ui/hints-bar.ts
  export type HintsBarHandle = {
    readonly hints: TextRenderable
    readonly status: TextRenderable
    update(hintsText: string, statusText: string): void
  }
  export function createHintsBar(renderer: CliRenderer): HintsBarHandle
  export function reviewStatusText(model: AppModel): string

  // src/ui/keybinding-menu.ts
  export function renderMenuLines(entries: readonly MenuEntry[], contextTitle: string): readonly string[]
  export type KeybindingMenuHandle = {
    readonly box: BoxRenderable
    update(entries: readonly MenuEntry[], contextTitle: string): void
  }
  export function createKeybindingMenu(renderer: CliRenderer): KeybindingMenuHandle
  ```

- [ ] **Step 1: Write the failing unit tests**

Create `tests/ui/hints-bar.test.ts`:

```ts
import { describe, expect, test } from "bun:test"
import { reviewStatusText } from "../../src/ui/hints-bar"
import { renderMenuLines } from "../../src/ui/keybinding-menu"
import type { AppModel } from "../../src/app/model"
import type { MenuEntry } from "../../src/ui/bindings"

function model(overrides: Partial<AppModel> = {}): AppModel {
  return {
    repositoryRoot: "/tmp/repo",
    branch: "feature/payment",
    reviewTarget: { kind: "working-tree", scope: "unstaged" },
    files: [],
    patches: [],
    rawPatchSections: [],
    reviewStatuses: {},
    reviewSummary: { reviewed: 7, invalidated: 0, commits: 0, files: 12, additions: 0, deletions: 0 },
    loading: false,
    commandLog: [],
    title: "Working Tree — Unstaged",
    commits: [],
    ...overrides,
  } as AppModel
}

describe("reviewStatusText", () => {
  test("names the target and the review progress", () => {
    expect(reviewStatusText(model())).toBe("Working Tree — Unstaged  7/12 ●")
  })

  test("appends an invalidation count when files changed after review", () => {
    const invalidated = model({
      reviewSummary: { reviewed: 17, invalidated: 2, commits: 7, files: 24, additions: 0, deletions: 0 },
      reviewTarget: { kind: "branch", baseRef: "origin/main" },
      title: "feature/payment vs origin/main",
    })
    expect(reviewStatusText(invalidated)).toBe("feature/payment vs origin/main  17/24 ●  2!")
  })

  test("omits the progress segment when there are no files", () => {
    const empty = model({
      reviewSummary: { reviewed: 0, invalidated: 0, commits: 0, files: 0, additions: 0, deletions: 0 },
    })
    expect(reviewStatusText(empty)).toBe("Working Tree — Unstaged")
  })
})

describe("renderMenuLines", () => {
  const entries: readonly MenuEntry[] = [
    { group: "context", keys: "space", description: "stage the selected file", enabled: true },
    { group: "context", keys: "d", description: "discard the file's changes", enabled: false },
    { group: "global", keys: "q", description: "quit", enabled: true },
  ]

  test("groups context bindings under the pane name and global ones after", () => {
    const lines = renderMenuLines(entries, "Files")
    expect(lines[0]).toBe("Files")
    expect(lines[1]).toBe("  space  stage the selected file")
    expect(lines).toContain("Global")
    expect(lines.at(-1)).toBe("  q      quit")
  })

  test("marks disabled bindings so they are visibly unavailable", () => {
    expect(renderMenuLines(entries, "Files")[2]).toBe("  d      discard the file's changes  (unavailable)")
  })

  test("aligns the key column to the widest key", () => {
    const lines = renderMenuLines([
      { group: "context", keys: "space", description: "stage", enabled: true },
      { group: "context", keys: "d", description: "discard", enabled: true },
    ], "Files")
    expect(lines[1]).toBe("  space  stage")
    expect(lines[2]).toBe("  d      discard")
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test tests/ui/hints-bar.test.ts`
Expected: FAIL — neither module exists.

- [ ] **Step 3: Implement the hints bar**

Create `src/ui/hints-bar.ts`:

```ts
import { TextRenderable, type CliRenderer } from "@opentui/core"
import type { AppModel } from "../app/model"

const HINTS_COLOR = "#8a8a8a"
const STATUS_COLOR = "#c8c8c8"

export type HintsBarHandle = {
  readonly hints: TextRenderable
  readonly status: TextRenderable
  update(hintsText: string, statusText: string): void
}

export function createHintsBar(renderer: CliRenderer): HintsBarHandle {
  const hints = new TextRenderable(renderer, {
    id: "hints-text",
    content: "",
    selectable: false,
    wrapMode: "none",
    position: "absolute",
    fg: HINTS_COLOR,
  })
  const status = new TextRenderable(renderer, {
    id: "review-status-text",
    content: "",
    selectable: false,
    wrapMode: "none",
    position: "absolute",
    fg: STATUS_COLOR,
  })
  return {
    hints,
    status,
    update(hintsText: string, statusText: string) {
      hints.content = hintsText
      status.content = statusText
    },
  }
}

/** The right-aligned segment: what is being reviewed, and how far the review has got. */
export function reviewStatusText(model: AppModel): string {
  const summary = model.reviewSummary
  const files = summary?.files ?? 0
  if (files === 0) return model.title
  const progress = `${summary?.reviewed ?? 0}/${files} ●`
  const invalidated = (summary?.invalidated ?? 0) > 0 ? `  ${summary?.invalidated}!` : ""
  return `${model.title}  ${progress}${invalidated}`
}
```

- [ ] **Step 4: Implement the menu**

Create `src/ui/keybinding-menu.ts`:

```ts
import { BoxRenderable, TextRenderable, type CliRenderer } from "@opentui/core"
import type { MenuEntry } from "./bindings"

const UNAVAILABLE_SUFFIX = "  (unavailable)"

export function renderMenuLines(entries: readonly MenuEntry[], contextTitle: string): readonly string[] {
  const keyWidth = entries.reduce((widest, entry) => Math.max(widest, entry.keys.length), 0)
  const lines: string[] = []
  let group: MenuEntry["group"] | undefined
  for (const entry of entries) {
    if (entry.group !== group) {
      group = entry.group
      lines.push(group === "context" ? contextTitle : "Global")
    }
    const keys = entry.keys.padEnd(keyWidth, " ")
    lines.push(`  ${keys}  ${entry.description}${entry.enabled ? "" : UNAVAILABLE_SUFFIX}`)
  }
  return lines
}

export type KeybindingMenuHandle = {
  readonly box: BoxRenderable
  update(entries: readonly MenuEntry[], contextTitle: string): void
}

export function createKeybindingMenu(renderer: CliRenderer): KeybindingMenuHandle {
  const box = new BoxRenderable(renderer, {
    id: "keybinding-menu",
    border: true,
    borderColor: "#ffffff",
    title: "Keybindings",
    bottomTitle: "Escape or ? to close",
    position: "absolute",
    overflow: "hidden",
    backgroundColor: "#101010",
  })
  const text = new TextRenderable(renderer, {
    id: "keybinding-menu-text",
    content: "",
    selectable: false,
    wrapMode: "none",
    width: "100%",
    height: "100%",
  })
  box.add(text)
  box.visible = false
  return {
    box,
    update(entries: readonly MenuEntry[], contextTitle: string) {
      text.content = renderMenuLines(entries, contextTitle).join("\n")
    },
  }
}
```

- [ ] **Step 5: Run the unit tests to verify they pass**

Run: `bun test tests/ui/hints-bar.test.ts`
Expected: PASS — all six cases.

- [ ] **Step 6: Write the failing integration tests**

Append to `tests/ui/dispatch.integration.test.ts`:

```ts
describe("hints bar and keybinding menu", () => {
  let harness: ShellHarness | undefined
  afterEach(async () => { await harness?.cleanup() })

  test("the hints bar changes with the focused pane", async () => {
    harness = await createShellHarness()

    await harness.pressKey("2")
    const files = harness.frame()
    expect(files).toContain("stage: space")
    expect(files).toContain("reviewed: r")

    await harness.pressKey("5")
    const stash = harness.frame()
    expect(stash).toContain("apply: space")
    expect(stash).not.toContain("reviewed: r")
  })

  test("the review status is rendered on the right of the same row", async () => {
    harness = await createShellHarness()
    expect(harness.frame()).toContain("Working Tree")
  })

  test("question mark opens a menu listing the focused pane's bindings", async () => {
    harness = await createShellHarness()

    await harness.pressKey("5")
    await harness.pressKey("?")
    const open = harness.frame()
    expect(open).toContain("Keybindings")
    expect(open).toContain("pop")

    await harness.pressKey("ESCAPE")
    expect(harness.frame()).not.toContain("Keybindings")
  })

  test("the menu swallows pane keys while it is open", async () => {
    harness = await createShellHarness()
    const view = harness.app.view!

    await harness.pressKey("2")
    await harness.pressKey("?")
    await harness.pressKey("4")
    expect(view.focusManager.active).toBe("files")
    await harness.pressKey("?")
    await harness.pressKey("4")
    expect(view.focusManager.active).toBe("commits")
  })
})
```

- [ ] **Step 7: Wire both into the view**

In `src/ui/root-view.ts`:

- Construct and add both renderables:
  ```ts
    this.hintsBar = createHintsBar(renderer)
    this.keybindingMenu = createKeybindingMenu(renderer)
    this.root.add(this.hintsBar.hints)
    this.root.add(this.hintsBar.status)
    this.root.add(this.keybindingMenu.box)
  ```
- Make `statusSegmentWidth()` real:
  ```ts
    private statusSegmentWidth(): number {
      return reviewStatusText(this.model).length
    }
  ```
- Widen the `place` helper in `applyLayout` so it accepts a `TextRenderable` as
  well as a `BoxRenderable`, by typing its parameter as
  `{ left: number; top: number; width: number | string; height: number | string; visible: boolean }`.
- At the end of `applyLayout`, position and fill the bar, and centre the menu
  over the main region:
  ```ts
    place(this.hintsBar.hints, "hints")
    place(this.hintsBar.status, "info")
    const hintsWidth = widthOf(windows.hints)
    this.hintsBar.update(
      hintsWidth === 0 ? "" : this.registry.hintsFor(this.focusManager.active, this.model, this.uiState(), hintsWidth),
      reviewStatusText(this.model),
    )

    const menuHost = windows.main ?? windows.hints
    if (this.menuOpen && menuHost !== undefined) {
      const width = Math.max(20, Math.min(72, widthOf(menuHost) - 4))
      const height = Math.max(6, Math.min(this.geometry.terminalHeight - 4, heightOf(menuHost) - 2))
      this.keybindingMenu.box.left = menuHost.x0 + Math.floor((widthOf(menuHost) - width) / 2)
      this.keybindingMenu.box.top = menuHost.y0 + Math.floor((heightOf(menuHost) - height) / 2)
      this.keybindingMenu.box.width = width
      this.keybindingMenu.box.height = height
      this.keybindingMenu.update(
        this.registry.menuFor(this.focusManager.active, this.model, this.uiState()),
        paneTitleFor(this.focusManager.active),
      )
    }
    this.keybindingMenu.box.visible = this.menuOpen
  ```
  with a module-scope lookup:
  ```ts
  const PANE_TITLES: Readonly<Record<FocusId, string>> = {
    main: "Main", status: "Review", files: "Files",
    branches: "Branches", commits: "Commits", stash: "Stash",
    "command-log": "Command Log",
  }
  function paneTitleFor(focus: FocusId): string {
    return PANE_TITLES[focus]
  }
  ```
- Add `private menuOpen = false`, include it in `modalInputActive()`, implement
  the action, and handle its keys in `handleModalKey` before every other modal
  branch:
  ```ts
      case "keybinding-menu":
        this.menuOpen = !this.menuOpen
        this.recomputeLayout()
        return
  ```
  ```ts
    // at the top of handleModalKey
    if (this.menuOpen) {
      if (key.name === "escape" || key.name === "?") {
        this.menuOpen = false
        this.recomputeLayout()
      }
      return
    }
  ```
- Call `this.recomputeLayout()` at the end of `update(model)` so a model change
  that widens the status segment re-arranges the row.

- [ ] **Step 8: Run the tests**

Run: `bun test tests/ui/hints-bar.test.ts tests/ui/dispatch.integration.test.ts`
Expected: PASS.

Run: `bun run check`
Expected: typecheck clean, all tests pass.

- [ ] **Step 9: Verify by hand**

Run: `bun run start`
Expected: the bottom row shows `stage: space | discard: d | …` on the left and
`Working Tree — All  0/N ●` on the right; pressing `1` through `5` changes the
left side; `?` opens the menu and Escape closes it. Press `b` to enter Branch
Review and confirm the staging hints disappear.

- [ ] **Step 10: Commit**

```bash
git add src/ui/hints-bar.ts src/ui/keybinding-menu.ts src/ui/root-view.ts tests/ui/hints-bar.test.ts tests/ui/dispatch.integration.test.ts
git commit -m "feat: show context keybinding hints and a ? menu

The bottom row renders the focused pane's available bindings on the left
and the review target with its progress on the right, both read from the
binding registry so they cannot disagree with dispatch. ? opens the full
list for the focused pane, with unavailable bindings shown as such."
```

---

## Task 8: Complete the navigation keys

Fills in the placeholder cases left in `handleAction` by Task 5.

**Files:**
- Modify: `src/ui/root-view.ts`
- Modify: `src/ui/panes/main-pane.ts`
- Test: `tests/ui/dispatch.integration.test.ts` (extend)

**Interfaces:**
- Consumes: `scrollX`, `scrollY`, `maxScrollX`, `maxScrollY` on `TextRenderable` (from `@opentui/core`'s `TextBufferRenderable`); `getMainDocument`, `getMainCursorTarget`, `setMainCursorTarget` from `src/ui/panes/main-pane.ts`.
- Produces:
  ```ts
  // src/ui/panes/main-pane.ts
  export function scrollMainPane(pane: PaneHandle, axis: "x" | "y", delta: number): void
  // src/ui/panes/commits-pane.ts
  export function commitsCursorIndex(pane: PaneHandle): number
  ```

**Do not add a hunk-navigation function.** `MainCursorTarget` is
`{ fileIndex, hunkIndex?, filePath?, hunkKey? }` (`main-pane.ts:10`) — it has no
line index — and `moveMainCursor` (`main-pane.ts:50`) already builds one target
per hunk. So `hunk-next` / `hunk-previous` *are* `moveMainCursor`, and in the
main pane `h`/`l` and `j`/`k` do the same thing for now. That is honest rather
than ideal: lazygit's `j`/`k` move by line because it has a line cursor and
githunk does not. Giving the main pane a line-granular cursor is follow-on work,
not part of this plan; do not invent one here.

- [ ] **Step 1: Write the failing tests**

Append to `tests/ui/dispatch.integration.test.ts`:

```ts
describe("navigation keys", () => {
  let harness: ShellHarness | undefined
  afterEach(async () => { await harness?.cleanup() })

  test("J and K scroll the main pane while a left pane keeps focus", async () => {
    harness = await createShellHarness({ height: 20 })
    const view = harness.app.view!

    await harness.pressKey("2")
    await harness.pressKey("J")
    expect(view.focusManager.active).toBe("files")
    expect(view.mainScrollY).toBeGreaterThan(0)
    await harness.pressKey("K")
    expect(view.mainScrollY).toBe(0)
  })

  test("H and L scroll the main pane horizontally", async () => {
    harness = await createShellHarness()
    const view = harness.app.view!

    await harness.pressKey("2")
    await harness.pressKey("L")
    expect(view.mainScrollX).toBeGreaterThan(0)
    await harness.pressKey("H")
    expect(view.mainScrollX).toBe(0)
  })

  test("angle brackets jump a list to its ends", async () => {
    harness = await createShellHarness({ commits: ["alpha", "beta", "gamma", "delta"] })

    await harness.pressKey("4")
    await harness.pressKey(">")
    expect(harness.frame()).toContain("alpha")
    await harness.pressKey("<")
    expect(harness.frame()).toContain("delta")
  })

  test("comma and period page a list", async () => {
    harness = await createShellHarness({ commits: ["c1", "c2", "c3", "c4", "c5", "c6"], height: 24 })
    const view = harness.app.view!

    await harness.pressKey("4")
    const before = view.commitsCursorIndex
    await harness.pressKey(".")
    expect(view.commitsCursorIndex).toBeGreaterThan(before + 1)
  })

  test("h and l move between hunks inside the main pane without moving focus", async () => {
    harness = await createShellHarness()
    const view = harness.app.view!

    await harness.pressKey("2")
    await harness.pressKey("ENTER")
    expect(view.focusManager.active).toBe("main")
    const before = getMainCursorTarget(view.mainPane)
    await harness.pressKey("l")
    expect(view.focusManager.active).toBe("main")
    expect(getMainCursorTarget(view.mainPane)).not.toEqual(before)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test tests/ui/dispatch.integration.test.ts -t "navigation keys"`
Expected: FAIL — `view.mainScrollY` is undefined and the keys do nothing.

- [ ] **Step 3: Add the scroll and cursor-index accessors**

Append to `src/ui/panes/main-pane.ts`:

```ts
/** Scrolls the main pane's text viewport, clamped to its content. */
export function scrollMainPane(pane: PaneHandle, axis: "x" | "y", delta: number): void {
  if (axis === "y") {
    pane.text.scrollY = Math.max(0, Math.min(pane.text.maxScrollY, pane.text.scrollY + delta))
    return
  }
  pane.text.scrollX = Math.max(0, Math.min(pane.text.maxScrollX, pane.text.scrollX + delta))
}
```

Append to `src/ui/panes/commits-pane.ts`, so the paging test does not reach into
the module's `WeakMap`:

```ts
export function commitsCursorIndex(pane: PaneHandle): number {
  return cursors.get(pane) ?? 0
}
```

- [ ] **Step 4: Implement the navigation actions**

In `src/ui/root-view.ts`, expose the two scroll positions for the tests and
replace the placeholder cases:

```ts
  get mainScrollY(): number { return this.panes.main.text.scrollY }
  get mainScrollX(): number { return this.panes.main.text.scrollX }
```

```ts
      case "main-scroll-down": scrollMainPane(this.panes.main, "y", 1); this.root.requestRender(); return
      case "main-scroll-up": scrollMainPane(this.panes.main, "y", -1); this.root.requestRender(); return
      case "main-scroll-right": scrollMainPane(this.panes.main, "x", 4); this.root.requestRender(); return
      case "main-scroll-left": scrollMainPane(this.panes.main, "x", -4); this.root.requestRender(); return
      case "main-half-page-down": scrollMainPane(this.panes.main, "y", this.mainPageStep()); this.root.requestRender(); return
      case "main-half-page-up": scrollMainPane(this.panes.main, "y", -this.mainPageStep()); this.root.requestRender(); return
      case "page-next": this.actionPage("next"); return
      case "page-previous": this.actionPage("previous"); return
      case "goto-top": this.actionJump("top"); return
      case "goto-bottom": this.actionJump("bottom"); return
      case "hunk-next": this.actionMoveHunk("next"); return
      case "hunk-previous": this.actionMoveHunk("previous"); return
      // j/k in the main pane already route to actionMoveCursor, which moves by
      // hunk, so these two share its implementation.
```

with these methods:

```ts
  /** Half the main pane's visible rows, at least one. */
  private mainPageStep(): number {
    return Math.max(1, Math.floor(heightOf(this.geometry.windows.main) / 2))
  }

  /** The visible rows of the focused pane, at least one, used as the page step. */
  private focusedPageStep(): number {
    const focus = this.focusManager.active
    const dimensions = focus === "command-log"
      ? this.geometry.windows.log
      : this.geometry.windows[focus as SideWindow] ?? this.geometry.windows.main
    return Math.max(1, heightOf(dimensions) - 2)
  }

  private actionPage(direction: "next" | "previous"): void {
    const step = this.focusedPageStep()
    for (let moved = 0; moved < step; moved += 1) this.actionMoveCursor(direction)
  }

  private actionJump(edge: "top" | "bottom"): void {
    // Lists are short enough that repeating the single-step move is simpler
    // and cannot disagree with it about clamping or selection side effects.
    const direction = edge === "bottom" ? "next" : "previous"
    const limit = Math.max(
      this.model.files.length,
      (this.model.commits ?? []).length,
      (this.model.stashes ?? []).length,
      branchPaneItems(this.model, this.branchFilter).length,
    ) + 1
    for (let moved = 0; moved < limit; moved += 1) this.actionMoveCursor(direction)
  }

  private actionMoveHunk(direction: "next" | "previous"): void {
    const document = getMainDocument(this.panes.main)
    if (document === undefined) return
    const target = moveMainCursor(document, getMainCursorTarget(this.panes.main), direction)
    if (target !== undefined) setMainCursorTarget(this.panes.main, target)
    this.root.requestRender()
  }
```

`actionMoveCursor` already dispatches on the focused pane, so paging and jumping
reuse it rather than duplicating each pane's clamping. Also add
`get commitsCursorIndex(): number` returning the commits pane cursor, which the
paging test reads; it reads the `commitsCursorIndex` accessor added in Step 3. Also expose
`get mainPane(): PaneHandle { return this.panes.main }` so the hunk test can
read the cursor target.

- [ ] **Step 5: Run the tests**

Run: `bun test tests/ui/dispatch.integration.test.ts`
Expected: PASS — every describe block, including the earlier ones.

Run: `bun run check`
Expected: typecheck clean, all tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/ui/root-view.ts src/ui/panes/main-pane.ts src/ui/panes/commits-pane.ts tests/ui/dispatch.integration.test.ts
git commit -m "feat: complete the lazygit navigation keys

Adds paging, jump-to-ends, main-pane vertical and horizontal scrolling
from any pane, half-page scrolling, and h/l hunk navigation inside the
main pane."
```

---

## Task 9: Divider affordance and persisted geometry

**Files:**
- Create: `src/ui/splitter.ts`
- Create: `src/storage/local-state-file.ts`
- Create: `src/ui/ui-state-store.ts`
- Create: `tests/ui/splitter.test.ts`
- Create: `tests/storage/local-state-file.integration.test.ts`
- Create: `tests/ui/ui-state-store.integration.test.ts`
- Modify: `src/review/store.ts`
- Modify: `src/app/create-app.ts`
- Modify: `src/ui/root-view.ts`
- Modify: `tests/helpers/shell-harness.ts`

**Interfaces:**
- Consumes: `GitRunner` from `src/git/runner.ts`; `ratioForMouseX`, `logHeightForMouseY`, `DEFAULT_SIDE_PANEL_RATIO`, `DEFAULT_LOG_HEIGHT` from `src/ui/layout.ts`.
- Produces:
  ```ts
  // src/ui/splitter.ts
  export type SplitterAxis = "vertical" | "horizontal"
  export function splitterGlyphs(axis: SplitterAxis, width: number, height: number, hovered: boolean): string
  export type SplitterHandle = {
    readonly box: BoxRenderable
    setHovered(hovered: boolean): void
    render(width: number, height: number): void
  }
  export function createSplitter(renderer: CliRenderer, axis: SplitterAxis, id: string): SplitterHandle

  // src/storage/local-state-file.ts
  export type LocalStateFileOptions = { readonly runner: GitRunner; readonly relativePath: string }
  export class LocalStateFile {
    constructor(options: LocalStateFileOptions)
    get path(): string
    resolvePath(): Promise<string>
    readText(): Promise<string | undefined>
    writeText(text: string): Promise<void>
    quarantine(): Promise<string>
  }

  // src/ui/ui-state-store.ts
  export type UiState = {
    readonly sidePanelRatio: number
    readonly commandLogHeight: number
    readonly commandLogVisible: boolean
  }
  export function defaultUiState(): UiState
  export class UiStateStore {
    constructor(runner: GitRunner)
    load(): Promise<UiState>
    save(state: UiState): Promise<void>
  }
  ```
  Note the name clash: `bindings.ts` also exports a `UiState`. Import the
  persisted one as `import { type UiState as PersistedUiState } from "./ui-state-store"`
  wherever both are in scope.

- [ ] **Step 1: Write the failing splitter test**

Create `tests/ui/splitter.test.ts`:

```ts
import { describe, expect, test } from "bun:test"
import { splitterGlyphs } from "../../src/ui/splitter"

describe("splitterGlyphs", () => {
  test("draws a vertical rule, one glyph per row", () => {
    expect(splitterGlyphs("vertical", 1, 4, false)).toBe("│\n│\n│\n│")
  })

  test("draws a horizontal rule across the width", () => {
    expect(splitterGlyphs("horizontal", 5, 1, false)).toBe("─────")
  })

  test("marks the midpoint with a grab glyph while hovered", () => {
    expect(splitterGlyphs("vertical", 1, 5, true)).toBe("│\n│\n⇔\n│\n│")
    expect(splitterGlyphs("horizontal", 5, 1, true)).toBe("──⇕──")
  })

  test("degrades to a single glyph at minimum extents", () => {
    expect(splitterGlyphs("vertical", 1, 1, false)).toBe("│")
    expect(splitterGlyphs("vertical", 1, 1, true)).toBe("⇔")
  })

  test("renders nothing for a zero extent", () => {
    expect(splitterGlyphs("vertical", 1, 0, false)).toBe("")
    expect(splitterGlyphs("horizontal", 0, 1, false)).toBe("")
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test tests/ui/splitter.test.ts`
Expected: FAIL — `Cannot find module '../../src/ui/splitter'`.

- [ ] **Step 3: Implement the splitter**

Create `src/ui/splitter.ts`:

```ts
import { BoxRenderable, TextRenderable, type CliRenderer } from "@opentui/core"

const IDLE_COLOR = "#555555"
const HOVER_COLOR = "#ffffff"
const VERTICAL_RULE = "│"
const HORIZONTAL_RULE = "─"
const VERTICAL_GRAB = "⇔"
const HORIZONTAL_GRAB = "⇕"

export type SplitterAxis = "vertical" | "horizontal"

/**
 * A rule in the frame colour rather than a filled block: a solid block reads as
 * a scrollbar. The grab glyph appears only on hover, which is what tells the
 * user the rule can be dragged.
 */
export function splitterGlyphs(axis: SplitterAxis, width: number, height: number, hovered: boolean): string {
  if (axis === "vertical") {
    if (height <= 0 || width <= 0) return ""
    const midpoint = Math.floor(height / 2)
    return Array.from({ length: height }, (_value, row) =>
      hovered && row === midpoint ? VERTICAL_GRAB : VERTICAL_RULE).join("\n")
  }
  if (width <= 0 || height <= 0) return ""
  const midpoint = Math.floor(width / 2)
  return Array.from({ length: width }, (_value, column) =>
    hovered && column === midpoint ? HORIZONTAL_GRAB : HORIZONTAL_RULE).join("")
}

export type SplitterHandle = {
  readonly box: BoxRenderable
  setHovered(hovered: boolean): void
  render(width: number, height: number): void
}

export function createSplitter(renderer: CliRenderer, axis: SplitterAxis, id: string): SplitterHandle {
  const box = new BoxRenderable(renderer, {
    id,
    position: "absolute",
    width: axis === "vertical" ? 1 : "100%",
    height: axis === "vertical" ? "100%" : 1,
  })
  const text = new TextRenderable(renderer, {
    id: `${id}-glyphs`,
    content: "",
    selectable: false,
    wrapMode: "none",
    width: "100%",
    height: "100%",
    fg: IDLE_COLOR,
  })
  box.add(text)
  // A drag must never begin a text selection, and a selection must never drag.
  box.selectable = false
  text.selectable = false

  let hovered = false
  let lastWidth = 1
  let lastHeight = 1

  return {
    box,
    setHovered(next: boolean) {
      if (next === hovered) return
      hovered = next
      text.fg = hovered ? HOVER_COLOR : IDLE_COLOR
      text.content = splitterGlyphs(axis, lastWidth, lastHeight, hovered)
      box.requestRender()
    },
    render(width: number, height: number) {
      lastWidth = width
      lastHeight = height
      text.content = splitterGlyphs(axis, width, height, hovered)
    },
  }
}
```

- [ ] **Step 4: Write the failing storage tests**

Create `tests/storage/local-state-file.integration.test.ts`:

```ts
import { afterEach, describe, expect, test } from "bun:test"
import { stat } from "node:fs/promises"
import { createTempRepository, type TempRepository } from "../helpers/temp-repository"
import { GitRunner } from "../../src/git/runner"
import { LocalStateFile } from "../../src/storage/local-state-file"

describe("LocalStateFile", () => {
  let repository: TempRepository | undefined
  afterEach(async () => { await repository?.cleanup() })

  test("returns undefined for a file that does not exist", async () => {
    repository = await createTempRepository()
    const file = new LocalStateFile({ runner: new GitRunner(repository.path), relativePath: "githunk/example-v1.json" })
    expect(await file.readText()).toBeUndefined()
  })

  test("writes atomically with owner-only permissions and reads back", async () => {
    repository = await createTempRepository()
    const file = new LocalStateFile({ runner: new GitRunner(repository.path), relativePath: "githunk/example-v1.json" })
    await file.writeText('{"a":1}')
    expect(await file.readText()).toBe('{"a":1}')
    const path = await file.resolvePath()
    expect(path).toContain(".git")
    expect((await stat(path)).mode & 0o777).toBe(0o600)
  })

  test("quarantines an unreadable file under a corrupt name", async () => {
    repository = await createTempRepository()
    const file = new LocalStateFile({ runner: new GitRunner(repository.path), relativePath: "githunk/example-v1.json" })
    await file.writeText("not json")
    const quarantined = await file.quarantine()
    expect(quarantined).toContain(".corrupt-")
    expect(await file.readText()).toBeUndefined()
  })
})
```

Create `tests/ui/ui-state-store.integration.test.ts`:

```ts
import { afterEach, describe, expect, test } from "bun:test"
import { createTempRepository, type TempRepository } from "../helpers/temp-repository"
import { GitRunner } from "../../src/git/runner"
import { UiStateStore, defaultUiState } from "../../src/ui/ui-state-store"

describe("UiStateStore", () => {
  let repository: TempRepository | undefined
  afterEach(async () => { await repository?.cleanup() })

  test("returns defaults when nothing has been saved", async () => {
    repository = await createTempRepository()
    const store = new UiStateStore(new GitRunner(repository.path))
    expect(await store.load()).toEqual(defaultUiState())
  })

  test("round-trips the geometry a drag produced", async () => {
    repository = await createTempRepository()
    const store = new UiStateStore(new GitRunner(repository.path))
    await store.save({ sidePanelRatio: 0.42, commandLogHeight: 11, commandLogVisible: true })
    expect(await store.load()).toEqual({ sidePanelRatio: 0.42, commandLogHeight: 11, commandLogVisible: true })
  })

  test("falls back to defaults rather than throwing on a corrupt file", async () => {
    repository = await createTempRepository()
    const runner = new GitRunner(repository.path)
    const store = new UiStateStore(runner)
    await store.save({ sidePanelRatio: 0.42, commandLogHeight: 11, commandLogVisible: true })
    await Bun.write(await new UiStateStore(runner).path(), "{ this is not json")
    expect(await store.load()).toEqual(defaultUiState())
  })

  test("rejects out-of-range values rather than trusting the file", async () => {
    repository = await createTempRepository()
    const runner = new GitRunner(repository.path)
    const store = new UiStateStore(runner)
    await Bun.write(await store.path(), JSON.stringify({ version: 1, sidePanelRatio: 9, commandLogHeight: -4, commandLogVisible: "yes" }))
    expect(await store.load()).toEqual(defaultUiState())
  })
})
```

`UiStateStore` therefore also exposes `path(): Promise<string>`, which the last
two cases use; add it to the interface block above when implementing.

- [ ] **Step 5: Run the storage tests to verify they fail**

Run: `bun test tests/storage/local-state-file.integration.test.ts tests/ui/ui-state-store.integration.test.ts`
Expected: FAIL — neither module exists.

- [ ] **Step 6: Extract the file helper out of the review store**

Create `src/storage/local-state-file.ts` by moving, unchanged in behaviour,
`assertNoSymlinkInPath`, `resolvePath`, and the body of `ReviewStore.save` from
`src/review/store.ts:35-47`, `:119-133` and `:91-117`:

```ts
import { mkdir, open, rename, stat, unlink, lstat } from "node:fs/promises"
import { dirname, isAbsolute, join, resolve } from "node:path"
import { randomUUID } from "node:crypto"
import type { GitRunner } from "../git/runner"

export type LocalStateFileOptions = {
  readonly runner: GitRunner
  /** Path relative to the git directory, e.g. "githunk/ui-state-v1.json". */
  readonly relativePath: string
}

async function assertNoSymlinkInPath(path: string): Promise<void> {
  const absolute = resolve(path)
  const segments = absolute.split("/").filter(Boolean)
  let current = absolute.startsWith("/") ? "/" : ""
  for (const segment of segments) {
    current = current === "/" ? `/${segment}` : `${current}/${segment}`
    try {
      if ((await lstat(current)).isSymbolicLink()) throw new Error(`refusing symlinked state path component: ${current}`)
    } catch (error) {
      if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") break
      throw error
    }
  }
}

export class LocalStateFile {
  private readonly runner: GitRunner
  private readonly relativePath: string
  private resolvedPath: string | undefined

  constructor(options: LocalStateFileOptions) {
    this.runner = options.runner
    this.relativePath = options.relativePath
  }

  get path(): string {
    return this.resolvedPath ?? join(this.runner.cwd, ".git", this.relativePath)
  }

  async resolvePath(): Promise<string> {
    if (this.resolvedPath !== undefined) return this.resolvedPath
    const output = (await this.runner.run(["rev-parse", "--git-path", this.relativePath], { readOnly: true })).stdout.trim()
    if (output.length === 0) throw new Error(`git returned an empty path for ${this.relativePath}`)
    this.resolvedPath = isAbsolute(output) ? output : join(this.runner.cwd, output)
    return this.resolvedPath
  }

  async readText(): Promise<string | undefined> {
    const path = await this.resolvePath()
    await assertNoSymlinkInPath(path)
    try {
      return await Bun.file(path).text()
    } catch (error) {
      if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") return undefined
      throw error
    }
  }

  async writeText(text: string): Promise<void> {
    const path = await this.resolvePath()
    await assertNoSymlinkInPath(path)
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`
    await assertNoSymlinkInPath(temporary)
    const handle = await open(temporary, "wx", 0o600)
    try {
      await handle.writeFile(text, "utf8")
      await handle.chmod(0o600)
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(temporary, path)
    try {
      const directory = await open(dirname(path), "r")
      try { await directory.sync() } finally { await directory.close() }
    } catch {
      // Directory fsync is not available on every supported filesystem.
    }
    const mode = (await stat(path)).mode & 0o777
    if (mode !== 0o600) {
      const fix = await open(path, "r+")
      try { await fix.chmod(0o600); await fix.sync() } finally { await fix.close() }
    }
    await unlink(temporary).catch(() => undefined)
  }

  async quarantine(): Promise<string> {
    const path = await this.resolvePath()
    const corruptPath = `${path}.corrupt-${Date.now()}`
    await rename(path, corruptPath)
    return corruptPath
  }
}
```

Then rewrite `src/review/store.ts` to delegate: replace its private
`resolvePath`, its `assertNoSymlinkInPath` calls and its `save` body with a
`LocalStateFile` field, keeping `isDatabase`, the corrupt-file warning text
(`Review state was corrupt; moved to ${corruptPath}`) and the public API
unchanged. `tests/review/store.test.ts` must pass untouched; that is the check
that the extraction changed no behaviour.

- [ ] **Step 7: Implement the UI state store**

Create `src/ui/ui-state-store.ts`:

```ts
import type { GitRunner } from "../git/runner"
import { LocalStateFile } from "../storage/local-state-file"
import { DEFAULT_LOG_HEIGHT, DEFAULT_SIDE_PANEL_RATIO, MIN_LOG_HEIGHT } from "./layout"

const RELATIVE_PATH = "githunk/ui-state-v1.json"

export type UiState = {
  readonly sidePanelRatio: number
  readonly commandLogHeight: number
  readonly commandLogVisible: boolean
}

export function defaultUiState(): UiState {
  return {
    sidePanelRatio: DEFAULT_SIDE_PANEL_RATIO,
    commandLogHeight: DEFAULT_LOG_HEIGHT,
    commandLogVisible: false,
  }
}

function isUiState(value: unknown): value is UiState & { readonly version: 1 } {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false
  const candidate = value as Record<string, unknown>
  return candidate.version === 1 &&
    typeof candidate.sidePanelRatio === "number" &&
    Number.isFinite(candidate.sidePanelRatio) &&
    candidate.sidePanelRatio > 0 && candidate.sidePanelRatio < 1 &&
    typeof candidate.commandLogHeight === "number" &&
    Number.isInteger(candidate.commandLogHeight) &&
    candidate.commandLogHeight >= MIN_LOG_HEIGHT &&
    typeof candidate.commandLogVisible === "boolean"
}

export class UiStateStore {
  private readonly file: LocalStateFile

  constructor(runner: GitRunner) {
    this.file = new LocalStateFile({ runner, relativePath: RELATIVE_PATH })
  }

  path(): Promise<string> {
    return this.file.resolvePath()
  }

  async load(): Promise<UiState> {
    let text: string | undefined
    try {
      text = await this.file.readText()
    } catch {
      return defaultUiState()
    }
    if (text === undefined) return defaultUiState()
    try {
      const parsed: unknown = JSON.parse(text)
      if (!isUiState(parsed)) return defaultUiState()
      return {
        sidePanelRatio: parsed.sidePanelRatio,
        commandLogHeight: parsed.commandLogHeight,
        commandLogVisible: parsed.commandLogVisible,
      }
    } catch {
      return defaultUiState()
    }
  }

  /** Geometry is a convenience, never correctness: a failed write is swallowed. */
  async save(state: UiState): Promise<void> {
    try {
      await this.file.writeText(`${JSON.stringify({ version: 1, ...state })}\n`)
    } catch {
      // Losing a remembered pane width must never interrupt a review.
    }
  }
}
```

- [ ] **Step 8: Run the storage tests to verify they pass**

Run: `bun test tests/storage/local-state-file.integration.test.ts tests/ui/ui-state-store.integration.test.ts tests/review/store.test.ts`
Expected: PASS, including the untouched review-store tests.

- [ ] **Step 9: Write the failing divider integration tests**

First extend the harness so a second shell can open the same repository. In
`tests/helpers/shell-harness.ts`, add to `ShellHarnessOptions`:

```ts
  /** Reuse an existing repository, e.g. to test that geometry survives a restart. */
  readonly repository?: TempRepository
```

and at the top of `createShellHarness`:

```ts
  const reused = options.repository !== undefined
  const repository = options.repository ?? await createTempRepository()
```

skipping the commit and stash setup when `reused` is true, and in `cleanup`
skipping `repository.cleanup()` when `reused` is true so the owner cleans up.

Append to `tests/ui/dispatch.integration.test.ts`:

```ts
describe("dividers", () => {
  let harness: ShellHarness | undefined
  afterEach(async () => { await harness?.cleanup() })

  test("dragging the vertical divider changes the side width", async () => {
    harness = await createShellHarness({ width: 160, height: 40 })
    const view = harness.app.view!
    const before = view.geometry.sideWidth

    await harness.drag(before, 10, 90, 10)
    expect(view.geometry.sideWidth).toBeGreaterThan(before)
    expect(view.geometry.sideWidth).toBeLessThanOrEqual(160 - 1 - 40)
  })

  test("the drag is clamped to the main pane's minimum width", async () => {
    harness = await createShellHarness({ width: 160, height: 40 })
    const view = harness.app.view!

    await harness.drag(view.geometry.sideWidth, 10, 159, 10)
    expect(view.geometry.windows.main).toBeDefined()
    const main = view.geometry.windows.main!
    expect(main.x1 - main.x0 + 1).toBe(40)
  })

  test("the dragged width survives a restart in the same repository", async () => {
    const first = await createShellHarness({ width: 160, height: 40 })
    const ratioBefore = first.app.view!.geometry.sidePanelRatio
    await first.drag(first.app.view!.geometry.sideWidth, 10, 90, 10)
    const ratioAfter = first.app.view!.geometry.sidePanelRatio
    expect(ratioAfter).not.toBe(ratioBefore)
    await first.app.saveUiState()
    first.app.destroy()

    harness = await createShellHarness({ width: 160, height: 40, repository: first.repository })
    expect(harness.app.view!.geometry.sidePanelRatio).toBeCloseTo(ratioAfter, 3)
    await first.repository.cleanup()
  })
})
```

- [ ] **Step 10: Run the tests to verify they fail**

Run: `bun test tests/ui/dispatch.integration.test.ts -t "dividers"`
Expected: FAIL — `app.saveUiState` does not exist and the ratio is not restored.

- [ ] **Step 11: Replace the splitter renderables and load persisted geometry**

In `src/ui/root-view.ts`:

- Replace the two `new BoxRenderable(...)` splitter constructions with
  `createSplitter(renderer, "vertical", "vertical-splitter")` and
  `createSplitter(renderer, "horizontal", "horizontal-splitter")`, and change the
  two fields to `SplitterHandle`. Every `this.verticalSplitter.<x>` becomes
  `this.verticalSplitter.box.<x>`.
- In `applyLayout`, after placing each splitter, draw its glyphs:
  ```ts
    const vsplit = windows.vsplit
    if (vsplit !== undefined) this.verticalSplitter.render(widthOf(vsplit), heightOf(vsplit))
    const hsplit = windows.hsplit
    if (hsplit !== undefined) this.horizontalSplitter.render(widthOf(hsplit), heightOf(hsplit))
  ```
- Add hover and double-click handlers in `installMouseHandlers`. OpenTUI's
  `MouseEvent` (`node_modules/@opentui/core/renderer.d.ts:144`) carries
  `type`, `button`, `x`, `y`, `modifiers`, `scroll`, `target` and `isDragging`
  — **there is no click count and no double-click event type** — so track it in
  the view:
  ```ts
  const DOUBLE_CLICK_MS = 400

  // in installMouseHandlers
    for (const [splitter, axis] of [[this.verticalSplitter, "vertical"], [this.horizontalSplitter, "horizontal"]] as const) {
      splitter.box.onMouseOver = () => splitter.setHovered(true)
      splitter.box.onMouseOut = () => splitter.setHovered(false)
      splitter.box.onMouseDown = (event: MouseEvent) => {
        const previous = this.lastSplitterPress
        const now = Date.now()
        this.lastSplitterPress = { axis, x: event.x, y: event.y, at: now }
        const isDoubleClick = previous !== undefined &&
          previous.axis === axis &&
          now - previous.at <= DOUBLE_CLICK_MS &&
          Math.abs(previous.x - event.x) <= 1 &&
          Math.abs(previous.y - event.y) <= 1
        if (!isDoubleClick) return
        this.lastSplitterPress = undefined
        if (axis === "vertical") this.toggleSideCollapsed()
        else this.toggleCommandLog()
      }
    }
  ```
  with the field:
  ```ts
    private lastSplitterPress: { readonly axis: "vertical" | "horizontal"; readonly x: number; readonly y: number; readonly at: number } | undefined
  ```
  A drag clears it (`onMouseDrag` sets `this.lastSplitterPress = undefined`), so
  dragging and releasing twice in quick succession does not read as a
  double click.
- Implement the two double-click behaviours, exactly as spec §8 defines them:
  ```ts
    /** Collapse the left region and focus main; a second double click restores both. */
    private toggleSideCollapsed(): void {
      if (this.screenMode === "full" && this.focusManager.active === "main") {
        this.screenMode = "normal"
        if (this.focusBeforeCollapse !== undefined) this.focusManager.focus(this.focusBeforeCollapse)
        this.focusBeforeCollapse = undefined
        return
      }
      this.focusBeforeCollapse = this.focusManager.active
      this.screenMode = "full"
      this.focusManager.focus("main")
    }

    private toggleCommandLog(): void {
      this.focusManager.handleKey("@")
    }
  ```
  `focusManager.focus` already triggers `onChange`, which recomputes the layout;
  add an explicit `this.recomputeLayout()` to the branch that does not change
  focus.
- Add the store and the persisted geometry. `RootViewOptions` gains
  `readonly onGeometryChange?: (state: PersistedUiState) => void`, called from
  the two drag handlers and from `toggleCommandLog`:
  ```ts
    private notifyGeometry(): void {
      this.onGeometryChange?.({
        sidePanelRatio: this.sidePanelRatio,
        commandLogHeight: this.logHeight,
        commandLogVisible: this.focusManager.logVisible,
      })
    }
  ```

- [ ] **Step 12: Load and save the geometry in the wiring**

In `src/app/create-app.ts`:

- Construct `const uiStateStore = new UiStateStore(options.runner)`.
- Keep the latest geometry in a mutable local, updated by `onGeometryChange`.
- Add `saveUiState(): Promise<void>` to the `App` type, writing that geometry
  through the store.
- In `refresh()`, on the first call only, load the persisted state and apply it
  to the view before updating:
  ```ts
    const persisted = await uiStateStore.load()
    view.applyPersistedGeometry(persisted)
  ```
  `RootView.applyPersistedGeometry(state)` sets `sidePanelRatio`, `logHeight`
  and `focusManager.logVisible`, then calls `recomputeLayout()`.
- Call `saveUiState()` from `destroy()`, ignoring rejection — geometry is a
  convenience.

- [ ] **Step 13: Run the tests**

Run: `bun test tests/ui/splitter.test.ts tests/ui/dispatch.integration.test.ts`
Expected: PASS.

Run: `bun run check`
Expected: typecheck clean, all tests pass.

- [ ] **Step 14: Verify by hand**

Run: `bun run start`
Expected: the divider between the regions is a thin rule in the frame colour,
not a solid block. Hovering it brightens it and shows `⇔` at its midpoint.
Dragging it resizes both regions live. Double-clicking it hides the left region;
double-clicking again restores it. Quit with `q`, restart, and the dragged width
is still there. Confirm `.git/githunk/ui-state-v1.json` exists and that
`git status` reports a clean tree.

- [ ] **Step 15: Commit**

```bash
git add src/ui/splitter.ts src/storage/local-state-file.ts src/ui/ui-state-store.ts src/review/store.ts src/ui/root-view.ts src/app/create-app.ts tests/ui/splitter.test.ts tests/storage/local-state-file.integration.test.ts tests/ui/ui-state-store.integration.test.ts tests/ui/dispatch.integration.test.ts tests/helpers/shell-harness.ts
git commit -m "feat: make the dividers legible, draggable and remembered

The solid block that read as a scrollbar becomes a thin rule that
brightens and shows a grab glyph on hover, drags to resize either region,
and collapses on a double click. Pane geometry persists to
.git/githunk/ui-state-v1.json through a file helper extracted from the
review store, so the atomic-write and symlink-refusal logic exists once."
```

---

## Task 10: The end-to-end regression gate

A single suite that asserts the symptoms originally reported, so each one fails
in CI if it returns. It deliberately restates a few things
`tests/ui/dispatch.integration.test.ts` covers: this file is the gate against
the reported bugs, and reading it should show what "fixed" means without
tracing unit tests.

**Files:**
- Create: `tests/ui/acceptance/shell.integration.test.ts`
- Modify: `docs/lazygit-compatibility-v0.1.md`
- Modify: `docs/release-checklist-v0.1.md`

- [ ] **Step 1: Write the acceptance suite**

Create `tests/ui/acceptance/shell.integration.test.ts`:

```ts
import { afterEach, describe, expect, test } from "bun:test"
import { createShellHarness, type ShellHarness } from "../../helpers/shell-harness"
import { FOLDED_PANE_HEIGHT, MIN_LEFT_WIDTH } from "../../../src/ui/layout"

describe("review shell acceptance", () => {
  let harness: ShellHarness | undefined
  afterEach(async () => { await harness?.cleanup() })

  test("the commits pane lists the branch's commits", async () => {
    harness = await createShellHarness({ commits: ["oldest work", "middle work", "newest work"] })
    await harness.pressKey("4")
    const frame = harness.frame()
    expect(frame).toContain("newest work")
    expect(frame).toContain("oldest work")
    expect(frame).not.toContain("No commits")
  })

  test("the bottom row always says which keys the focused pane accepts", async () => {
    harness = await createShellHarness()
    for (const [key, expected] of [["2", "stage: space"], ["3", "checkout: space"], ["5", "apply: space"]] as const) {
      await harness.pressKey(key)
      expect(harness.frame()).toContain(expected)
    }
  })

  test("the side region scales with the terminal instead of staying at thirty columns", async () => {
    harness = await createShellHarness({ width: 240, height: 40 })
    expect(harness.app.view!.geometry.sideWidth).toBeGreaterThan(60)
    await harness.resize(80, 40)
    expect(harness.app.view!.geometry.sideWidth).toBeGreaterThanOrEqual(MIN_LEFT_WIDTH)
    expect(harness.app.view!.geometry.sideWidth).toBeLessThan(60)
  })

  test("the stash pane stays folded until it is focused", async () => {
    harness = await createShellHarness({ stash: true, height: 40 })
    await harness.pressKey("2")
    const folded = harness.app.view!.geometry.windows.stash!
    expect(folded.y1 - folded.y0 + 1).toBe(FOLDED_PANE_HEIGHT)
    await harness.pressKey("5")
    const expanded = harness.app.view!.geometry.windows.stash!
    expect(expanded.y1 - expanded.y0 + 1).toBeGreaterThan(FOLDED_PANE_HEIGHT)
  })

  test("hjkl navigates: h and l between panes, j and k within one", async () => {
    harness = await createShellHarness({ commits: ["alpha", "beta", "gamma"] })
    const view = harness.app.view!
    await harness.pressKey("2")
    await harness.pressKey("l")
    await harness.pressKey("l")
    expect(view.focusManager.active).toBe("commits")
    await harness.pressKey("j")
    expect(harness.frame()).toContain("beta")
    await harness.pressKey("h")
    expect(view.focusManager.active).toBe("branches")
  })

  test("both regions are adjustable: drag the divider, and zoom with plus", async () => {
    harness = await createShellHarness({ width: 160, height: 40 })
    const view = harness.app.view!

    const before = view.geometry.sideWidth
    await harness.drag(before, 10, 100, 10)
    expect(view.geometry.sideWidth).toBeGreaterThan(before)

    await harness.pressKey("0")
    await harness.pressKey("+")
    expect(view.geometry.sideWidth).toBe(0)
    await harness.pressKey("4")
    await harness.pressKey("+")
    expect(view.geometry.windows.main).toBeUndefined()
  })

  test("a resize never corrupts the layout", async () => {
    harness = await createShellHarness({ width: 200, height: 50 })
    for (const [width, height] of [[100, 30], [70, 20], [200, 50], [60, 14]] as const) {
      await harness.resize(width, height)
      const geometry = harness.app.view!.geometry
      expect(geometry.terminalWidth).toBe(width)
      expect(geometry.terminalHeight).toBe(height)
      for (const dimensions of Object.values(geometry.windows)) {
        expect(dimensions.x0).toBeGreaterThanOrEqual(0)
        expect(dimensions.y0).toBeGreaterThanOrEqual(0)
        expect(dimensions.x1).toBeLessThan(width)
        expect(dimensions.y1).toBeLessThan(height)
      }
    }
  })
})
```

- [ ] **Step 2: Run the suite**

Run: `bun test tests/ui/acceptance/shell.integration.test.ts`
Expected: PASS — all seven cases.

- [ ] **Step 3: Update the compatibility table**

In `docs/lazygit-compatibility-v0.1.md`, add rows for every binding introduced
in Task 4 (`h` `l` `tab` `shift+tab` `,` `.` `<` `>` `home` `end` `H` `L` `J`
`K` `ctrl+d` `ctrl+u` `pagedown` `pageup` `+` `_` `?` `[` `]`) with their
lazygit equivalents, and mark the `tab` to `[` / `]` scope move as a deliberate
divergence with its reason. Take the lazygit column from
`learn-projects/lazygit/pkg/config/user_config.go:1000-1075`.

- [ ] **Step 4: Update the release checklist**

In `docs/release-checklist-v0.1.md`, add the manual checks this work
introduces: the hints bar changes with focus, `?` opens and closes, the divider
shows its hover affordance and drags, double-click collapses and restores,
geometry survives a restart, `git status` stays clean with
`.git/githunk/ui-state-v1.json` present, and the Commits pane is populated on a
branch with commits.

- [ ] **Step 5: Run the full check**

Run: `bun run check`
Expected: typecheck clean, every test passes.

- [ ] **Step 6: Commit**

```bash
git add tests/ui/acceptance/shell.integration.test.ts docs/lazygit-compatibility-v0.1.md docs/release-checklist-v0.1.md
git commit -m "test: gate the review shell against the reported regressions

One suite asserts each symptom that prompted this work: an empty commits
pane, no keybinding hints, a fixed-width side region, a stash pane that
never folds, missing hjkl, and a right region that could not be adjusted."
```

---

## Task 11: Overflow scrollbars and keyboard auto-scroll

Owner request (2026-08-25): panes whose content overflows show a scrollbar, and keyboard
navigation keeps the selected line visible automatically — behavior every lazygit list has.

**OpenTUI ground truth (verified against node_modules/@opentui/core 0.5.6 source):**
- `TextBufferRenderable` (base of `TextRenderable`) exposes `scrollY/scrollX/maxScrollY/maxScrollX/scrollHeight`
  (`renderables/TextBufferRenderable.d.ts:59-66`); the `scrollY` setter clamps. No scrollTo/scrollBy.
- `ScrollBarRenderable` (`renderables/ScrollBar.d.ts`) draws track+thumb natively with
  `orientation`, `trackOptions: { backgroundColor, foregroundColor }` (defaults #252527/#9a9ea3),
  sub-cell thumb positioning, built-in auto-hide whenever `viewportSize >= scrollSize`
  (index.node.js ~13506), and its own mouse handling. Do NOT migrate panes to ScrollBoxRenderable.
- Nothing built-in keeps a selection visible on a bare TextRenderable; githunk must set `scrollY`
  itself. (command-log-pane.ts:73,77 already does this pattern for sticky-bottom.)
- Paint order: a child added after the pane's `text` draws above it; `overflow: hidden` scissors
  it to the pane. Place the bar at `top: 1, bottom: 1, right: 0` so it stays inside the border ring.
- Never read `width/height` synchronously after constructing/resizing (yoga layout is async);
  hook `onSizeChange` instead. Reading `text.scrollHeight` immediately after `pane.update()` is valid.

**Files:**
- Modify: `src/ui/panes/common.ts` — `createPane` attaches a vertical `ScrollBarRenderable`
  (width 1, absolute, top 1 / bottom 1 / right 0, default colors, no arrows) and `PaneHandle.update()`
  syncs `bar.scrollSize = text.scrollHeight`, `bar.viewportSize = text.height`,
  `bar.scrollPosition = text.scrollY` after setting content.
- Modify: `src/ui/panes/common.ts` — add and export the pure function
  `scrollYToReveal(firstVisibleLine: number, lastVisibleLine: number, viewportLines: number): number`
  returning the new scrollY that makes `[firstVisibleLine, lastVisibleLine]` visible with minimal
  movement, clamped to `[0, max]`. All panes use this one function; no per-pane clamping variants.
- Modify: `src/ui/panes/{files-pane,branches-pane,commits-pane,stash-pane}.ts` — after a cursor move,
  set `pane.text.scrollY = scrollYToReveal(cursorIndex, cursorIndex, visibleLines)` where
  `visibleLines` is the pane's inner height minus borders (read once per call from geometry-independent
  `text.height` is NOT reliable pre-layout; pass the value RootView already knows or derive from
  `Math.max(1, ...)` of the pane box height when available — implementer picks the reading that is
  correct under the timing pitfall above and documents it).
- Modify: `src/ui/root-view.ts` — nothing structural; only if a pane needs the arranged window
  height at cursor-move time, read it from `this.geometry.windows[name]`.

**Interfaces:**
```ts
// src/ui/panes/common.ts (additions)
export function scrollYToReveal(top: number, bottom: number, viewportLines: number): number
// PaneHandle gains nothing public beyond what createPane already returns; the bar is internal.
```

- [ ] **Step 1: Failing unit tests for scrollYToReveal**

Create `tests/ui/scroll-reveal.test.ts`: below viewport (top < scrollY) scrolls up to `top`;
above viewport scrolls down to `bottom - viewportLines + 1`; inside viewport returns current;
clamps at 0 and at max; single-line viewport edge cases.

- [ ] **Step 2: Failing integration tests**

Append to `tests/ui/dispatch.integration.test.ts`:

```ts
  test("moving down a long commit list scrolls the pane to keep the cursor visible", async () => {
    const subjects = Array.from({ length: 30 }, (_v, i) => `commit number ${String(i).padStart(2, "0")}`)
    harness = await createShellHarness({ commits: subjects, height: 24 })
    await harness.pressKey("4")
    expect(harness.frame()).toContain("commit number 00")
    for (let moved = 0; moved < 15; moved += 1) await harness.pressKey("j")
    const frame = harness.frame()
    expect(frame).toContain("commit number 15") // cursor row revealed
    expect(frame).toContain("commit number 02") // earliest rows scrolled away is fine; presence proves scroll
  })
```
Adjust the exact assertions to the pane's real inner height; the property under test is "the newly
selected row is on screen after the move", not specific line numbers.

- [ ] **Step 3: Implement per Files above; every pane gets the bar for free via createPane**

Command Log keeps its existing sticky-bottom behavior; its bar appears through the shared path.

- [ ] **Step 4: Main pane auto-scroll (attempt, bounded)**

`j/k`/hunk moves in main should reveal the cursor target's hunk. Derive the hunk's first rendered
line from the DiffDocument (files before it, their hunks, header/context lines) as a pure function
next to `changeLineIndexes`; reuse `scrollYToReveal`. If the derivation turns out ambiguous for
renames/binary sections, ship the lists-only scope and record exactly which cases stay unscrolled
rather than guessing.

- [ ] **Step 5: Verify and commit**

Run: `bun run check`; probe by hand (`bun run start`, resize terminal, navigate all panes).
Commit: `feat: overflow scrollbars and keyboard auto-scroll in every pane`

---

## Task 12: Stop repeating the commit subject under the commits pane

The commits pane's bottomTitle renders `${index + 1}/${count}: ${subject}` while the selected
row directly above already ends with the same subject — the title appears twice, stacked.
Lazygit renders nothing beneath a list; the cursor marks the selection. Owner request
(2026-08-25): drop the repetition entirely, counter included.

**Files:**

- Modify: `src/ui/panes/commits-pane.ts:47` (bottomTitle assignment)
- Test: `tests/ui/dispatch.integration.test.ts`

**Interfaces:** none change. `createPane(renderer, "commits", "4 Commits", "No commit selected")`
keeps its placeholder for the empty case; once commits exist the bottomTitle is cleared.

- [ ] **Step 1: Write the failing test**

Append to `tests/ui/dispatch.integration.test.ts` inside the existing describe:

```ts
  test("the commits pane does not echo the selected commit's subject beneath the list", async () => {
    harness = await createShellHarness({ commits: ["alpha commit", "beta commit", "gamma commit"] })

    await harness.pressKey("4")
    const frame = harness.frame()
    expect(frame).toContain("gamma commit") // the row itself stays
    expect(frame).not.toContain("1/3") // no counter/title strip below the border
    expect(frame).toContain("revision 2") // the preview from the commits-preview suite keeps passing
  })
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test tests/ui/dispatch.integration.test.ts -t "echo the selected"`
Expected: FAIL — `1/3` appears via the current bottomTitle.

- [ ] **Step 3: Implement**

Replace the bottomTitle assignment at `src/ui/panes/commits-pane.ts:47` with clearing it:

```ts
  // lazygit shows nothing beneath a list; the selected row already carries the subject.
  pane.box.bottomTitle = undefined
```

- [ ] **Step 4: Sweep for siblings, report only**

Grep `src/ui/panes/` for other bottomTitle assignments that embed a selected item's own label
(files pane path, stash ref, branch name). Do NOT change them; list them in the report so the
controller can rule whether they get the same treatment.

- [ ] **Step 5: Verify and commit**

Run: `bun run check`
Then commit: `fix: stop echoing the selected commit subject under the commits pane`
