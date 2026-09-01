# githunk Review Shell UX — Design

**Status:** Approved
**Date:** 2026-08-24
**Supersedes:** nothing. Extends `docs/githunk-prd-v0.1.md` (§5 Information Architecture, §7 Resizable Layout, §15 Lazygit Compatibility).
**Note (2026-08-27):** Branch Review portions of this shell design are **superseded** for the dedicated Review Workspace by `docs/superpowers/specs/2026-08-27-branch-review-workspace-design.md`. The shell's proportional layout, hints bar, screen modes, and draggable dividers remain, but the Branch Review UI contract (files pane markers, base...HEAD rendering, read-only guards) is now owned by the dedicated workspace. The `Branch Review is read-only` guard and old Branch Review mode rendering in Status/Files/Main/Commits panes are deleted.
**Reference implementation studied:** `learn-projects/lazygit` (submodule)

---

## 1. Why

v0.1 shipped the Git core and the review model, but the shell around them is
unusable in ways that compound:

1. **No keybinding discovery.** Nothing tells the user which keys the focused
   pane accepts. There is also no `?` menu.
2. **Incomplete navigation.** `j`/`k` exist; `h`/`l` do not. Neither do paging,
   jump-to-end, main-pane scrolling, or screen-mode keys.
3. **Commits pane is always empty**, even on a branch with 58 commits.
4. **Left region is a fixed 30 columns**, which is a third of a laptop terminal
   and a sixth of a wide one.
5. **All five left panes get equal height**, so Stash permanently occupies a
   fifth of the column to show zero or two entries.
6. **Only the left region is resizable**, and the divider that suggests
   resizing (a solid `#333333` block) reads as a scrollbar.

Items 1 and 2 share one root cause, items 4–6 share another. Section 3 names
both.

## 2. Scope

**In scope**

- Declarative keybinding registry; context-aware hints bar; `?` keybinding menu.
- lazygit-compatible navigation keys, including `h`/`l`.
- Proportional left-region width, accordion left stack, folded Stash pane.
- Three screen modes (`normal` / `half` / `full`) via `+` / `_`.
- Draggable dividers with hover affordance and double-click collapse.
- Persisted UI geometry.
- Fixing the empty Commits pane, and removing the wiring divergence that hid it.
- Test layers that would have caught the Commits bug.

**Out of scope**

- Keyboard range-select (`v`) in the main pane. Mouse selection stays the only
  multi-line selection mechanism this round.
- A user config file. Defaults live in code; only geometry is persisted.
- Anything in PRD §19–§22 (v0.2+ review enhancements, review intelligence).

## 3. Architecture: two new seams

### 3.1 The keybinding problem is a data-source problem

`src/ui/keymap.ts` declares roughly twenty bindings in `CORE_KEYMAP`, but
`src/ui/root-view.ts` independently handles about twenty-six keys through
hardcoded `key.name === "x"` comparisons spread across `handleFilterKey`,
`handleMutationKey`, and `handleCopyKey`. The bindings the user actually relies
on — `s` stash, `b`/`w` mode switch, `d` discard, `a` stage-all, `r` reviewed,
`n` new branch, `g` pop, `o` open — appear only in that second, unenumerable
set.

lazygit renders its bottom line by *reading its own binding declarations*
(`pkg/gui/options_map.go` filters `types.Binding` values by `DisplayOnScreen`).
A hints bar built on a hand-written string table would be a second source of
truth for the same facts, and would drift. A hints bar that lies is worse than
no hints bar.

So: **one declarative registry, three consumers** (dispatch, hints bar, `?`
menu).

### 3.2 The layout problem is a combinatorics problem

`computeLayout` is imperative arithmetic over fixed column counts. The states it
must now express are the product of: five left panes x which one is focused x
three screen modes x command-log visible/hidden x portrait/landscape x the
short-terminal fallbacks. Expressed as nested conditionals this is unreadable
and effectively untestable; lazygit extracted `boxlayout` for exactly this
reason.

So: **a pure box-layout engine, and a layout module whose only job is to build a
box tree.**

Both seams are pure functions with no I/O, testable in isolation. `root-view.ts`
shrinks correspondingly: it consumes the registry instead of judging keys, and
consumes arranged dimensions instead of computing them.

---

## 4. `src/ui/bindings.ts`

### 4.1 Shape

```ts
export type Binding = {
  readonly keys: readonly (string | KeyLike)[]  // keys[0] is what the hints bar shows
  readonly action: Action
  readonly description: string                  // hints bar: short ("stage", "reviewed")
  readonly menuDescription?: string             // ? menu: long; falls back to description
  readonly contexts?: readonly BindingContext[] // omitted means global
  readonly displayOnScreen?: boolean            // default false; true to reach the hints bar
  readonly available?: (model: AppModel, ui: UiState) => boolean
}
```

`UiState` is the transient view state the model does not hold: which pane has
focus, the current screen mode, whether a modal or confirmation is pending, and
the main pane's cursor and selection. It is owned by `root-view.ts` and passed
in, so `available` stays a pure predicate.

### 4.2 Consumers

| Consumer | Function | Behaviour |
| --- | --- | --- |
| Dispatch | `resolve(key, { context, modal })` | Keeps the existing modal > context > global precedence from `Keymap.resolve`. |
| Hints bar | `hintsFor(context, model, ui, width)` | Keeps bindings where `displayOnScreen` and `available`; renders `description: key`; joins with ` \| `; truncates with ` \| …` when the width is exceeded. Mirrors lazygit's `formatBindingInfos`. |
| `?` menu | `menuFor(context, model, ui)` | Groups current-context bindings first, then global bindings whose keys the context has not overridden. Uses `menuDescription`. |

### 4.3 Why `available` matters

Today `root-view.ts` scatters refusal messages (`"Branch Review is read-only"`,
`"Discard disabled for staged content"`, `"Line actions disabled in All scope"`)
across its key handlers. Modelling availability on the binding turns "can this
be pressed right now" into a property of the binding, which the hints bar reads
for free: in Branch Review, `space` / `d` / `a` simply do not appear rather than
appearing and then rejecting the keypress.

Refusal messages that explain *how to proceed* (for example "press Tab to choose
staged or unstaged") remain valuable and stay as `bottomTitle` feedback; the
`available` predicate governs hints-bar membership and menu greying, not the
removal of those messages.

### 4.4 Assertions

`assertNoKeyCollisions` is retained and extended. The registry must assert, at
construction time:

- No two bindings in one context normalize to the same keystroke (existing).
- Every binding has a non-empty `description`.
- Every binding's `action` has a registered handler.

These run in the constructor, so a mistake fails the test suite rather than
producing a silently dead key.

---

## 5. Keymap

### 5.1 One breaking change

`tab` currently toggles the main pane's staged/unstaged scope
(`root-view.ts:844`). lazygit's `tab` is next-block. The scope toggle moves to
**`[` / `]`**, which is lazygit's prev-tab / next-tab convention and the right
analogy: the main pane's all/staged/unstaged scope is the same idea as lazygit's
Files panel tabs. `tab` / `shift+tab` are freed for pane cycling.

This is the only existing githunk binding whose meaning changes.

### 5.2 Additions

| Keys | Action | Context | Notes |
| --- | --- | --- | --- |
| `h` `←` | Previous pane | global | lazygit's `h`/`l` cycle panes; they are not vim-style drill in/out. |
| `l` `→` | Next pane | global | |
| `h` `l` | Previous / next hunk | main | Context override, matching lazygit's staging context. |
| `tab` `shift+tab` | Next / previous pane | global | |
| `[` `]` | Previous / next scope tab | main | Replaces the former `tab`. |
| `,` `.` | Previous / next page | list panes, main | |
| `<` `>` `home` `end` | Jump to top / bottom | list panes, main | |
| `J` `K` | Scroll main pane down / up | global | Works while focus is on a left pane. |
| `H` `L` | Scroll main pane left / right | global | For long diff lines. |
| `ctrl+d` `ctrl+u` | Scroll main half page | global | |
| `pgdn` `pgup` | Scroll main pane | global | |
| `+` `_` | Next / previous screen mode | global | |
| `?` | Keybinding menu | global | |

### 5.3 Preserved

`0`–`5`, `@`, `/`, `R`, `f`, `p`, `P`, `c`, `A`, `s`, `b`, `w`, `q`, `ctrl+c`,
`space`, `enter`, `escape`, `d`, `a`, `r`, `n`, `g`, `o`, `y`, `ctrl+o` keep
their current meanings. They move into the registry and gain `description` and,
where applicable, `available`.

### 5.4 Hints bar examples

```
focus = files
 stage: space | reviewed: r | discard: d | all: a | commit: c | …      17/24 ● 2!

focus = main (branch review, read-only)
 hunk: h/l | copy: y | scope: ] | pane: tab | …        feature/payment vs origin/main

focus = stash
 apply: space | pop: g | drop: d | inspect: enter | …                  Working Tree
```

The right-hand segment is the review status, right-aligned, sized to its own
string width — lazygit's `information` window arrangement.

---

## 6. `src/ui/boxlayout.ts`

A faithful port of `lazycore/pkg/boxlayout`:

```ts
type Box = {
  readonly window?: string
  readonly direction?: "row" | "column"
  readonly conditionalDirection?: (width: number, height: number) => "row" | "column"
  readonly weight?: number   // mutually exclusive with size
  readonly size?: number
  readonly children?: readonly Box[]
  readonly conditionalChildren?: (width: number, height: number) => readonly Box[]
}

type Dimensions = { readonly x0: number; readonly y0: number; readonly x1: number; readonly y1: number }

function arrangeWindows(root: Box, x0: number, y0: number, width: number, height: number): Readonly<Record<string, Dimensions>>
```

Semantics to preserve exactly:

- Statically sized children are served first, cropped to the available space.
- Remaining space is divided among weighted children in proportion to weight.
- `normalizeWeights` divides weights by their lowest common factor
  (`2,4,4` becomes `1,2,2`) recursively. **This must be ported**: the remainder
  distribution loop walks the normalized weights, so omitting normalization
  produces different pixel results from lazygit.
- The remainder is dealt out one cell at a time across weighted boxes.

The engine holds no minimum-size logic and no githunk concepts. It is pure.

---

## 7. `src/ui/layout.ts`

### 7.1 The tree

```
root (row)
├─ body (column)                         weight 1
│  ├─ side          size = sideWidth        ← conditionalChildren: the five panes
│  ├─ vsplit        size = 1                ← the divider is itself a window
│  └─ mainSection (row)  weight 1
│      ├─ main      weight 1
│      ├─ hsplit    size = 1                (only when the log is visible)
│      └─ log       size = logHeight
└─ info (column)    size = 1                (hints bar; 0 when disabled)
    ├─ hints        weight 1
    └─ status       size = width(statusText)
```

### 7.2 Two deliberate divergences from lazygit

**Sizes, not weights, for the left/right split.** lazygit converts
`gui.sidePanelWidth` into an integer weight out of 120
(`getMidSectionWeights`) because it has nowhere to compute actual columns.
githunk needs exact column minimums (`MIN_LEFT_WIDTH`, `MIN_MAIN_WIDTH`) and an
exact mapping from a drag's x coordinate back to a ratio, neither of which
integer weights out of 120 can express. So the side width is computed first:

```
sideWidth = clamp(round(width * ratio), MIN_LEFT_WIDTH, width - 1 - MIN_MAIN_WIDTH)
```

and handed to boxlayout as a `size`, with `mainSection` taking `weight 1`.
Default `ratio = 0.3333`, matching lazygit's default — which turns today's fixed
30 columns into 66 on a 200-column terminal.

Minimum-size clamping therefore lives at tree-build time, which is the only
place that knows what the minimums mean. The engine stays pure.

**Dividers are windows in the tree.** Giving each divider a `size: 1` window
means its hit-test rectangle is the dimension boxlayout already computed, rather
than a second coordinate calculation maintained in parallel with the layout.

### 7.3 Left stack: accordion (enabled by default)

| Pane | Unfocused | Focused |
| --- | --- | --- |
| 1 Status / Review | `size 3` | `size 3` (never expands) |
| 2 Files | `weight 1` | `weight 2` |
| 3 Branches | `weight 1` | `weight 2` |
| 4 Commits | `weight 1` | `weight 2` |
| 5 Stash | `size 3` (folded) | `weight 2` |

This differs from lazygit's shipped defaults in one respect: lazygit defaults
`gui.expandFocusedSidePanel` to false, and githunk enables it. The rest — Status
pinned at 3 rows and excluded from the accordion, Stash folded to 3 rows until
focused, `expandedSidePanelWeight` of 2 — matches
`getDefaultStashWindowBox` and `sidePanelChildren`.

### 7.4 Short-terminal fallbacks

Ported from `sidePanelChildren`, scaled for githunk's five panes:

- `height >= 28`: the proportional layout above.
- `21 <= height < 28`: unfocused panes get `size 3`, the focused pane `weight 1`.
- `height < 21`: unfocused panes get `size 1`, the focused pane `weight 1`.

Without this, five panes plus accordion is unusable on a 24-row terminal.

### 7.5 Screen modes

`+` advances and `_` retreats through `normal` -> `half` -> `full`. Following
`getMidSectionWeights`, the effect depends on where focus is:

| Mode | Focus in main | Focus in a left pane |
| --- | --- | --- |
| `normal` | Per `ratio` | Per `ratio` |
| `half` | Side region collapsed | Side and main each take half; **only the focused left pane is shown** |
| `full` | Side region collapsed | Main collapsed; the focused left pane takes the full width |

Screen mode is transient, like lazygit's: it is not persisted.

### 7.6 Preserved layout contract

The properties the current `tests/ui/layout.test.ts` enforces must survive the
rewrite:

- No dimension is ever negative.
- `sideWidth + vsplitWidth + mainWidth === terminalWidth`, and the vertical
  partition likewise sums to `terminalHeight`.
- Minimums are clamped rather than violated.
- `tooSmall` is reported when the minimums cannot all be satisfied, and the
  degenerate layout still yields main dimensions of at least 1.

---

## 8. Divider UX

| State | Presentation |
| --- | --- |
| Idle | A dim `│` glyph per row, in the theme's border colour. |
| `onMouseOver` | Brightened, with `⇔` at the midpoint (`⇕` for the horizontal divider). |
| `onMouseDrag` | `ratio = x / terminalWidth`, clamped per §7.2, then re-arranged and persisted. |
| Double-click | See below. |

Double-click is defined per divider, because "collapse this axis" is otherwise
ambiguous once screen mode already depends on where focus is:

- **Vertical divider:** collapses the left region and moves focus to main —
  equivalent to screen mode `full` with focus in main. Double-clicking again
  restores `normal` and the previous focus.
- **Horizontal divider:** toggles command-log visibility, the same effect as
  `@`'s hide behaviour. This is independent of screen mode.

The current solid `#333333` block is what reads as a scrollbar; a glyph column
in the border colour reads as a frame edge, and the hover state is what
communicates that it is draggable.

Both dividers set `selectable = false`. The vertical one already does; the
horizontal one does not, which today lets a drag on it begin a text selection.
That is an existing defect fixed here.

`onMouseOver` / `onMouseOut` / `onMouseMove` are available on OpenTUI
renderables, and `main.ts` already starts the renderer with
`enableMouseMovement: true`, so no renderer configuration changes.

## 9. UI state persistence

`.git/githunk/ui-state-v1.json`, alongside the existing
`.git/githunk/review-state-v1.json`. Same directory, so it inherits the property
of not dirtying the working tree and not becoming committed project state
(PRD §13).

Persisted fields: `sidePanelRatio`, `commandLogHeight`, `commandLogVisible`.
Screen mode and focus are not persisted.

`src/review/store.ts` already implements atomic write via temp-file rename,
refusal of symlinked path components, `0600` mode enforcement, directory fsync,
and corrupt-file quarantine. That machinery is extracted into a shared
`localStateFile` helper and used by both stores rather than duplicated. A second
hand-rolled copy of security-relevant file handling is the failure mode worth
avoiding here.

## 10. Bottom bar and `?` menu

The `info` row is one terminal row: `hints` takes `weight 1`, `status` takes a
static size equal to its rendered string width, so the status is right-aligned.
The row can be disabled, in which case `info` takes `size 0` and the diff
reclaims the row.

`?` opens a menu listing the current context's bindings first, then the global
bindings the context has not overridden, using `menuDescription`. It is a modal
context: it consumes input ahead of pane and global bindings, and `escape` and
`?` both close it.

## 11. Controller wiring

### 11.1 The Commits bug

`src/app/controller.ts:124`:

```ts
this.automaticCommitHistory = options instanceof GitRunner
  || options.loadCommits !== undefined || options.commitsLoader !== undefined
```

`src/main.ts:23` constructs `new AppController({ repositoryRoot, runner })`,
which satisfies none of the three disjuncts. `loadCommitHistory` therefore
returns `{ commits: [] }` unconditionally in the shipped application
(`controller.ts:872`).

Tests never caught it because every test constructs the controller either as
`new AppController(runner)` — the `GitRunner` form, where the flag is true — or
with an injected `loadCommits`. No test used main.ts's options shape.

### 11.2 The fix

1. **Remove `automaticCommitHistory`.** One rule: a present `runner` means the
   real loaders are used; an explicitly injected loader takes precedence.
   `automaticBranchListing` and `automaticStashListing` are the same divergence
   with more permissive defaults, and get the same treatment.

2. **Extract the wiring.** A new `src/app/create-app.ts` exports
   `createApp({ repositoryRoot, runner, renderer })`, returning the controller
   and view with all the callback plumbing that currently lives inline in
   `main.ts`. `main.ts` reduces to: resolve the repository root, create the
   renderer, call `createApp`, refresh.

   Tests import the same `createApp`. This is the actual remedy for "the real
   path was never tested": there is only one path, and it is the tested one.

3. **Verify the loader change against existing tests.** Two test files
   (`tests/app/controller.test.ts`, `tests/app/commit-drilldown.test.ts`) pass
   both a `runner` and a `load`; after the change those will begin invoking real
   `git log`. They use temp repositories, so their assertions are expected to be
   unaffected, but the full suite must be run to confirm rather than assumed.

### 11.3 Note on base inference

A repository with no remote makes `inferReviewBase` return `choose`, prompting
for a base — correct per PRD §9. Working-tree mode loads commit history with the
range `"HEAD"`, so removing the flag is sufficient to populate the Commits pane;
no change to base inference is required or intended.

## 12. Testing

| Layer | File | Covers |
| --- | --- | --- |
| Pure | `tests/ui/boxlayout.test.ts` | `calcSizes`, `normalizeWeights`, remainder distribution, nesting, `conditionalChildren`, `conditionalDirection` |
| Pure | `tests/ui/layout.test.ts` (rewritten) | Ratio, minimum clamping, accordion heights, all three screen modes for both focus locations, short-terminal fallbacks, `tooSmall`, and the existing partition-sum property test |
| Pure | `tests/ui/bindings.test.ts` | No collisions, every binding has a description, every action has a handler, hints formatting and truncation, `available` filtering |
| Real git, real wiring | `tests/app/create-app.integration.test.ts` | Temp repository with several commits through `createApp`: commits, branches, and stashes are all populated |
| Real git, real rendering | `tests/ui/acceptance/shell.integration.test.ts` | `createTestRenderer` plus temp repository plus `createApp`: `captureCharFrame()` contains commit subjects; the hints bar changes with focus; accordion heights respond to focus; `mockMouse.drag` changes the side width; `+`/`_` change screen mode; `h`/`l` move focus between panes; `resize()` leaves the layout intact |

The last row is the regression gate. It asserts on the rendered text of the
Commits pane, so the symptom found by hand — an empty Commits pane on a branch
with commits — fails in CI from now on.

OpenTUI ships the helpers this needs: `createTestRenderer` provides
`captureCharFrame`, `resize`, `mockInput.pressKey`, and `mockMouse.drag`
(`@opentui/core/testing`).

## 13. Breaking changes

- `tab` no longer toggles the main pane's scope; `[` / `]` do. `tab` cycles
  panes.
- `computeLayout`'s signature changes from `leftWidth` to `sidePanelRatio` plus
  focus and screen-mode inputs. It is internal, with no consumers outside
  `root-view.ts` and its tests.
- `AppControllerOptions` loses `automaticCommitHistory`'s implicit behaviour.
  Injected-loader call sites are unaffected; call sites passing a `runner` now
  get real commit history, which is the intended fix.

## 14. Deferred

- Keyboard range-select (`v`) in the main pane.
- A user config file exposing `sidePanelRatio`, accordion, and hints-bar
  visibility as settings. Defaults are hardcoded for now; the persisted UI state
  file is the natural place to grow into this.
- lazygit's `shrinkSidePanelsToContent` water-filling layout. The accordion
  covers the complaint that motivated this work; content-proportional heights
  can follow if the fixed weights prove insufficient.
- Portrait mode (lazygit's `gui.portraitMode`, which stacks the side region
  above main on narrow terminals). The engine supports it — that is what
  `conditionalDirection` is for — but `body` is a fixed `column` this round, so
  the layout is always landscape.

## 15. Suggested implementation order

Each phase leaves the application working and is independently verifiable.

1. **Wiring fix.** Remove the loader flags, extract `createApp`, add
   `tests/app/create-app.integration.test.ts`. This alone fixes the empty
   Commits pane, and it is the smallest change with the largest visible effect.
2. **`boxlayout.ts`** plus its tests. Pure addition; nothing consumes it yet.
3. **`layout.ts` rewrite** onto the box tree: ratio, accordion, folded Stash,
   short-terminal fallbacks, screen modes. Rewrite `tests/ui/layout.test.ts`.
   Wire `root-view.ts` to the arranged dimensions and add `+` / `_`.
4. **`bindings.ts`** plus its tests: move `CORE_KEYMAP` and the twenty-six
   hardcoded keys in `root-view.ts` into the registry, adding descriptions and
   `available` predicates. Move the scope toggle to `[` / `]`.
5. **Hints bar and `?` menu**, reading the registry from phase 4.
6. **Navigation keys** from §5.2 that phase 3 did not already need.
7. **Divider affordance and persistence**: hover, drag-to-ratio, double-click,
   `localStateFile` extraction, `ui-state-v1.json`.
8. **Acceptance test** (`tests/ui/acceptance/shell.integration.test.ts`) over
   the finished shell.
