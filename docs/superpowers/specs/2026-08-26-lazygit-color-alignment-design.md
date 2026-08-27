# Lazygit Color Alignment Design

**Status:** Approved design
**Date:** 2026-08-26
**Reference:** vendored `learn-projects/lazygit/`
**Scope:** Replace githunk's static ANSI-to-RGB approximation with lazygit-compatible terminal color semantics

## 1. Goal

Make githunk render lazygit's default theme through the same color semantics:

- ANSI colors remain terminal palette indices, so Ghostty and other terminals resolve them using their own configured palette.
- `default` remains the terminal's default foreground/background instead of becoming a fixed RGB color.
- Explicit truecolor values remain truecolor values.
- Selected rows promote base ANSI foreground indices to their bright counterparts and add bold, matching gocui.
- Every githunk renderer that represents a lazygit ANSI color consumes the same typed theme token.

This is a deliberate breaking internal API change. Existing tests and internal callsites are migrated together; no compatibility aliases preserve the static-hex contract.

## 2. Root Cause

Lazygit's default theme config uses names such as `green`, `blue`, and `default` (`pkg/config/user_config.go:884-896`). `pkg/theme/gocui.go` maps those names to `gocui.Color*` attributes, and `gocui` passes the indexed colors through `OutputTrue`; the terminal resolves the indices through its palette.

Githunk currently maps those same names to fixed RGB strings in `src/ui/theme.ts`, resolves OpenTUI named colors as CSS RGB values, and converts git SGR sequences to a fixed `ANSI_PALETTE`. On a Ghostty default palette this makes colors such as ANSI green, cyan, and blue much darker, especially selected-line blue.

The installed OpenTUI 0.5.6 API provides `RGBA.fromIndex`, `RGBA.defaultForeground`, `RGBA.defaultBackground`, and `CliRenderer.getPalette`. The implementation uses indexed/default intents and queries the terminal palette before the first application render; if the query cannot complete, it uses the current Ghostty defaults as the RGB fallback while keeping the semantic intent.

## 3. Color Contract

`src/ui/theme.ts` becomes the single semantic color source:

| Semantic | Representation | lazygit equivalent |
| --- | --- | --- |
| ANSI 0-255 | `RGBA.fromIndex(index)` | `gocui.Color*` / tcell indexed color |
| terminal foreground | `RGBA.defaultForeground()` | `ColorDefault` foreground |
| terminal background | `RGBA.defaultBackground()` | `ColorDefault` background |
| explicit truecolor | `RGBA.fromInts(...)` or existing RGB result | gocui/tcell RGB color |

The module exports named base and bright ANSI tokens plus default foreground/background tokens. `RGBA` values are treated as immutable by convention; callers never mutate a shared token.

`brightenAnsiForeground` accepts an `RGBA`: indexed slots 0-7 return slot 8-15, while truecolor and default colors pass through unchanged. This preserves lazygit's `fgColor += 8` rule without comparing rendered hex values.

## 4. Data Flow

### 4.1 Git SGR output

`src/ui/ansi.ts` stores `AnsiSpan.fg` as `RGBA`:

- SGR 30-37 → `RGBA.fromIndex(0-7)`;
- SGR 90-97 → `RGBA.fromIndex(8-15)`;
- SGR 38;5;n → `RGBA.fromIndex(n)`;
- SGR 38;2;r;g;b → `RGBA.fromInts(r, g, b)`;
- reset/default → no foreground span, allowing the pane's default foreground to render.

The parser no longer converts indexed colors to fixed xterm RGB values.

### 4.2 List rows

`ListColumn.color` and `ListColumnSegment.color` accept OpenTUI `ColorInput`. Named list styles (`green`, `yellow`, `cyan`, `magenta`) resolve through semantic ANSI tokens, not OpenTUI CSS helpers. Explicit author and pull-request RGB colors remain unchanged.

Selected-row highlighting applies `brightenAnsiForeground` to any indexed foreground and uses the ANSI blue token as its background. Uncolored text keeps the pane's terminal-default foreground.

### 4.3 Diff and pane highlights

`PaneStyleDefinition.fg` accepts `ColorInput`. Diff style definitions and fallback chunk rendering use the shared ANSI tokens. This keeps the optimized line-highlight path and its fallback path semantically identical.

### 4.4 Pane chrome and defaults

Base pane text renderables receive the terminal-default foreground token. Pane borders and titles use terminal default when unfocused and ANSI green when focused, matching lazygit's default inactive/active border theme. Existing active-tab bold rendering remains in the tab-strip renderer.

Popup editors already use terminal-default foreground/background intents and retain that behavior. Custom review, command-log, keybinding, and splitter surfaces continue to exist; their colors are changed only where they currently stand in for lazygit defaults.

## 5. Scope and Non-Goals

Included:

- theme token representations and all ANSI token consumers;
- SGR/256-color parsing;
- list styles, selected rows, diff highlights, pane tabs, pane borders, pane text defaults;
- tests that currently assert fixed ANSI hex values.

Not included:

- loading a lazygit YAML config file or exposing new githunk theme configuration;
- changing explicit truecolor author and pull-request algorithms;
- removing the three documented githunk review extensions;
- redesigning custom review/status copy or splitter presentation beyond replacing colors that are lazygit defaults.

## 6. Compatibility and Failure Behavior

This change removes the old string-hex theme contract. TypeScript compilation must fail until every caller is migrated, which is intentional and bounded by the repository.

Startup queries the terminal palette through `CliRenderer.getPalette({ size: 256 })` before creating the app on direct terminals. Zellij is explicitly excluded because its OSC 4 replies can leak into the parent shell; zellij uses Ghostty's built-in fallback palette in this environment. A successful direct-terminal query supplies fallback RGB values for multiplexers that cannot render indexed colors directly, while indexed/default intent remains preserved where supported.

Truecolor SGR values are never quantized. Unsupported/malformed SGR values keep the existing parser behavior: consume the sequence and leave the current style unchanged.

## 7. Verification

- Unit tests prove indexed ANSI spans retain `intent: "indexed"` and the correct slot, truecolor spans retain `intent: "rgb"`, and resets restore the default path.
- List and diff integration tests inspect captured RGBA intent/slot values rather than fixed dark hex values.
- `bun run typecheck` and `bun test` pass.
- A real PTY smoke compares a selected row, active tab, file status, diff addition, and diff header in githunk against lazygit under the same Ghostty palette. The verification records semantic output, not a claim that all terminal themes have identical RGB values.
