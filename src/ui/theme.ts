import { RGBA, type ColorInput } from "@opentui/core"

export type TerminalPaletteSnapshot = {
  readonly palette?: readonly (string | null)[]
  readonly defaultForeground?: string | null
  readonly defaultBackground?: string | null
}

/**
 * Fallback values for a terminal that cannot answer OpenTUI's palette query. These are Ghostty's
 * built-in defaults in the development environment; terminals that answer the query replace them
 * before the first application render. The RGBA values still retain indexed/default intent.
 */
const FALLBACK_ANSI_PALETTE: readonly string[] = [
  "#1d1f21",
  "#cc6666",
  "#b5bd68",
  "#f0c674",
  "#81a2be",
  "#b294bb",
  "#8abeb7",
  "#c5c8c6",
  "#666666",
  "#d54e53",
  "#b9ca4a",
  "#e7c547",
  "#7aa6da",
  "#c397d8",
  "#70c0b1",
  "#eaeaea",
]
const FALLBACK_DEFAULT_FOREGROUND = "#ffffff"
const FALLBACK_DEFAULT_BACKGROUND = "#282c34"

let terminalPalette: readonly (string | null)[] = []
let defaultForegroundFallback = FALLBACK_DEFAULT_FOREGROUND
let defaultBackgroundFallback = FALLBACK_DEFAULT_BACKGROUND

function fallbackForIndexedSlot(slot: number): string | undefined {
  return terminalPalette[slot] ?? FALLBACK_ANSI_PALETTE[slot]
}

function indexed(slot: number): RGBA {
  return RGBA.fromIndex(slot, fallbackForIndexedSlot(slot))
}

function copyRgbFallback(target: RGBA, source: ColorInput): void {
  const resolved = typeof source === "string" ? RGBA.fromHex(source) : source
  for (let index = 0; index < target.buffer.length; index++) {
    target.buffer[index] = (target.buffer[index]! & 0xff00) | (resolved.buffer[index]! & 0xff)
  }
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

/** lazygit's `default` foreground/background values, resolved by the terminal. */
export const DEFAULT_FOREGROUND = RGBA.defaultForeground(defaultForegroundFallback)
export const DEFAULT_BACKGROUND = RGBA.defaultBackground(defaultBackgroundFallback)

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

/** Creates an indexed ANSI color using the current terminal palette fallback. */
export function indexedColor(slot: number): RGBA {
  return indexed(slot)
}

/**
 * Updates fallback RGB values from OpenTUI's terminal palette query without changing color intent.
 * This matters when the native renderer must fall back to RGB while lazygit would emit an ANSI
 * index; both then resolve to the same terminal palette color.
 */
export function configureTerminalPalette(snapshot: TerminalPaletteSnapshot): void {
  terminalPalette = snapshot.palette ?? []
  defaultForegroundFallback = snapshot.defaultForeground ?? FALLBACK_DEFAULT_FOREGROUND
  defaultBackgroundFallback = snapshot.defaultBackground ?? FALLBACK_DEFAULT_BACKGROUND

  const ansiTokens = [
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
  for (let index = 0; index < ansiTokens.length; index++) {
    const fallback = fallbackForIndexedSlot(index)
    if (fallback !== undefined) copyRgbFallback(ansiTokens[index]!, fallback)
  }
  copyRgbFallback(DEFAULT_FOREGROUND, defaultForegroundFallback)
  copyRgbFallback(DEFAULT_BACKGROUND, defaultBackgroundFallback)
}

/**
 * Mirrors lazygit's highlighted-line rule in `pkg/gocui/view.go:675-685`: only base ANSI indices
 * become bright; RGB and terminal-default values are left untouched. The caller adds bold.
 */
export function brightenAnsiForeground(color: RGBA): RGBA {
  if (color.intent !== "indexed" || color.slot < 0 || color.slot > 7) return color
  return [
    ANSI_BRIGHT_BLACK,
    ANSI_BRIGHT_RED,
    ANSI_BRIGHT_GREEN,
    ANSI_BRIGHT_YELLOW,
    ANSI_BRIGHT_BLUE,
    ANSI_BRIGHT_MAGENTA,
    ANSI_BRIGHT_CYAN,
    ANSI_BRIGHT_WHITE,
  ][color.slot]!
}
