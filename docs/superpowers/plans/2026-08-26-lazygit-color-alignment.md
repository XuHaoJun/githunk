# Lazygit Color Alignment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make githunk preserve lazygit's ANSI indexed/default color semantics so the terminal palette controls the same colors in both applications.

**Architecture:** `src/ui/theme.ts` owns immutable-by-convention `RGBA` tokens for ANSI indices, terminal defaults, and explicit RGB values. It also accepts OpenTUI's terminal palette query before the first application render and updates RGB fallbacks without changing indexed/default intent; Ghostty's built-in palette is the no-response fallback used in this environment. ANSI parsing, list rendering, diff highlighting, tab strips, pane chrome, and base text renderables consume those tokens instead of static ANSI-mimicking hex strings or OpenTUI CSS color helpers. The old string-hex theme contract is removed rather than shimmed.

**Tech Stack:** Bun, strict TypeScript, OpenTUI 0.5.6 `RGBA`/`ColorInput`, Bun test, vendored lazygit Go sources.

**Spec:** `docs/superpowers/specs/2026-08-26-lazygit-color-alignment-design.md`

## Global Constraints

- Lazygit is the color semantic reference: `learn-projects/lazygit/pkg/config/user_config.go:884-896`, `pkg/theme/gocui.go:9-18`, `pkg/gocui/attribute.go:37-45,124-165`, `pkg/gocui/view.go:675-685`.
- Preserve ANSI 0-255 as `RGBA.fromIndex(index)`; preserve terminal defaults as `RGBA.defaultForeground()`/`RGBA.defaultBackground()`; preserve explicit RGB as RGB-intent `RGBA`.
- No runtime dependency changes, no lazygit config-file loader, and no compatibility aliases for old string-hex exports.
- Keep `strict`, `noUncheckedIndexedAccess`, and `exactOptionalPropertyTypes` passing.
- Tests must assert semantic intent/slot where the contract is ANSI; do not lock behavior to the old dark hex values.

---

### Task 1: Establish the semantic color token contract

**Files:**
- Modify: `src/ui/theme.ts`
- Modify: `src/main.ts`

**Interfaces:**
- Produces `ANSI_BLACK`, `ANSI_RED`, `ANSI_GREEN`, `ANSI_YELLOW`, `ANSI_BLUE`, `ANSI_MAGENTA`, `ANSI_CYAN`, `ANSI_WHITE` as indexed `RGBA` values with slots 0-7.
- Produces `ANSI_BRIGHT_BLACK` through `ANSI_BRIGHT_WHITE` as indexed slots 8-15.
- Produces `DEFAULT_FOREGROUND` and `DEFAULT_BACKGROUND` as default-intent `RGBA` values.
- Existing semantic exports (`SELECTED_LINE_BG`, `TAB_ACTIVE_FG`, `REFLOG_HASH_FG`, branch/file/worktree colors, PR colors) become `RGBA` values; ANSI aliases point at indexed tokens and PR colors use RGB-intent values.
- Produces `indexedColor(slot: number): RGBA`, using the queried palette fallback for indexed slots.
- Produces `configureTerminalPalette(snapshot: TerminalPaletteSnapshot): void`, updating fallback RGB bytes while preserving each token's intent/slot.

- [ ] **Step 2: Run the token test and verify it fails**

  Run: `bun test tests/ui/theme.test.ts`

  Expected: FAIL because the current theme exports are strings and `brightenAnsiForeground` accepts a string.

- [ ] **Step 3: Implement semantic tokens**

  Import `RGBA` from `@opentui/core`; construct ANSI tokens with `RGBA.fromIndex`, defaults with `RGBA.defaultForeground`/`RGBA.defaultBackground`, and literal PR colors with `RGBA.fromInts`. Add Ghostty fallback palette values, `indexedColor`, and `configureTerminalPalette`; use a full 256-color query in `src/main.ts` before `createApp` on direct terminals, but skip it whenever zellij is detected because OSC replies can leak into the parent shell.

- [ ] **Step 4: Run the token test and verify it passes**

  Run: `bun test tests/ui/theme.test.ts`

  Expected: PASS.

---

### Task 2: Preserve indexed colors through ANSI parsing and diff painting

**Files:**
- Modify: `src/ui/ansi.ts`
- Modify: `src/ui/panes/ansi-text.ts`
- Modify: `src/ui/panes/pane-text.ts`
- Modify: `src/ui/panes/diff-text.ts`
- Modify: `tests/ui/ansi.test.ts`
- Modify: `tests/ui/ansi-text.test.ts`
- Modify: `tests/ui/main-diff.integration.test.ts`

**Interfaces:**
- `AnsiSpan.fg` is `RGBA` rather than `string`.
- `PaneStyleDefinition.fg` accepts OpenTUI `ColorInput`; `registerStyle` passes it unchanged to OpenTUI.
- SGR 30-37, 90-97, and 38;5;n produce indexed `RGBA`; SGR 38;2;r;g;b produces RGB-intent `RGBA`.

- [ ] **Step 1: Update ANSI tests to assert intent and slots**

  Change SGR 31/32/34 and SGR 38;5;12 expectations to inspect indexed slots 1/2/4/12. Change the truecolor expectation to inspect RGB intent and `[130, 89, 221, 255]`. Retain text, row, bold, dim, reset, and unsupported-escape assertions.

- [ ] **Step 2: Run parser tests and verify they fail**

  Run: `bun test tests/ui/ansi.test.ts`

  Expected: FAIL because `parseAnsi` currently returns fixed hex strings.

- [ ] **Step 3: Implement indexed SGR parsing**

  Change `AnsiStyle.fg`, `AnsiSpan.fg`, and `color256` to use `RGBA`. Map indexed SGR values with `RGBA.fromIndex`; map truecolor SGR with `RGBA.fromInts`; retain malformed/unsupported sequence consumption and default-reset behavior. Remove the fixed xterm RGB conversion.

- [ ] **Step 4: Migrate optimized and fallback diff/highlight painting**

  Change `PaneStyleDefinition.fg` to `ColorInput`, pass `span.fg` into style registration and `fgChunk`, and replace diff style strings with `ANSI_GREEN`, `ANSI_RED`, and `ANSI_CYAN`. Ensure registered highlights and fallback chunks use the same semantic tokens.

- [ ] **Step 5: Update integration expectations and run focused tests**

  Assert indexed intent/slots for ANSI diff and graph colors and RGB intent for truecolor spans. Run: `bun test tests/ui/ansi.test.ts tests/ui/ansi-text.test.ts tests/ui/main-diff.integration.test.ts`

  Expected: PASS.

---

### Task 3: Migrate list rows, graph, and semantic color callsites

**Files:**
- Modify: `src/ui/list-view.ts`
- Modify: `src/ui/commit-graph.ts`
- Modify: `src/ui/branch-status.ts`
- Modify: `src/ui/pull-request-icon.ts`
- Modify: `src/ui/panes/files-pane.ts`
- Modify: `src/ui/panes/branches-pane.ts`
- Modify: `src/ui/panes/worktrees-pane.ts`
- Modify: `src/ui/panes/reflog-pane.ts`
- Modify: `src/ui/panes/remotes-pane.ts`
- Modify: `src/ui/panes/tags-pane.ts`
- Modify: `tests/ui/list-view.test.ts`
- Modify: `tests/ui/branch-rows.test.ts`
- Modify: `tests/ui/branch-status.test.ts`
- Modify: `tests/ui/files-tree-pane.test.ts`
- Modify: `tests/ui/commit-graph.test.ts`
- Modify: `tests/ui/reflog-tab.integration.test.ts`

**Interfaces:**
- `ListColumn.color`, `ListColumnSegment.color`, `GraphSegment.color`, and branch/icon color fields accept `ColorInput`.
- `styleToChunk` maps list style names to shared ANSI tokens; `dim` remains an attribute-only style.
- Selected-row highlighting applies `brightenAnsiForeground` to indexed `RGBA` values and uses `SELECTED_LINE_BG` as indexed ANSI blue.

- [ ] **Step 1: Add failing list semantic assertions**

  Assert that `style: "green"`, `style: "yellow"`, and `style: "cyan"` yield indexed slots 2, 3, and 6; selected base colors yield bright indexed slots 10, 11, and 14; explicit `#1a2b3c` remains RGB intent; and selected background is indexed slot 4.

- [ ] **Step 2: Run list tests and verify they fail**

  Run: `bun test tests/ui/list-view.test.ts tests/ui/commit-graph.test.ts`

  Expected: FAIL because list helpers currently resolve CSS names and row types only accept strings.

- [ ] **Step 3: Implement list and graph migration**

  Import `ColorInput` and shared ANSI tokens. Replace OpenTUI `green`/`yellow`/`cyan`/`magenta` helper calls for semantic styles with `fg(ANSI_...)(text)`. Remove `hexOf`; pass `RGBA` directly to `brightenAnsiForeground` and `bg(SELECTED_LINE_BG)`. Widen row/graph/status/icon color types; keep author colors and pull-request colors as RGB intent.

- [ ] **Step 4: Update row fixture expectations**

  Replace old fixed-hex comparisons in branch, file-tree, graph, and list tests with intent/slot/value assertions. Keep exact literal RGB assertions for PR and author colors.

- [ ] **Step 5: Run focused list tests**

  Run: `bun test tests/ui/list-view.test.ts tests/ui/commit-graph.test.ts tests/ui/branch-rows.test.ts tests/ui/branch-status.test.ts tests/ui/files-tree-pane.test.ts`

  Expected: PASS.

---
### Task 4: Align pane defaults, borders, and remaining standard chrome

**Files:**
- Modify: `src/ui/panes/common.ts`
- Modify: `src/ui/panes/command-log-pane.ts`
- Modify: `src/ui/keybinding-menu.ts`
- Modify: `src/ui/hints-bar.ts`
- Modify: `src/ui/splitter.ts`
- Modify: `tests/ui/pane-tabs.test.ts`
- Modify: `tests/ui/pane-tabs.integration.test.ts`
- Modify: `tests/ui/files-tabs.integration.test.ts`
- Modify: `tests/ui/commit-flow.integration.test.ts`
- Create: `tests/ui/pane-colors.test.ts`

**Interfaces:**
- Base pane text renderables use `DEFAULT_FOREGROUND`.
- Unfocused pane border/title use `DEFAULT_FOREGROUND`; focused pane border/title use `ANSI_GREEN`; active-tab text remains indexed green plus bold.
- Keybinding menu standard background uses `DEFAULT_BACKGROUND` and standard border/text use terminal defaults.
- Splitter and review-status colors remain extension-only presentation and are not relabeled as lazygit colors.

- [ ] **Step 1: Add failing chrome/default assertions**

  Assert that a newly created pane's text `fg.intent` is `"default"`, an unfocused pane border/title is default intent, a focused pane border/title is indexed slot 2, and the keybinding popup background is default intent rather than fixed RGB black.

- [ ] **Step 2: Run chrome tests and verify they fail**

  Run: `bun test tests/ui/pane-tabs.test.ts tests/ui/pane-tabs.integration.test.ts tests/ui/commit-flow.integration.test.ts`

  Expected: FAIL because panes currently use fixed `#555555`, `#aaaaaa`, `#ffffff`, and `#101010` colors.

- [ ] **Step 3: Implement default and border migration**

  Add `fg: DEFAULT_FOREGROUND` to base pane and command-log text renderables. Use `DEFAULT_FOREGROUND`, `DEFAULT_BACKGROUND`, and `ANSI_GREEN` in pane/command-log chrome and keybinding popup. Preserve popup editor default intents already implemented in `commit-message-panel.ts`.

- [ ] **Step 4: Update captured-span expectations**

  Inspect captured spans by `intent`/`slot`; keep focus, geometry, and active-tab bold assertions unchanged. Replace fixed default-white/gray expectations only where the contract is now terminal default or ANSI green.

- [ ] **Step 5: Run focused chrome tests**

  Run: `bun test tests/ui/pane-tabs.test.ts tests/ui/pane-tabs.integration.test.ts tests/ui/files-tabs.integration.test.ts tests/ui/commit-flow.integration.test.ts`

  Expected: PASS.

---

### Task 5: Run repository verification and actual TUI smoke

**Files:**
- Verify: all changed source and test files from Tasks 1-4
- Verify: `docs/lazygit-compatibility-v0.1.md` remains accurate because config-file loading is still out of scope

**Interfaces:**
- No new interfaces; this task verifies the migrated semantic color contract end to end.

- [ ] **Step 1: Run the full typecheck**

  Run: `bun run typecheck`

  Expected: exit 0 with no TypeScript errors.

- [ ] **Step 2: Run the full test suite**

  Run: `bun test`

  Expected: all tests pass.

- [ ] **Step 3: Launch githunk in a real PTY with background work disabled**

  Run from the controlled Git fixture in a tmux PTY: `GITHUNK_BACKGROUND=0 bun /absolute/path/to/githunk/src/main.ts`. Exercise Files, Branches, Commits, selected rows, the active tab strip, and Main diff colors; capture with `tmux capture-pane -p -e`.

- [ ] **Step 4: Launch lazygit in the same PTY environment**

  Run `lazygit` against the same fixture, exercise the same panes, and capture with `tmux capture-pane -p -e`. Resolve lazygit's ANSI SGR 16-color values through the active Ghostty palette and compare them with githunk's RGB fallback output for each corresponding semantic role: selected background, active green, staged/unstaged status, diff addition/deletion/hunk, commit hash, default text, and border.

- [ ] **Step 5: Review whitespace and working-tree state**

  Run: `git diff --check && git status --short`

  Expected: no whitespace errors; only intended source/test/spec/plan changes are present.
