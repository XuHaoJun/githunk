import type { AppModel } from "../app/model"
import type { FocusId } from "./focus"
import type { ScreenMode, SideWindow } from "./layout"
import { normalizeKey, type KeyLike, type KeyStroke } from "./keymap"

export const ACTIONS = [
  // focus and layout
  "focus-main", "focus-status", "focus-files", "focus-branches", "focus-commits", "focus-stash",
  "command-log", "pane-next", "pane-previous",
  "screen-mode-next", "screen-mode-previous", "keybinding-menu",
  // list and document navigation
  "next", "previous", "toggle-range-select", "range-select-up", "range-select-down", "page-next", "page-previous", "goto-top", "goto-bottom",
  "main-scroll-down", "main-scroll-up", "main-scroll-left", "main-scroll-right",
  "hunk-next", "hunk-previous", "tab-next", "tab-previous", "scope-next", "scope-previous",
  // review targets
  "open-branch-review", "mark-reviewed",
  // working tree
  "stage-file", "discard-file", "stage-all", "stage-selection", "discard-selection", "edit-file",
  // file tree
  "toggle-file-tree", "collapse-files", "expand-files",
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
  // search (lazygit's n/N for ISearchable contexts, pkg/gocui/gui.go:303)
  "search-next", "search-previous",
] as const
export type Action = (typeof ACTIONS)[number]

export type BindingContext = FocusId | "global" | "modal"

export type UiState = {
  readonly focus: FocusId
  readonly currentSideWindow?: SideWindow
  readonly screenMode: ScreenMode
  readonly modal: boolean
  readonly mainScope: "all" | "staged" | "unstaged" | undefined
  readonly selectedBranchKind: "local" | "remote" | "remote-branch" | undefined
  /** Which of panel 4's tabs is active; `undefined` behaves as the Commits tab. */
  readonly commitsTab?: "commits" | "reflog"
  /** Which of panel 2's tabs is active; `undefined` behaves as the Files tab. */
  readonly filesTab?: "files" | "worktrees" | "submodules"
  /** Whether the stash pane currently has an entry selected. */
  readonly hasSelectedStash: boolean
  /** Whether the Files pane has a file row selected (as opposed to a directory or empty). */
  readonly hasSelectedFile?: boolean
  /** Whether the main pane is showing a diff document that can be edited. */
  readonly hasMainDocument?: boolean
  /** Whether the Commits pane is drilled into commit files with a file selected. */
  readonly hasSelectedCommitFile?: boolean
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

export type ResolveOptions = {
  readonly context?: BindingContext
  readonly modal?: boolean
  /** Supplying both `model` and `ui` enables availability filtering during resolution. */
  readonly model?: AppModel
  readonly ui?: UiState
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

  resolve(key: KeyLike, options: ResolveOptions = {}): Binding | undefined {
    const id = strokeId(normalizeKey(key))
    const hasAvailability = options.model !== undefined && options.ui !== undefined
    // Skip a binding whose `available` predicate returns false, rather than matching it, so
    // resolution can continue to the next priority level. Without model/ui we can't evaluate
    // `available`, so behave exactly as before: no filtering.
    const admit = (binding: Binding | undefined): Binding | undefined =>
      binding !== undefined && hasAvailability && !isAvailable(binding, options.model as AppModel, options.ui as UiState)
        ? undefined
        : binding

    // A modal is a hard input boundary: it never falls through to pane or global bindings,
    // even when the matched binding itself is unavailable.
    if (options.modal === true) return admit(this.byContext.get("modal")?.get(id))

    const context = options.context
    const focused = context === undefined ? undefined : this.byContext.get(context)?.get(id)
    const admittedFocused = admit(focused)
    if (admittedFocused !== undefined) return admittedFocused
    // Fall through to the global binding for the same key when the context binding is missing
    // or unavailable. Motivating case: `escape` is declared as `commit-back` in the main, files
    // and commits contexts (available only while reviewing a commit) and as `back` globally.
    // Without this fall-through, `back` — which clears a pending discard/delete confirmation —
    // would be permanently shadowed by the unavailable `commit-back` binding in those contexts.
    return admit(this.byContext.get("global")?.get(id))
  }

  dispatch(key: KeyLike, options: ResolveOptions = {}): Action | undefined {
    return this.resolve(key, options)?.action
  }

  /**
   * The single precedence-and-availability rule shared by `hintsFor` and `menuFor`, so the two
   * display surfaces can never disagree with each other (or with `resolve`) about which binding
   * governs a key. Candidates are ordered as the context's own bindings (declaration order),
   * then the global bindings (declaration order) — the same priority `resolve` applies. A
   * candidate is `enabled` per its own `available` predicate, and `superseded` when an earlier,
   * `enabled` candidate in that order already claims one of its keys — mirroring the fall-through
   * in `resolve`, where an unavailable binding is skipped rather than shadowing the next one.
   */
  private candidatesFor(
    context: BindingContext,
    model: AppModel,
    ui: UiState,
  ): readonly { readonly binding: Binding; readonly group: "context" | "global"; readonly enabled: boolean; readonly superseded: boolean }[] {
    const contextBindings = this.bindings.filter((binding) => (binding.contexts ?? []).includes(context))
    const globalBindings = this.bindings.filter((binding) => binding.contexts === undefined)
    const ordered = [
      ...contextBindings.map((binding) => ({ binding, group: "context" as const })),
      ...globalBindings.map((binding) => ({ binding, group: "global" as const })),
    ]

    const claimedByEnabled = new Set<string>()
    return ordered.map(({ binding, group }) => {
      const keys = binding.keys.map((key) => strokeId(normalizeKey(key)))
      const superseded = keys.some((key) => claimedByEnabled.has(key))
      const enabled = isAvailable(binding, model, ui)
      if (enabled) for (const key of keys) claimedByEnabled.add(key)
      return { binding, group, enabled, superseded }
    })
  }

  /** The bindings the hints bar renders for a context, in display order, as structured data. */
  hintRowsFor(context: BindingContext, model: AppModel, ui: UiState): readonly Binding[] {
    return this.candidatesFor(context, model, ui)
      .filter(({ binding, enabled, superseded }) => binding.displayOnScreen === true && enabled && !superseded)
      .map(({ binding }) => binding)
  }

  hintsFor(context: BindingContext, model: AppModel, ui: UiState, width: number): string {
    const entries = this.hintRowsFor(context, model, ui).map((binding) => ({ description: binding.description, key: displayKeyFor(binding) }))
    return formatHints(entries, width)
  }

  menuFor(context: BindingContext, model: AppModel, ui: UiState): readonly MenuEntry[] {
    return this.candidatesFor(context, model, ui)
      .filter(({ superseded }) => !superseded)
      .map(({ binding, group, enabled }) => ({
        group,
        keys: displayKeyFor(binding),
        description: binding.menuDescription ?? binding.description,
        enabled,
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
const branchRangeSelection = (_model: AppModel, ui: UiState): boolean =>
  ui.selectedBranchKind === "local" || ui.selectedBranchKind === "remote-branch"


/**
 * Only panel 4's Commits tab drills into commit files. lazygit attaches
 * `SwitchToDiffFilesController` (the GoInto -> commit files binding) to LocalCommits, SubCommits
 * and Stash only; the reflog context instead gets `SwitchToSubCommitsController`
 * (pkg/gui/controllers.go:229-249), a panel githunk has no equivalent for.
 */
const onCommitsTab = (_model: AppModel, ui: UiState): boolean => (ui.commitsTab ?? "commits") === "commits"

/**
 * Panel 2's Worktrees and Submodules tabs are navigation-only here, and in lazygit they are
 * separate contexts with their own bindings — none of the working-tree or file-tree actions
 * reaches them (pkg/gui/controllers.go attaches FilesController to the Files context alone).
 */
const onFilesTab = (_model: AppModel, ui: UiState): boolean => (ui.filesTab ?? "files") === "files"

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
  // `Tr.OpenCommandLogMenu` (pkg/i18n/english.go:1853) behind Universal.ExtrasMenu, default "@"
  // (pkg/config/user_config.go:1072, pkg/gui/keybindings.go:171-174).
  { keys: ["@"], action: "command-log", description: "log", menuDescription: "view command log options" },
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
  // `<pgup>`/`<pgdown>`, `K`/`J` and `<ctrl+u>`/`<ctrl+d>` are one binding in lazygit —
  // `scrollUpMain`/`scrollDownMain` with `scrollUpMain-alt1`/`-alt2` merged into it
  // (pkg/config/user_config.go:1047-1052, pkg/gui/keybindings.go:87-100) — so they scroll the same
  // `gui.scrollHeight` lines rather than one of them meaning "half a page".
  { keys: ["J", "pagedown", "ctrl+d"], action: "main-scroll-down", description: "scroll main down" },
  { keys: ["K", "pageup", "ctrl+u"], action: "main-scroll-up", description: "scroll main up" },
  { keys: ["L"], action: "main-scroll-right", description: "scroll main right" },
  { keys: ["H"], action: "main-scroll-left", description: "scroll main left" },

  // ---- review targets ----
  { keys: ["b"], action: "open-branch-review", description: "branch review", displayOnScreen: true },

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
  { keys: ["space"], action: "stage-selection", description: "stage", contexts: ["main"], displayOnScreen: true, available: lineActions, menuDescription: "stage the selected lines" },
  { keys: ["d"], action: "discard-selection", description: "discard", contexts: ["main"], displayOnScreen: true, available: (model, ui) => lineActions(model, ui) && ui.mainScope !== "staged", menuDescription: "discard the selected lines" },
  { keys: ["e"], action: "edit-file", description: "edit", contexts: ["main"], displayOnScreen: true, available: (_model, ui) => ui.hasMainDocument === true, menuDescription: "open the file in an external editor, at the selected hunk" },
  { keys: ["j", "down"], action: "next", description: "down", contexts: ["main"] },
  { keys: ["k", "up"], action: "previous", description: "up", contexts: ["main"] },
  { keys: ["v"], action: "toggle-range-select", description: "range", contexts: ["main"], available: (_model, ui) => ui.hasMainDocument === true },
  { keys: ["shift+up"], action: "range-select-up", description: "range up", contexts: ["main"], displayKeys: "shift+up", available: (_model, ui) => ui.hasMainDocument === true },
  { keys: ["shift+down"], action: "range-select-down", description: "range down", contexts: ["main"], displayKeys: "shift+down", available: (_model, ui) => ui.hasMainDocument === true },
  { keys: ["escape"], action: "commit-back", description: "back", contexts: ["main"], available: inCommit },
  // The working-tree scope ring (all → staged → unstaged) is githunk's PRD §8.1 review-target
  // selector; Main is the only context whose `[`/`]` are free, since side windows use them for tabs.
  { keys: ["]"], action: "scope-next", description: "next scope", contexts: ["main"], displayOnScreen: true, available: writable, menuDescription: "cycle the working-tree scope: all, staged, unstaged" },
  { keys: ["["], action: "scope-previous", description: "previous scope", contexts: ["main"], available: writable },

  // Side-pane mutations consume the inclusive stable-id range when one is active; singular
  // callbacks remain the fallback for an unselected range.
  { keys: ["space"], action: "stage-file", description: "stage", contexts: ["files"], displayOnScreen: true, available: (model, ui) => writable(model) && onFilesTab(model, ui), menuDescription: "stage or unstage the selected files or directory" },
  { keys: ["d"], action: "discard-file", description: "discard", contexts: ["files"], displayOnScreen: true, available: (model, ui) => writable(model) && onFilesTab(model, ui), menuDescription: "discard the selected files' (or directory's) changes" },
  { keys: ["a"], action: "stage-all", description: "all", contexts: ["files"], displayOnScreen: true, available: (model, ui) => writable(model) && onFilesTab(model, ui), menuDescription: "stage or unstage every file" },
  { keys: ["e"], action: "edit-file", description: "edit", contexts: ["files"], displayOnScreen: true, available: onFilesTab, menuDescription: "open the file in an external editor" },
  { keys: ["r"], action: "mark-reviewed", description: "reviewed", contexts: ["files"], displayOnScreen: true, available: onFilesTab, menuDescription: "mark the file reviewed" },
  { keys: ["enter"], action: "inspect", description: "open", contexts: ["files"], displayOnScreen: true, menuDescription: "open the file in the main pane, or collapse a directory" },
  // pkg/config/user_config.go:1100-1106 — ToggleTreeView, CollapseAll, ExpandAll.
  { keys: ["`"], action: "toggle-file-tree", description: "tree view", contexts: ["files"], available: onFilesTab, menuDescription: "toggle between the file tree and a flat list" },
  { keys: ["-"], action: "collapse-files", description: "collapse all", contexts: ["files"], available: onFilesTab, menuDescription: "collapse every directory in the file tree" },
  { keys: ["v"], action: "toggle-range-select", description: "range", contexts: ["files"], available: onFilesTab },
  { keys: ["shift+up"], action: "range-select-up", description: "range up", contexts: ["files"], displayKeys: "shift+up", available: onFilesTab },
  { keys: ["shift+down"], action: "range-select-down", description: "range down", contexts: ["files"], displayKeys: "shift+down", available: onFilesTab },
  { keys: ["v"], action: "toggle-range-select", description: "range", contexts: ["commits", "stash"] },
  { keys: ["v"], action: "toggle-range-select", description: "range", contexts: ["branches"], available: branchRangeSelection },
  { keys: ["shift+up"], action: "range-select-up", description: "range up", contexts: ["commits", "stash"], displayKeys: "shift+up" },
  { keys: ["shift+up"], action: "range-select-up", description: "range up", contexts: ["branches"], displayKeys: "shift+up", available: branchRangeSelection },
  { keys: ["shift+down"], action: "range-select-down", description: "range down", contexts: ["commits", "stash"], displayKeys: "shift+down" },
  { keys: ["shift+down"], action: "range-select-down", description: "range down", contexts: ["branches"], displayKeys: "shift+down", available: branchRangeSelection },
  { keys: ["="], action: "expand-files", description: "expand all", contexts: ["files"], available: onFilesTab, menuDescription: "expand every directory in the file tree" },
  { keys: ["j", "down"], action: "next", description: "down", contexts: ["files"] },
  { keys: ["k", "up"], action: "previous", description: "up", contexts: ["files"] },
  { keys: ["escape"], action: "commit-back", description: "back", contexts: ["files"], available: inCommit },

  // ---- branches pane ----
  { keys: ["n"], action: "branch-create", description: "new", contexts: ["branches"], displayOnScreen: true, available: (_model, ui) => ui.selectedBranchKind === "local" || ui.selectedBranchKind === "remote-branch" },
  { keys: ["space"], action: "branch-checkout", description: "checkout", contexts: ["branches"], displayOnScreen: true, menuDescription: "switch to the branch, creating a local tracking branch if needed" },
  { keys: ["d"], action: "branch-delete", description: "delete", contexts: ["branches"], displayOnScreen: true, available: (_model, ui) => ui.selectedBranchKind === "local" || ui.selectedBranchKind === "remote-branch", menuDescription: "open branch delete options for the selected branch or range" },
  { keys: ["r"], action: "branch-rename", description: "rename", contexts: ["branches"], displayOnScreen: true, available: (_model, ui) => ui.selectedBranchKind === "local" },
  { keys: ["f"], action: "fetch-remote", description: "fetch", contexts: ["branches"], displayOnScreen: true, available: (_model, ui) => ui.selectedBranchKind === "remote", menuDescription: "fetch the selected remote" },
  { keys: ["enter"], action: "inspect", description: "view commits", contexts: ["branches"], displayOnScreen: true, menuDescription: "view commits" },
  { keys: ["/"], action: "filter", description: "filter", contexts: ["branches"], displayOnScreen: true },
  { keys: ["/"], action: "filter", description: "filter", contexts: ["files"], displayOnScreen: true },
  { keys: ["/"], action: "filter", description: "filter", contexts: ["stash"], displayOnScreen: true },
  { keys: ["/"], action: "filter", description: "filter", contexts: ["commits"], displayOnScreen: true },
  { keys: ["/"], action: "filter", description: "filter", contexts: ["main"], displayOnScreen: true },
  // Lazygit's Next/Prev match for searchable contexts (pkg/gocui/gui.go:303, pkg/gui/types/context.go:147)
  { keys: ["n"], action: "search-next", description: "next match", contexts: ["commits", "main"] },
  { keys: ["N"], action: "search-previous", description: "previous match", contexts: ["commits", "main"] },
  { keys: ["]"], action: "tab-next", description: "next tab", contexts: ["files", "branches", "commits"], displayOnScreen: true, menuDescription: "next tab" },
  { keys: ["["], action: "tab-previous", description: "previous tab", contexts: ["files", "branches", "commits"], displayOnScreen: true, menuDescription: "previous tab" },
  { keys: ["j", "down"], action: "next", description: "down", contexts: ["branches"] },
  { keys: ["k", "up"], action: "previous", description: "up", contexts: ["branches"] },

  // ---- commits pane ----
  { keys: ["e"], action: "edit-file", description: "edit", contexts: ["commits"], displayOnScreen: true, available: (_model, ui) => ui.hasSelectedCommitFile === true, menuDescription: "open the file in an external editor" },
  { keys: ["enter"], action: "commit-drilldown", description: "inspect", contexts: ["commits"], displayOnScreen: true, available: onCommitsTab, menuDescription: "inspect this commit on its own" },
  { keys: ["escape"], action: "commit-back", description: "back", contexts: ["commits"], displayOnScreen: true, available: inCommit },
  { keys: ["j", "down"], action: "next", description: "down", contexts: ["commits"] },
  { keys: ["k", "up"], action: "previous", description: "up", contexts: ["commits"] },

  // ---- stash pane ----
  { keys: ["space"], action: "stash-apply", description: "apply", contexts: ["stash"], displayOnScreen: true, available: stashOperation },
  { keys: ["g"], action: "stash-pop", description: "pop", contexts: ["stash"], displayOnScreen: true, available: stashOperation },
  { keys: ["d"], action: "stash-drop", description: "drop", contexts: ["stash"], displayOnScreen: true, available: stashOperation, menuDescription: "drop the selected stash entry or range" },
  { keys: ["enter"], action: "stash-inspect", description: "inspect", contexts: ["stash"], displayOnScreen: true, available: stashOperation },
  { keys: ["j", "down"], action: "next", description: "down", contexts: ["stash"] },
  { keys: ["k", "up"], action: "previous", description: "up", contexts: ["stash"] },

  // ---- command log ----
  // lazygit binds these on the extras view (pkg/gui/keybindings.go:249-295). They duplicate the
  // global entries above so that the handler can apply lazygit's autoscroll transition, which
  // differs per key: every scroll clears the flag except goto-bottom, which sets it
  // (pkg/gui/extras_panel.go:49,57,65,73,81,89).
  { keys: ["j", "down"], action: "next", description: "down", contexts: ["command-log"] },
  { keys: ["k", "up"], action: "previous", description: "up", contexts: ["command-log"] },
  { keys: ["."], action: "page-next", description: "page down", contexts: ["command-log"] },
  { keys: [","], action: "page-previous", description: "page up", contexts: ["command-log"] },
  { keys: [">", "end"], action: "goto-bottom", description: "go to bottom", contexts: ["command-log"] },
  { keys: ["<", "home"], action: "goto-top", description: "go to top", contexts: ["command-log"] },

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
