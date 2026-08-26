import { RGBA } from "@opentui/core"

/**
 * Lazygit's theme names are ANSI indices, not CSS colours. Keep that intent in the OpenTUI value so
 * the terminal resolves the palette (Ghostty, tmux, and user overrides) exactly as lazygit does.
 * Explicit RGB values use `RGBA.fromInts` instead and therefore remain truecolor.
 */
function indexed(slot: number): RGBA {
  return RGBA.fromIndex(slot)
}

export const ANSI_BLACK = indexed(0)
export const ANSI_RED = indexed(1)
export const ANSI_GREEN = indexed(2)
export const ANSI_YELLOW = indexed(3)
export const ANSI_BLUE = indexed(4)
export const ANSI_MAGENTA = indexed(5)
export const ANSI_CYAN = indexed(6)
export const ANSI_WHITE = indexed(7)

export const ANSI_BRIGHT_BLACK = indexed(8)
export const ANSI_BRIGHT_RED = indexed(9)
export const ANSI_BRIGHT_GREEN = indexed(10)
export const ANSI_BRIGHT_YELLOW = indexed(11)
export const ANSI_BRIGHT_BLUE = indexed(12)
export const ANSI_BRIGHT_MAGENTA = indexed(13)
export const ANSI_BRIGHT_CYAN = indexed(14)
export const ANSI_BRIGHT_WHITE = indexed(15)

/** ANSI colours 0-255, retained as indexed intent for SGR and lazygit theme rendering. */
export const ANSI_PALETTE: readonly RGBA[] = [
  ANSI_BLACK,
  ANSI_RED,
  ANSI_GREEN,
  ANSI_YELLOW,
  ANSI_BLUE,
  ANSI_MAGENTA,
  ANSI_CYAN,
  ANSI_WHITE,
  ANSI_BRIGHT_BLACK,
  ANSI_BRIGHT_RED,
  ANSI_BRIGHT_GREEN,
  ANSI_BRIGHT_YELLOW,
  ANSI_BRIGHT_BLUE,
  ANSI_BRIGHT_MAGENTA,
  ANSI_BRIGHT_CYAN,
  ANSI_BRIGHT_WHITE,
]

/** lazygit's `default` foreground/background values, resolved by the terminal. */
export const DEFAULT_FOREGROUND = RGBA.defaultForeground()
export const DEFAULT_BACKGROUND = RGBA.defaultBackground()

/** lazygit's selected-line background: `SelectedLineBgColor: []string{"blue"}`. */
export const SELECTED_LINE_BG = ANSI_BLUE

/** lazygit's active border color: `ActiveBorderColor: []string{"green", "bold"}`. */
export const TAB_ACTIVE_FG = ANSI_GREEN
export const TAB_ACTIVE_BOLD = true

/** Tab separator inside a pane title: `separator := " - "` — pkg/gocui/gui.go:1421. */
export const TAB_SEPARATOR = " - "

/** Appended to the `[key]` title prefix: the view's first frame rune, `─` by default. */
export const TITLE_PREFIX_FRAME_RUNE = "─"

/** lazygit's `style.FgBlue` reflog hash. */
export const REFLOG_HASH_FG = ANSI_BLUE

/** lazygit's branch recency and status colors. */
export const BRANCH_RECENCY_FG = ANSI_CYAN
export const BRANCH_RECENCY_CURRENT_FG = ANSI_GREEN
export const BRANCH_ITEM_OPERATION_FG = ANSI_CYAN
export const BRANCH_UPSTREAM_GONE_FG = ANSI_RED
export const BRANCH_MATCHES_UPSTREAM_FG = ANSI_GREEN
export const BRANCH_UPSTREAM_NOT_LOCAL_FG = ANSI_MAGENTA
export const BRANCH_DIVERGED_FG = ANSI_YELLOW

/** lazygit's pull-request state colors are explicit RGB values, not ANSI names. */
export const PR_OPEN_FG = RGBA.fromInts(0x43, 0x84, 0x40)
export const PR_CLOSED_FG = RGBA.fromInts(0xc9, 0x45, 0x3c)
export const PR_MERGED_FG = RGBA.fromInts(0x82, 0x59, 0xdd)
export const PR_DRAFT_FG = RGBA.fromInts(0x67, 0x6c, 0x75)

/** lazygit's checks-state presentation uses ANSI names. */
export const PR_CHECKS_PASSING_FG = ANSI_GREEN
export const PR_CHECKS_PENDING_FG = ANSI_YELLOW
export const PR_CHECKS_FAILING_FG = ANSI_RED

/** lazygit's file/worktree/submodule presentation colors. */
export const FILE_STAGED_FG = ANSI_GREEN
export const FILE_MIXED_FG = ANSI_YELLOW
export const UNSTAGED_CHANGES_FG = ANSI_RED
export const WORKTREE_CURRENT_FG = ANSI_GREEN
export const WORKTREE_INACTIVE_MARKER_FG = ANSI_CYAN
export const WORKTREE_MISSING_FG = ANSI_RED
export const WORKTREE_BRANCH_FG = ANSI_CYAN
export const WORKTREE_DETACHED_FG = ANSI_YELLOW
export const SUBMODULE_NAME_FG = ANSI_GREEN
export const SUBMODULE_PATH_FG = ANSI_YELLOW
export const SUBMODULE_URL_FG = ANSI_CYAN

/**
 * Mirrors lazygit's highlighted-line rule in `pkg/gocui/view.go:675-685`: only base ANSI indices
 * become bright; RGB and terminal-default values are left untouched. The caller adds bold.
 */
export function brightenAnsiForeground(color: RGBA): RGBA {
  if (color.intent !== "indexed" || color.slot < 0 || color.slot > 7) return color
  return indexed(color.slot + 8)
}
