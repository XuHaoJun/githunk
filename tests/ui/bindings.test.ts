import { describe, expect, test } from "bun:test"
import {
  ACTIONS,
  BindingRegistry,
  GITHUNK_BINDINGS,
  assertHandlersCover,
  createRegistry,
  formatHints,
  type Binding,
  type BindingContext,
  type UiState,
} from "../../src/ui/bindings"
import { normalizeKey } from "../../src/ui/keymap"
import type { AppModel } from "../../src/app/model"

function model(overrides: Partial<AppModel> = {}): AppModel {
  return {
    repositoryRoot: "/tmp/repo",
    branch: "feature",
    reviewTarget: { kind: "working-tree", scope: "unstaged" },
    files: [],
    patches: [],
    rawPatchSections: [],
    reviewStatuses: {},
    reviewSummary: { reviewed: 0, invalidated: 0, commits: 0, files: 0, additions: 0, deletions: 0 },
    loading: false,
    commandLog: [],
    title: "Working Tree — Unstaged",
    commits: [],
    ...overrides,
  } as AppModel
}

function ui(overrides: Partial<UiState> = {}): UiState {
  return {
    focus: "files",
    screenMode: "normal",
    modal: false,
    mainScope: "unstaged",
    selectedBranchKind: undefined,
    hasSelectedStash: false,
    ...overrides,
  }
}

describe("formatHints", () => {
  test("renders description then key, joined by a pipe", () => {
    expect(formatHints([
      { description: "stage", key: "space" },
      { description: "reviewed", key: "r" },
    ], 80)).toBe("stage: space | reviewed: r")
  })

  test("truncates with an ellipsis rather than overflowing", () => {
    const rendered = formatHints([
      { description: "stage", key: "space" },
      { description: "reviewed", key: "r" },
      { description: "discard", key: "d" },
    ], 20)
    expect(rendered).toBe("stage: space | …")
    expect(rendered.length).toBeLessThanOrEqual(20)
  })

  test("keeps the first entry even when it alone exceeds the width", () => {
    expect(formatHints([{ description: "a-very-long-description", key: "x" }], 5))
      .toBe("a-very-long-description: x")
  })

  test("renders nothing for no entries", () => {
    expect(formatHints([], 80)).toBe("")
  })
})

describe("BindingRegistry validation", () => {
  test("rejects two bindings sharing a keystroke in one context", () => {
    expect(() => new BindingRegistry([
      { keys: ["x"], action: "quit", description: "one" },
      { keys: ["x"], action: "refresh", description: "two" },
    ])).toThrow(/collision/i)
  })

  test("treats a physical uppercase name as shift plus the lowercase key", () => {
    expect(() => new BindingRegistry([
      { keys: ["X"], action: "quit", description: "one" },
      { keys: ["shift+x"], action: "refresh", description: "two" },
    ])).toThrow(/collision/i)
  })

  test("allows the same keystroke in different contexts", () => {
    expect(() => new BindingRegistry([
      { keys: ["d"], action: "discard-file", description: "discard", contexts: ["files"] },
      { keys: ["d"], action: "stash-drop", description: "drop", contexts: ["stash"] },
    ])).not.toThrow()
  })

  test("rejects a binding with an empty description", () => {
    expect(() => new BindingRegistry([
      { keys: ["x"], action: "quit", description: "" },
    ])).toThrow(/description/i)
  })

  test("rejects an action outside the declared action list", () => {
    expect(() => new BindingRegistry([
      { keys: ["x"], action: "not-a-real-action" as Binding["action"], description: "nope" },
    ])).toThrow(/action/i)
  })
})

describe("BindingRegistry resolution", () => {
  const registry = new BindingRegistry([
    { keys: ["escape"], action: "back", description: "back" },
    { keys: ["escape"], action: "commit-back", description: "back", contexts: ["commits"] },
    { keys: ["escape"], action: "modal-cancel", description: "cancel", contexts: ["modal"] },
    { keys: ["h", "left"], action: "pane-previous", description: "pane" },
  ])

  test("prefers modal over context over global", () => {
    expect(registry.dispatch({ name: "escape" }, { context: "commits", modal: true })).toBe("modal-cancel")
    expect(registry.dispatch({ name: "escape" }, { context: "commits" })).toBe("commit-back")
    expect(registry.dispatch({ name: "escape" }, { context: "files" })).toBe("back")
  })

  test("does not fall through to global bindings while a modal is open", () => {
    expect(registry.dispatch({ name: "h" }, { context: "files", modal: true })).toBeUndefined()
  })

  test("matches every declared alias for a binding", () => {
    expect(registry.dispatch({ name: "h" })).toBe("pane-previous")
    expect(registry.dispatch({ name: "left" })).toBe("pane-previous")
  })
})

describe("BindingRegistry availability-aware resolution", () => {
  const registry = createRegistry()
  const workingTree = model({ reviewTarget: { kind: "working-tree", scope: "unstaged" } })
  const commit = model({ reviewTarget: { kind: "commit", oid: "abc123" } })

  test("escape in main falls through to back when not reviewing a commit", () => {
    expect(registry.dispatch({ name: "escape" }, { context: "main", model: workingTree, ui: ui() })).toBe("back")
  })

  test("escape in main resolves to commit-back when reviewing a commit", () => {
    expect(registry.dispatch({ name: "escape" }, { context: "main", model: commit, ui: ui() })).toBe("commit-back")
  })

  test("escape in files falls through to back when not reviewing a commit, and to commit-back when it is", () => {
    expect(registry.dispatch({ name: "escape" }, { context: "files", model: workingTree, ui: ui() })).toBe("back")
    expect(registry.dispatch({ name: "escape" }, { context: "files", model: commit, ui: ui() })).toBe("commit-back")
  })

  test("escape in commits falls through to back when not reviewing a commit, and to commit-back when it is", () => {
    expect(registry.dispatch({ name: "escape" }, { context: "commits", model: workingTree, ui: ui() })).toBe("back")
    expect(registry.dispatch({ name: "escape" }, { context: "commits", model: commit, ui: ui() })).toBe("commit-back")
  })
  test("bracket keys cycle the working-tree scope in main but switch tabs in side windows", () => {
    expect(registry.dispatch({ name: "]" }, { context: "main", model: workingTree, ui: ui() })).toBe("scope-next")
    expect(registry.dispatch({ name: "[" }, { context: "main", model: workingTree, ui: ui() })).toBe("scope-previous")
    expect(registry.dispatch({ name: "]" }, { context: "files", model: workingTree, ui: ui() })).toBe("tab-next")
  })

  test("resolves to undefined when the only binding for a key is unavailable", () => {
    const onlyUnavailable = new BindingRegistry([
      { keys: ["x"], action: "quit", description: "quit", contexts: ["files"], available: () => false },
    ])
    expect(onlyUnavailable.dispatch({ name: "x" }, { context: "files", model: workingTree, ui: ui() })).toBeUndefined()
  })

  test("an unavailable modal binding resolves to undefined without falling through", () => {
    const modalBoundary = new BindingRegistry([
      { keys: ["x"], action: "quit", description: "quit", contexts: ["modal"], available: () => false },
      { keys: ["x"], action: "refresh", description: "refresh", contexts: ["files"] },
      { keys: ["x"], action: "back", description: "back" },
    ])
    expect(modalBoundary.dispatch({ name: "x" }, { context: "files", modal: true, model: workingTree, ui: ui() })).toBeUndefined()
  })

  test("omitting model and ui resolves the context binding regardless of availability", () => {
    expect(registry.dispatch({ name: "escape" }, { context: "main" })).toBe("commit-back")
    expect(registry.dispatch({ name: "escape" }, { context: "files" })).toBe("commit-back")
    expect(registry.dispatch({ name: "escape" }, { context: "commits" })).toBe("commit-back")
  })
})

describe("BindingRegistry hints", () => {
  const registry = new BindingRegistry([
    { keys: ["space"], action: "stage-file", description: "stage", contexts: ["files"], displayOnScreen: true },
    { keys: ["r"], action: "mark-reviewed", description: "reviewed", contexts: ["files"], displayOnScreen: true },
    { keys: ["d"], action: "discard-file", description: "discard", contexts: ["files"], displayOnScreen: true, available: (m) => m.reviewTarget.kind === "working-tree" },
    { keys: ["enter"], action: "inspect", description: "open", contexts: ["files"] },
    { keys: ["l", "right"], action: "pane-next", description: "pane", displayKeys: "h/l", displayOnScreen: true },
    { keys: ["q"], action: "quit", description: "quit" },
  ])

  test("includes only bindings marked for the screen", () => {
    const hints = registry.hintsFor("files", model(), ui(), 200)
    expect(hints).toContain("stage: space")
    expect(hints).not.toContain("open: enter")
    expect(hints).not.toContain("quit")
  })

  test("uses displayKeys when a binding overrides its rendered key", () => {
    expect(registry.hintsFor("files", model(), ui(), 200)).toContain("pane: h/l")
  })

  test("drops bindings that are unavailable rather than showing them", () => {
    const commitReview = model({ reviewTarget: { kind: "commit", oid: "abc123" } })
    const hints = registry.hintsFor("files", commitReview, ui(), 200)
    expect(hints).toContain("stage: space")
    expect(hints).not.toContain("discard: d")
  })

  test("lists context bindings before global ones", () => {
    const hints = registry.hintsFor("files", model(), ui(), 200)
    expect(hints.indexOf("stage: space")).toBeLessThan(hints.indexOf("pane: h/l"))
  })

  test("does not repeat a global binding whose key the context overrides", () => {
    const shadowing = new BindingRegistry([
      { keys: ["d"], action: "discard-file", description: "discard file", contexts: ["files"], displayOnScreen: true },
      { keys: ["d"], action: "discard-selection", description: "discard lines", displayOnScreen: true },
    ])
    expect(shadowing.hintsFor("files", model(), ui(), 200)).toBe("discard file: d")
  })
})

describe("BindingRegistry menu", () => {
  const registry = new BindingRegistry([
    { keys: ["space"], action: "stage-file", description: "stage", menuDescription: "stage the selected file", contexts: ["files"] },
    { keys: ["d"], action: "discard-file", description: "discard", contexts: ["files"], available: (m) => m.reviewTarget.kind === "working-tree" },
    { keys: ["q"], action: "quit", description: "quit" },
  ])

  test("groups context bindings first and uses the long description", () => {
    const entries = registry.menuFor("files", model(), ui())
    expect(entries[0]).toEqual({ group: "context", keys: "space", description: "stage the selected file", enabled: true })
    expect(entries.at(-1)).toEqual({ group: "global", keys: "q", description: "quit", enabled: true })
  })

  test("lists unavailable bindings as disabled rather than omitting them", () => {
    const entries = registry.menuFor("files", model({ reviewTarget: { kind: "commit", oid: "abc123" } }), ui())
    expect(entries.find((entry) => entry.keys === "d")).toEqual({ group: "context", keys: "d", description: "discard", enabled: false })
  })
})

describe("assertHandlersCover", () => {
  test("names every action with no handler", () => {
    const registry = new BindingRegistry([
      { keys: ["x"], action: "quit", description: "quit" },
      { keys: ["y"], action: "refresh", description: "refresh" },
    ])
    expect(() => assertHandlersCover(registry, new Set(["quit"]))).toThrow(/refresh/)
    expect(() => assertHandlersCover(registry, new Set(["quit", "refresh"]))).not.toThrow()
  })
})

describe("GITHUNK_BINDINGS", () => {
  const registry = createRegistry()

  test("constructs without collisions and with a description on every binding", () => {
    expect(() => createRegistry()).not.toThrow()
    for (const binding of GITHUNK_BINDINGS) expect(binding.description.length).toBeGreaterThan(0)
  })

  test("declares only actions from the action list", () => {
    for (const binding of GITHUNK_BINDINGS) expect(ACTIONS).toContain(binding.action)
  })

  test("keeps the pane numbers, mode switches and Git verbs from v0.1", () => {
    expect(registry.dispatch({ name: "0" })).toBe("focus-main")
    expect(registry.dispatch({ name: "5" })).toBe("focus-stash")
    expect(registry.dispatch({ name: "P" })).toBe("push")
    expect(registry.dispatch({ name: "p" })).toBe("pull")
    expect(registry.dispatch({ name: "R" })).toBe("refresh")
    expect(registry.dispatch({ name: "o", ctrl: true })).toBe("copy-exact")
  })

  test("completes hjkl: h and l move between panes", () => {
    expect(registry.dispatch({ name: "h" })).toBe("pane-previous")
    expect(registry.dispatch({ name: "l" })).toBe("pane-next")
    expect(registry.dispatch({ name: "tab" })).toBe("pane-next")
    expect(registry.dispatch({ name: "tab", shift: true })).toBe("pane-previous")
  })

  test("overrides h and l as hunk navigation inside the main pane", () => {
    expect(registry.dispatch({ name: "h" }, { context: "main" })).toBe("hunk-previous")
    expect(registry.dispatch({ name: "l" }, { context: "main" })).toBe("hunk-next")
  })

  test("keeps tabs in side windows and restores the scope ring on main's brackets", () => {
    expect(registry.dispatch({ name: "tab" }, { context: "main" })).toBe("pane-next")
    // Main is the only tabless window, so its `[`/`]` belong to the PRD §8.1 scope ring.
    expect(registry.dispatch({ name: "]" }, { context: "main" })).toBe("scope-next")
    expect(registry.dispatch({ name: "[" }, { context: "main" })).toBe("scope-previous")
    // Panel 2 has tabs of its own now (lazygit's `{files, worktrees, submodules}` group), so
    // the brackets cycle there too.
    expect(registry.dispatch({ name: "]" }, { context: "files" })).toBe("tab-next")
    expect(registry.dispatch({ name: "[" }, { context: "files" })).toBe("tab-previous")
    expect(registry.dispatch({ name: "]" }, { context: "branches" })).toBe("tab-next")
    expect(registry.dispatch({ name: "[" }, { context: "branches" })).toBe("tab-previous")
  })

  test("adds tab-next and tab-previous alongside the restored scope actions", () => {
    expect(ACTIONS).toContain("tab-next")
    expect(ACTIONS).toContain("tab-previous")
    expect(ACTIONS).toContain("scope-next")
    expect(ACTIONS).toContain("scope-previous")
  })

  test("declares paging, jumping, main scrolling, screen modes and the menu", () => {
    expect(registry.dispatch({ name: "." })).toBe("page-next")
    expect(registry.dispatch({ name: "," })).toBe("page-previous")
    expect(registry.dispatch({ name: ">" })).toBe("goto-bottom")
    expect(registry.dispatch({ name: "<" })).toBe("goto-top")
    expect(registry.dispatch({ name: "end" })).toBe("goto-bottom")
    expect(registry.dispatch({ name: "J" })).toBe("main-scroll-down")
    expect(registry.dispatch({ name: "K" })).toBe("main-scroll-up")
    expect(registry.dispatch({ name: "L" })).toBe("main-scroll-right")
    expect(registry.dispatch({ name: "H" })).toBe("main-scroll-left")
    // lazygit merges `scrollUpMain-alt1`/`-alt2` into `scrollUpMain`, so all six keys are one
    // binding scrolling `gui.scrollHeight` lines (pkg/config/user_config.go:1047-1052).
    expect(registry.dispatch({ name: "d", ctrl: true })).toBe("main-scroll-down")
    expect(registry.dispatch({ name: "u", ctrl: true })).toBe("main-scroll-up")
    expect(registry.dispatch({ name: "pagedown" })).toBe("main-scroll-down")
    expect(registry.dispatch({ name: "pageup" })).toBe("main-scroll-up")
    expect(registry.dispatch({ name: "+" })).toBe("screen-mode-next")
    expect(registry.dispatch({ name: "_" })).toBe("screen-mode-previous")
    expect(registry.dispatch({ name: "?" })).toBe("keybinding-menu")
  })

  /**
   * lazygit binds all of these on the extras view (pkg/gui/keybindings.go:249-295). They exist
   * globally in githunk already, but the command log needs its own entries so the handler can apply
   * the matching autoscroll transition rather than just moving the viewport.
   */
  test("the command log binds paging and jump keys in its own context", () => {
    for (const [key, action] of [[",", "page-previous"], [".", "page-next"], ["<", "goto-top"], [">", "goto-bottom"]] as const) {
      const binding = registry.resolve({ name: key }, { context: "command-log", model: model(), ui: ui() })
      expect(binding?.action).toBe(action)
      expect(binding?.contexts).toContain("command-log")
    }
  })

  test("the command log still binds j/k and the arrows", () => {
    expect(registry.dispatch({ name: "j" }, { context: "command-log" })).toBe("next")
    expect(registry.dispatch({ name: "k" }, { context: "command-log" })).toBe("previous")
    expect(registry.dispatch({ name: "down" }, { context: "command-log" })).toBe("next")
    expect(registry.dispatch({ name: "up" }, { context: "command-log" })).toBe("previous")
  })

  test("keeps the per-pane meanings of space, d, enter, r, g, n and f", () => {
    expect(registry.dispatch({ name: "space" }, { context: "files" })).toBe("stage-file")
    expect(registry.dispatch({ name: "space" }, { context: "main" })).toBe("stage-selection")
    expect(registry.dispatch({ name: "space" }, { context: "branches" })).toBe("branch-checkout")
    expect(registry.dispatch({ name: "space" }, { context: "stash" })).toBe("stash-apply")
    expect(registry.dispatch({ name: "d" }, { context: "files" })).toBe("discard-file")
    expect(registry.dispatch({ name: "d" }, { context: "main" })).toBe("discard-selection")
    expect(registry.dispatch({ name: "d" }, { context: "branches" })).toBe("branch-delete")
    expect(registry.dispatch({ name: "d" }, { context: "stash" })).toBe("stash-drop")
    expect(registry.dispatch({ name: "g" }, { context: "stash" })).toBe("stash-pop")
    expect(registry.dispatch({ name: "r" }, { context: "files" })).toBe("mark-reviewed")
    expect(registry.dispatch({ name: "r" }, { context: "branches" })).toBe("branch-rename")
    expect(registry.dispatch({ name: "n" }, { context: "branches" })).toBe("branch-create")
    expect(registry.dispatch({ name: "f" }, { context: "branches" })).toBe("fetch-remote")
  })

  test("hides staging hints when the review target is read-only", () => {
    const commitReview = model({ reviewTarget: { kind: "commit", oid: "abc123" } })
    const hints = registry.hintsFor("files", commitReview, ui(), 300)
    expect(hints).not.toContain("stage: space")
    expect(hints).not.toContain("discard: d")
    expect(hints).toContain("reviewed: r")
  })
  test("hides line actions in the All scope but advertises the scope ring", () => {
    const all = model({ reviewTarget: { kind: "working-tree", scope: "all" } })
    const hints = registry.hintsFor("main", all, ui({ focus: "main", mainScope: "all" }), 300)
    expect(hints).not.toContain("stage: space")
    expect(hints).toContain("scope: ]")
  })


  describe("stash pane gating", () => {
    const workingTree = model({ reviewTarget: { kind: "working-tree", scope: "unstaged" } })
    const stashTarget = model({ reviewTarget: { kind: "stash", ref: "stash@{0}" } })
    const commitReview = model({ reviewTarget: { kind: "commit", oid: "abc123" } })

    test("offers apply, pop and drop with a stash selected and a working-tree target", () => {
      const hints = registry.hintsFor("stash", workingTree, ui({ hasSelectedStash: true }), 300)
      expect(hints).toContain("apply: space")
      expect(hints).toContain("pop: g")
      expect(hints).toContain("drop: d")
    })

    test("still offers apply, pop and drop with a stash selected while reviewing that stash", () => {
      const hints = registry.hintsFor("stash", stashTarget, ui({ hasSelectedStash: true }), 300)
      expect(hints).toContain("apply: space")
      expect(hints).toContain("pop: g")
      expect(hints).toContain("drop: d")
    })

    test("withholds apply, pop and drop with a stash selected but a commit review target", () => {
      const hints = registry.hintsFor("stash", commitReview, ui({ hasSelectedStash: true }), 300)
      expect(hints).not.toContain("apply: space")
      expect(hints).not.toContain("pop: g")
      expect(hints).not.toContain("drop: d")
    })

    test("withholds apply, pop and drop when no stash is selected, regardless of review target", () => {
      for (const target of [workingTree, stashTarget, commitReview]) {
        const hints = registry.hintsFor("stash", target, ui({ hasSelectedStash: false }), 300)
        expect(hints).not.toContain("apply: space")
        expect(hints).not.toContain("pop: g")
        expect(hints).not.toContain("drop: d")
      }
    })

    test("gates stash-inspect the same way as apply, pop and drop", () => {
      const selected = ui({ hasSelectedStash: true })
      const unselected = ui({ hasSelectedStash: false })
      expect(registry.hintsFor("stash", workingTree, selected, 300)).toContain("inspect: enter")
      expect(registry.hintsFor("stash", stashTarget, selected, 300)).toContain("inspect: enter")
      expect(registry.hintsFor("stash", commitReview, selected, 300)).not.toContain("inspect: enter")
      expect(registry.hintsFor("stash", workingTree, unselected, 300)).not.toContain("inspect: enter")
    })
  })
})

describe("branches pane: f agrees between hints, menu and dispatch", () => {
  const registry = createRegistry()
  const workingTree = model({ reviewTarget: { kind: "working-tree", scope: "unstaged" } })

  test("local branch selected: fetch-remote is unavailable, so it supersedes nothing and global fetch shows through", () => {
    const state = ui({ selectedBranchKind: "local" })

    expect(registry.dispatch({ name: "f" }, { context: "branches", model: workingTree, ui: state })).toBe("fetch")

    const rows = registry.hintRowsFor("branches", workingTree, state)
    const fRow = rows.find((binding) => binding.keys.includes("f"))
    expect(fRow?.action).toBe("fetch")
    expect(registry.hintsFor("branches", workingTree, state, 300)).toContain("fetch: f")

    const entries = registry.menuFor("branches", workingTree, state)
    const fEntries = entries.filter((entry) => entry.keys === "f")
    expect(fEntries).toHaveLength(2)
    expect(fEntries).toContainEqual({ group: "context", keys: "f", description: "fetch the selected remote", enabled: false })
    expect(fEntries).toContainEqual({ group: "global", keys: "f", description: "fetch", enabled: true })
  })

  test("remote branch selected: fetch-remote is available, so it supersedes global fetch in both surfaces", () => {
    const state = ui({ selectedBranchKind: "remote" })

    expect(registry.dispatch({ name: "f" }, { context: "branches", model: workingTree, ui: state })).toBe("fetch-remote")

    const rows = registry.hintRowsFor("branches", workingTree, state)
    const fRows = rows.filter((binding) => binding.keys.includes("f"))
    expect(fRows).toHaveLength(1)
    expect(fRows[0]?.action).toBe("fetch-remote")

    const entries = registry.menuFor("branches", workingTree, state)
    const fEntries = entries.filter((entry) => entry.keys === "f")
    expect(fEntries).toHaveLength(1)
    expect(fEntries[0]).toEqual({ group: "context", keys: "f", description: "fetch the selected remote", enabled: true })
  })
})

describe("hints/dispatch agreement invariant", () => {
  // Pins the property the `f` case above is one instance of: the hints bar must never advertise
  // a key that `dispatch` would route to a different action. Covers every context, and a set of
  // representative states spanning every review-target kind, both selectedBranchKind values and
  // both hasSelectedStash values.
  const registry = createRegistry()
  const contexts: readonly BindingContext[] = ["main", "status", "files", "branches", "commits", "stash", "command-log"]

  const targets: readonly { readonly label: string; readonly model: AppModel }[] = [
    { label: "working-tree", model: model({ reviewTarget: { kind: "working-tree", scope: "unstaged" } }) },
    { label: "commit", model: model({ reviewTarget: { kind: "commit", oid: "abc123" } }) },
    { label: "stash", model: model({ reviewTarget: { kind: "stash", ref: "stash@{0}" } }) },
  ]

  const branchKinds: readonly NonNullable<UiState["selectedBranchKind"]>[] = ["local", "remote"]
  const stashSelections: readonly boolean[] = [true, false]

  for (const { label, model: stateModel } of targets) {
    for (const branchKind of branchKinds) {
      for (const hasSelectedStash of stashSelections) {
        const state = ui({ selectedBranchKind: branchKind, hasSelectedStash })
        for (const context of contexts) {
          test(`hints never advertise a key dispatch routes elsewhere (target=${label}, branchKind=${branchKind}, stash=${hasSelectedStash}, context=${context})`, () => {
            for (const binding of registry.hintRowsFor(context, stateModel, state)) {
              const firstKey = binding.keys[0]
              expect(firstKey).toBeDefined()
              const stroke = normalizeKey(firstKey!)
              expect(registry.dispatch(stroke, { context, model: stateModel, ui: state })).toBe(binding.action)
            }
          })
        }
      }
    }
  }

  test("invariant: aggregate binding coverage floor", () => {
    // Count bindings with displayOnScreen: true to establish the floor
    const displayedBindings = GITHUNK_BINDINGS.filter((b) => b.displayOnScreen === true).length

    // Accumulate total rows examined across all 112 state combinations
    let totalRowsExamined = 0
    for (const { model: stateModel } of targets) {
      for (const branchKind of branchKinds) {
        for (const hasSelectedStash of stashSelections) {
          const state = ui({ selectedBranchKind: branchKind, hasSelectedStash })
          for (const context of contexts) {
            totalRowsExamined += registry.hintRowsFor(context, stateModel, state).length
          }
        }
      }
    }

    expect(totalRowsExamined).toBeGreaterThanOrEqual(displayedBindings)
  })

  test("invariant: every context renders at least one row in some state", () => {
    const contextsCovered = new Set<BindingContext>()

    for (const { model: stateModel } of targets) {
      for (const branchKind of branchKinds) {
        for (const hasSelectedStash of stashSelections) {
          const state = ui({ selectedBranchKind: branchKind, hasSelectedStash })
          for (const context of contexts) {
            const rows = registry.hintRowsFor(context, stateModel, state)
            if (rows.length > 0) {
              contextsCovered.add(context)
            }
          }
        }
      }
    }

    for (const context of contexts) {
      expect(contextsCovered.has(context)).toBe(true)
    }
  })
})
