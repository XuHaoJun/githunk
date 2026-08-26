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
