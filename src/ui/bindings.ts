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

const writable = (model: AppModel): boolean => model.reviewTarget.kind === "working-tree"
const lineActions = (model: AppModel, ui: UiState): boolean => writable(model) && ui.mainScope !== "all"
const inCommit = (model: AppModel): boolean => model.reviewTarget.kind === "commit"

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
  { keys: ["space"], action: "stash-apply", description: "apply", contexts: ["stash"], displayOnScreen: true, available: writable },
  { keys: ["g"], action: "stash-pop", description: "pop", contexts: ["stash"], displayOnScreen: true, available: writable },
  { keys: ["d"], action: "stash-drop", description: "drop", contexts: ["stash"], displayOnScreen: true, available: writable },
  { keys: ["enter"], action: "stash-inspect", description: "inspect", contexts: ["stash"], displayOnScreen: true },
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
