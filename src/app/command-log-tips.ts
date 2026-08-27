import type { CommandLog } from "./command-log"

/**
 * lazygit's startup header for the command log (`printCommandLogHeader`,
 * pkg/gui/command_log_panel.go:70-85): a cyan line naming the key that hides and focuses the
 * panel, then — when `Gui.ShowRandomTip` is on, which it is by default
 * (pkg/config/user_config.go:909) — a yellow label and a green tip.
 */

/** `Tr.CommandLogHeader` (pkg/i18n/english.go:1951) formatted with `Universal.ExtrasMenu`, "@". */
export const COMMAND_LOG_HEADER = "You can hide/focus this panel by pressing '@'"

/** `Tr.RandomTip` (pkg/i18n/english.go:1952). */
export const RANDOM_TIP_LABEL = "Random tip"

/**
 * The keys the keybinding tips name. lazygit interpolates its own config values
 * (`config.Universal.PrevPage` and friends, command_log_panel.go:90-174); githunk's equivalents are
 * pinned here so `tests/app/command-log-tips.test.ts` fails if one is rebound, rather than the tip
 * quietly telling the user to press a key that does nothing.
 */
export const COMMAND_LOG_TIP_KEYS = {
  stashInspect: { key: "enter", label: "enter", action: "stash-inspect" },
  pagePrevious: { key: ",", label: ",", action: "page-previous" },
  pageNext: { key: ".", label: ".", action: "page-next" },
  gotoTop: { key: "<", label: "<", action: "goto-top" },
  gotoBottom: { key: ">", label: ">", action: "goto-bottom" },
  enterDirectory: { key: "enter", label: "enter", action: "inspect" },
  toggleFileTree: { key: "`", label: "`", action: "toggle-file-tree" },
  amendLastCommit: { key: "A", label: "A", action: "amend" },
  paneNext: { key: "l", label: "l", action: "pane-next" },
  panePrevious: { key: "h", label: "h", action: "pane-previous" },
} as const

/**
 * lazygit's tips, restricted to those whose feature and keybinding both exist in githunk: 13 of
 * lazygit's ~30 (`command_log_panel.go:90-199`) — the 7 keybinding tips plus the 6 general-advice
 * ones below.
 *
 * Excluded, and why: force push, filter-commits-by-path, interactive rebase, undo/redo, reset
 * options, push tag, the diffing menu, drop commit, merge options, revert commit, custom commands,
 * delta and the bare-repo flags all name features githunk does not implement (none of `rebase`,
 * `undo`, `redo`, a reset-options menu, push-tag, a diffing menu, commit-drop, merge-options,
 * revert-commit or custom commands appear anywhere in `src/ui/bindings.ts`); the escape-a-mode tip
 * depends on `quitOnTopLevelReturn`, which githunk has no equivalent of, and names lazygit "modes"
 * (cherry-picking, patch-building, diffing, filtering) githunk does not have as a concept; the
 * amend-to-commit tip (`Commits.AmendToCommit`, :162-165) is genuinely false of githunk — pressing
 * `A` while a commit is selected in the commits panel does not amend that commit, because
 * `commitAttemptAvailable` (root-view.ts:2184-2195) only permits `A` when focus is Files or Main,
 * never the commits panel, and githunk has no way to target an older commit for amending at all;
 * and "join the team" and "raise an issue" point at lazygit's own project. A tip joins this list
 * when githunk gains the feature it names.
 *
 * The flat-file-view tip (below) is *not* excluded: `buildFlatTreeFromFiles`
 * (src/ui/file-tree.ts:237-253) sorts merge-conflict files to the top exactly as
 * `pkg/gui/filetree/build_tree.go:138` does, and `toggle-file-tree` is bound to the same default
 * key, "`" (pkg/config/user_config.go:1100).
 *
 * Nor is the amend-last-commit tip (`Files.AmendLastCommit`, :166-169) excluded, despite sitting
 * right next to the tip above that *is* excluded: githunk's `A` is not global in effect —
 * `commitAttemptAvailable` (root-view.ts:2184-2195) permits it only in Files or Main — so "press
 * `A` in the files panel" (this tip's claim) is exactly what happens: `actionAmend`
 * (root-view.ts:2174-2178) runs `withEnsureCommittableFiles` then the amend dialog, reaching
 * `git commit --amend -F -` (src/git/commit-mutations.ts:45-49) against the staged changes. Same
 * default key as lazygit's (`user_config.go:1090`), same panel, true statement.
 */
export const COMMAND_LOG_TIPS: readonly string[] = [
  // command_log_panel.go:105-108
  `In flat file view, merge conflicts are sorted to the top. To switch to flat file view press '${COMMAND_LOG_TIP_KEYS.toggleFileTree.label}'`,
  // :124-127
  `You can view the individual files of a stash entry by pressing '${COMMAND_LOG_TIP_KEYS.stashInspect.label}'`,
  // :149-153
  `You can page through the items of a panel using '${COMMAND_LOG_TIP_KEYS.pagePrevious.label}' and '${COMMAND_LOG_TIP_KEYS.pageNext.label}'`,
  // :154-157
  `You can jump to the top/bottom of a panel using '${COMMAND_LOG_TIP_KEYS.gotoTop.label}' and '${COMMAND_LOG_TIP_KEYS.gotoBottom.label}'`,
  // :158-161
  `To collapse/expand a directory, press '${COMMAND_LOG_TIP_KEYS.enterDirectory.label}'`,
  // :166-169 (the adjacent :162-165 amend-to-commit tip is excluded — see the block comment above)
  `You can amend the last commit with your new file changes by pressing '${COMMAND_LOG_TIP_KEYS.amendLastCommit.label}' in the files panel`,
  // :170-174. lazygit interpolates `NextBlockAlt2`/`PrevBlockAlt2` here, default tab/backtab
  // (user_config.go:1022-1023); githunk binds those to the same `pane-next`/`pane-previous`
  // actions (bindings.ts:295-296) alongside `l`/`h`, and this substitutes the latter — the
  // primary, on-screen-displayed pair (`displayKeys: "h/l"`) — instead. Both pairs are equally
  // true, so nothing here lies, but it is the one tip where the substituted key is not the config
  // field the tip's source literally names; everywhere else "verbatim apart from substituted keys"
  // means the named field's own default.
  `You can now navigate the side panels with '${COMMAND_LOG_TIP_KEYS.paneNext.label}' and '${COMMAND_LOG_TIP_KEYS.panePrevious.label}'`,
  // The general advice, verbatim and key-free (:179-184).
  "`git commit` is really just the programmer equivalent of saving your game. Always do it before embarking on an ambitious change!",
  "Try to separate commits that refactor code from commits that add new functionality: if they're squashed into one commit, it can be hard to spot what's new.",
  "If you ever want to experiment, it's easy to create a new branch off your current one and go nuts, then delete it afterwards",
  "Always read through the diff of your changes before assigning somebody to review your code. Better for you to catch any silly mistakes than your colleagues!",
  "If something goes wrong, you can always checkout a commit from your reflog to return to an earlier state",
  "The stash is a good place to save snippets of code that you always find yourself adding when debugging.",
]

/**
 * `rand.Intn(len(tips))` (pkg/gui/command_log_panel.go:201-203). A non-finite `pick` result (`NaN`,
 * `Infinity`) survives `Math.min(Math.max(0, NaN), n)` — that expression is `NaN`, which indexes to
 * `undefined` and would render as a bare "Random tip: " — so non-finite picks are treated as `0`
 * before clamping, same as any other out-of-range value.
 */
export function randomTip(pick: (count: number) => number = (count) => Math.floor(Math.random() * count)): string {
  const raw = pick(COMMAND_LOG_TIPS.length)
  const safe = Number.isFinite(raw) ? raw : 0
  const index = Math.min(Math.max(0, Math.floor(safe)), COMMAND_LOG_TIPS.length - 1)
  return COMMAND_LOG_TIPS[index] ?? ""
}

export type SeedCommandLogOptions = {
  /** `Gui.ShowRandomTip`, default true (pkg/config/user_config.go:909). */
  readonly showRandomTip?: boolean
  readonly pick?: (count: number) => number
}

export function seedCommandLog(log: CommandLog, options: SeedCommandLogOptions = {}): void {
  log.logIntro(COMMAND_LOG_HEADER)
  if (options.showRandomTip === false) return
  log.logTip(RANDOM_TIP_LABEL, randomTip(options.pick))
}
