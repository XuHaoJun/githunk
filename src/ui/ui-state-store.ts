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
    // `Gui.ShowCommandLog: true` (pkg/config/user_config.go:901). A persisted `false` still wins,
    // which is lazygit's `HideCommandLog` app-state flag (pkg/gui/gui.go:523).
    commandLogVisible: true,
  }
}

/**
 * On-disk schema version. Bumped from 1 -> 2 when persistence switched from the positive
 * `commandLogVisible` to the negative `commandLogHidden`, mirroring lazygit's on-disk
 * `AppState.HideCommandLog bool` (pkg/config/app_config.go:858) rather than the in-memory
 * `gui.ShowExtrasWindow` (pkg/gui/gui.go:190) it is inverted from at the boundary
 * (gui.go:523, extras_panel.go:26). `getDefaultAppState()` returns a bare `&AppState{}`
 * (app_config.go:861-862), so an absent/older app state reads back `HideCommandLog: false` ->
 * shown; version 2 reproduces that by making `commandLogHidden`'s *absence* (i.e. a version-1
 * file) the migration trigger, rather than defaulting a field that isn't there.
 */
const CURRENT_VERSION = 2

type RawRecord = Record<string, unknown>

function isValidSidePanelRatio(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 && value < 1
}

function isValidCommandLogHeight(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= MIN_LOG_HEIGHT
}

/** Version 2: the current shape, `commandLogHidden` persisted per app_config.go:858. */
function parseCurrent(candidate: RawRecord): UiState | undefined {
  if (
    !isValidSidePanelRatio(candidate.sidePanelRatio) ||
    !isValidCommandLogHeight(candidate.commandLogHeight) ||
    typeof candidate.commandLogHidden !== "boolean"
  ) return undefined
  return {
    sidePanelRatio: candidate.sidePanelRatio,
    commandLogHeight: candidate.commandLogHeight,
    commandLogVisible: !candidate.commandLogHidden,
  }
}

/**
 * Version 1: predates both the positive->negative inversion and the Task 10 default flip
 * (command log now shown by default). Its `commandLogVisible`/`commandLogHeight` are
 * untrustworthy: a persisted `commandLogVisible: false` is indistinguishable from "the old
 * default, never touched" (the old default *was* false), and a persisted `commandLogHeight: 8`
 * is indistinguishable from "the old default total" vs. a deliberately dragged 8. Only
 * `sidePanelRatio` survives migration: its meaning never changed, and discarding a value the
 * owner dragged (e.g. 0.3399...) would be a real, avoidable regression.
 */
function parseLegacy(candidate: RawRecord): UiState | undefined {
  if (!isValidSidePanelRatio(candidate.sidePanelRatio)) return undefined
  return { ...defaultUiState(), sidePanelRatio: candidate.sidePanelRatio }
}

function parseUiState(value: unknown): UiState | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined
  const candidate = value as RawRecord
  if (candidate.version === CURRENT_VERSION) return parseCurrent(candidate)
  if (candidate.version === 1) return parseLegacy(candidate)
  return undefined
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
      return parseUiState(parsed) ?? defaultUiState()
    } catch {
      return defaultUiState()
    }
  }

  /**
   * Geometry is a convenience, never correctness: a failed write is swallowed.
   * Persists `commandLogHidden` (inverted from the in-memory `commandLogVisible`), the same
   * boundary lazygit draws between `gui.ShowExtrasWindow` and `AppState.HideCommandLog`
   * (extras_panel.go:26: `HideCommandLog = !show`).
   */
  async save(state: UiState): Promise<void> {
    try {
      const record = {
        version: CURRENT_VERSION,
        sidePanelRatio: state.sidePanelRatio,
        commandLogHeight: state.commandLogHeight,
        commandLogHidden: !state.commandLogVisible,
      }
      await this.file.writeText(`${JSON.stringify(record)}\n`)
    } catch {
      // Losing a remembered pane width must never interrupt a review.
    }
  }
}
