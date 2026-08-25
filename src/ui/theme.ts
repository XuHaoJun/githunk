/**
 * lazygit's colour palette, in the one place every renderer reads it from.
 *
 * lazygit configures colours as ANSI names ("blue", "green") which the terminal resolves
 * through its 16-colour palette. OpenTUI 0.5.6 has no ANSI-indexed colours at all — its
 * `parseColor` accepts only hex and CSS names — so each ANSI name is pinned here to the hex
 * a standard 16-colour palette renders it as (the CSS `navy`/`green` family), rather than to
 * OpenTUI's `bgBlue`/`green` helpers, whose CSS `blue` is the far brighter #0000FF.
 */

/**
 * Background of the selected row in a focused list.
 * lazygit: `SelectedLineBgColor: []string{"blue"}` — pkg/config/user_config.go:889.
 * ANSI blue (colour 4) = CSS `navy`; #0000FF (CSS `blue`, what OpenTUI's `bgBlue` resolves to)
 * is the *bright* blue and washes out the row text.
 */
export const SELECTED_LINE_BG = "#000080"

/**
 * Foreground of the active tab in a focused pane's title.
 * lazygit: `ActiveBorderColor: []string{"green", "bold"}` — pkg/config/user_config.go:885 —
 * is assigned to `g.SelFgColor` (pkg/gui/gui.go:1254), which `drawTitle` paints the active
 * tab with. ANSI green (colour 2) = CSS `green`.
 */
export const TAB_ACTIVE_FG = "#008000"

/** The `bold` half of `ActiveBorderColor` — pkg/config/user_config.go:885. */
export const TAB_ACTIVE_BOLD = true

/** Tab separator inside a pane title: `separator := " - "` — pkg/gocui/gui.go:1421. */
export const TAB_SEPARATOR = " - "

/**
 * Appended to the `[key]` title prefix: the view's first frame rune, `─` by default —
 * pkg/gocui/gui.go:1411.
 */
export const TITLE_PREFIX_FRAME_RUNE = "─"

/**
 * Foreground of a reflog entry's short hash.
 * lazygit: `hashColor := style.FgBlue` — pkg/gui/presentation/reflog_commits.go:43 (the
 * un-cherry-picked, un-diffed case, which is every row here).
 * ANSI blue (colour 4) = CSS `navy`, the same pinning `SELECTED_LINE_BG` documents.
 */
export const REFLOG_HASH_FG = "#000080"

/**
 * lazygit names most foregrounds as ANSI colours (`style.FgGreen`, `style.FgCyan`, …), which a
 * terminal resolves through its 16-colour palette. OpenTUI has no ANSI-indexed colours, so each
 * one is pinned here to the hex a standard 16-colour palette renders it as — the same pinning
 * `SELECTED_LINE_BG` documents above.
 */
const ANSI_RED = "#800000"
const ANSI_GREEN = "#008000"
const ANSI_YELLOW = "#808000"
const ANSI_CYAN = "#008080"

/**
 * A file (or directory subtree) whose only changes are staged.
 * lazygit: `nameColor = style.FgGreen` — pkg/gui/presentation/files.go:135.
 */
export const FILE_STAGED_FG = ANSI_GREEN

/**
 * A file (or directory subtree) with both staged and unstaged changes.
 * lazygit: `nameColor = style.FgYellow` — pkg/gui/presentation/files.go:137.
 */
export const FILE_MIXED_FG = ANSI_YELLOW

/**
 * The unstaged half of a two-character short status, and a `?` in its staged half.
 * lazygit: `theme.UnstagedChangesColor` — pkg/gui/presentation/files.go:189/195 — configured as
 * `UnstagedChangesColor: []string{"red"}` (pkg/config/user_config.go:895).
 */
export const UNSTAGED_CHANGES_FG = ANSI_RED

/**
 * The `"  *"` marker on the worktree the app is running in.
 * lazygit: `currentColor = style.FgGreen` — pkg/gui/presentation/worktrees.go:28.
 */
export const WORKTREE_CURRENT_FG = ANSI_GREEN

/**
 * The (blank) marker cell on every other worktree.
 * lazygit: `currentColor := style.FgCyan` — pkg/gui/presentation/worktrees.go:25.
 */
export const WORKTREE_INACTIVE_MARKER_FG = ANSI_CYAN

/**
 * A worktree whose directory is gone: the whole name cell turns red.
 * lazygit: `textStyle = style.FgRed` — pkg/gui/presentation/worktrees.go:33.
 */
export const WORKTREE_MISSING_FG = ANSI_RED

/** A worktree's checked-out branch — pkg/gui/presentation/worktrees.go:50. */
export const WORKTREE_BRANCH_FG = ANSI_CYAN

/** A detached worktree's `HEAD detached at <hash>` — pkg/gui/presentation/worktrees.go:52. */
export const WORKTREE_DETACHED_FG = ANSI_YELLOW

/** `Name:` in the submodule preview — pkg/gui/controllers/submodules_controller.go:117. */
export const SUBMODULE_NAME_FG = ANSI_GREEN

/** `Path:` in the submodule preview — pkg/gui/controllers/submodules_controller.go:118. */
export const SUBMODULE_PATH_FG = ANSI_YELLOW

/** `Url:` in the submodule preview — pkg/gui/controllers/submodules_controller.go:119. */
export const SUBMODULE_URL_FG = ANSI_CYAN

/**
 * Base-ANSI foreground → its bright variant, keyed and valued by hex.
 *
 * lazygit brightens the foreground of every rune on a highlighted line —
 * pkg/gocui/view.go:665-680 (`View.setCharacter`):
 *
 *     // this ensures we use the bright variant of a colour upon highlight
 *     fgColorComponent := fgColor & ^AttrAll
 *     if fgColorComponent >= AttrIsValidColor && fgColorComponent < AttrIsValidColor+8 {
 *         fgColor += 8
 *     }
 *     fgColor = fgColor | AttrBold
 *
 * `AttrIsValidColor` … `AttrIsValidColor+8` is exactly `ColorBlack`…`ColorWhite`
 * (pkg/gocui/attribute.go:19,37-45), so only the 8 base ANSI colours are promoted; a default
 * (unset) or truecolor foreground falls through untouched. The promotion runs whether or not the
 * view holds focus — only the *background* half of that branch varies with focus.
 *
 * Both halves are pinned to hex because OpenTUI has no ANSI-indexed colours: the keys are the
 * dark hexes a standard 16-colour palette renders ANSI 0-7 as (the pinning `SELECTED_LINE_BG`
 * documents above), and the values are the hexes OpenTUI's own `brightblack`…`brightwhite` CSS
 * names resolve to (`CSS_COLOR_NAMES`, node_modules/@opentui/core/chunk-bun-9335djz2.js), so the
 * two palettes cannot drift apart.
 */
const BRIGHT_ANSI_BY_BASE_ANSI: Readonly<Record<string, string>> = {
  "#000000": "#666666", // black → brightblack
  "#800000": "#ff6666", // red (CSS maroon) → brightred
  "#008000": "#66ff66", // green → brightgreen
  "#808000": "#ffff66", // yellow (CSS olive) → brightyellow
  "#000080": "#6666ff", // blue (CSS navy) → brightblue
  "#800080": "#ff66ff", // magenta (CSS purple) → brightmagenta
  "#008080": "#66ffff", // cyan (CSS teal) → brightcyan
  "#c0c0c0": "#ffffff", // white (CSS silver) → brightwhite
}

/**
 * ANSI colours 0-15 as hex, in palette order.
 *
 * The dark half is `BRIGHT_ANSI_BY_BASE_ANSI`'s keys and the bright half its values, so the three
 * places that need a 16-colour palette — the pinned constants above, the highlight promotion below
 * and `parseAnsi` (./ansi) resolving git's own SGR output — cannot drift apart.
 */
export const ANSI_PALETTE: readonly string[] = [
  ...Object.keys(BRIGHT_ANSI_BY_BASE_ANSI),
  ...Object.values(BRIGHT_ANSI_BY_BASE_ANSI),
]

/**
 * The bright variant of `color` when it is one of the 8 base ANSI colours, otherwise `color`
 * itself — lazygit's `fgColor += 8` on a highlighted line (pkg/gocui/view.go:665-670).
 * Bold, the other half of that branch, is the caller's job.
 */
export function brightenAnsiForeground(color: string): string {
  const normalized = color.trim().toLowerCase()
  // An opaque 8-digit hex names the same colour as its 6-digit form; any other alpha is left be.
  const rgb = normalized.length === 9 && normalized.endsWith("ff") ? normalized.slice(0, 7) : normalized
  return BRIGHT_ANSI_BY_BASE_ANSI[rgb] ?? color
}
