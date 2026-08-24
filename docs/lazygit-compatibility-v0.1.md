# Lazygit compatibility (githunk v0.1)

This is a compatibility guide, not a claim of complete lazygit parity. The reference is the read-only HTTPS submodule document [`learn-projects/lazygit/docs/keybindings/Keybindings_en.md`](../learn-projects/lazygit/docs/keybindings/Keybindings_en.md), especially its Global keybindings, List panel navigation, Files, Local branches, Commits, and Main panel sections.

## Implemented

| Shortcut | githunk behavior | Reference |
| --- | --- | --- |
| `0`–`5` | Focus Main, Status, Files, Branches, Commits, or Stash | The reference uses `0` for Main in the Files, Commits, and Local branches sections (lines 72, 120, 162, 199). githunk exposes the additional numbered panes deliberately. |
| `j`/`k`, arrows | Move the focused pane cursor (Main also uses these for selectable diff navigation) | List-panel navigation and Main normal/staging sections (lines 38–53, 209–227, 245–265). |
| `Space` | Focused context action (stage, apply stash, checkout branch, or patch selection) | Files and branch actions (lines 134–163, 172–201); Main staging (lines 245–265). |
| `Enter`, `Esc` | Inspect/enter in a pane; back/cancel in dialogs and drill-downs | The reference lists Enter/Escape for summaries, confirmations, prompts, and panel transitions (lines 75–80, 124–130, 165–170, 219–227). |
| `R` | Refresh repository state | Global `R` refresh (line 22). |
| `f`, `p`, `P` | Fetch, pull, and push (global sync callbacks; `f` is not a Branches text filter) | Global `p`/`P` and Files `f` (lines 13–14, 159). |
| `/` | Open the Branches-pane filter only; Unicode-aware substring matching; `Esc` cancels and `Enter` leaves filtering active | The reference lists search/filter in list panels and branches (lines 49, 122, 201); Files and Commits `/` are intentionally out of scope in v0.1. |
| `c`, `A` | Commit and amend dialogs | Files/Main staging commit and Commits amend (lines 140, 261, 104). |
| `@` | Toggle/show/focus Command Log | Global command-log options (line 12). |
| `Ctrl+O`, `y` | Exact Main selection copy and copy menu | Copy bindings in Commit files, Commits, Files, and Main patch sections (lines 59, 86, 136, 237). |
| `q`, `Ctrl+C` | Quit | Global quit (line 31). |
| `h`/`l` | Move focus to the previous/next pane | `PrevBlockAlt`/`NextBlockAlt` (`user_config.go:1020-1021`). |
| `Tab`/`Shift+Tab` | Cycle pane focus in the same order as `l`/`h` | `TogglePanel` is `<tab>` and `<backtab>` also navigates blocks (`user_config.go:1002,1022-1023`). The main pane's scope toggle moved from `Tab` to `[`/`]`; see "Intentionally changed". |
| `,`/`.` | Page up/down in the focused list | `PrevPage`/`NextPage` (`user_config.go:1007-1008`). |
| `<`/`>`, `Home`/`End` | Jump to the top/bottom of the focused list | `GotoTop`/`GotoBottom` with `<home>`/`<end>` alternates (`user_config.go:1011-1014`). |
| `H`/`L` | Scroll the Main pane left/right | `ScrollLeft`/`ScrollRight` (`user_config.go:1009-1010`). |
| `J`/`K` | Scroll the Main pane down/up | `ScrollDownMainAlt1`/`ScrollUpMainAlt1` (`user_config.go:1049-1050`). |
| `Ctrl+D`/`Ctrl+U`, `PgDn`/`PgUp` | Half-page and full-page Main scrolling | `ScrollDownMainAlt2`/`ScrollUpMainAlt2` and `ScrollUpMain`/`ScrollDownMain` (`user_config.go:1047-1052`). |
| `+`/`_` | Cycle screen modes: enlarge or shrink the focused region (normal → half → full) | `NextScreenMode`/`PrevScreenMode` (`user_config.go:1061-1062`). |
| `?` | Open the full keybinding menu; `Esc` closes it | `OptionMenu` (`user_config.go:1033`). |
| `[`/`]` | Previous/next Working Tree scope (all, staged, unstaged) while Main is focused | Deliberate divergence: these keys are lazygit's `PrevTab`/`NextTab` (`user_config.go:1059-1060`); githunk reuses them because `Tab` now cycles panes and the scope toggle needed a home — see "Intentionally changed". |

## Intentionally changed

- **`Tab` no longer toggles the Main pane's review scope:** pane focus claimed `Tab`/`Shift+Tab` (matching lazygit's block navigation, where `<tab>` and `<backtab>` move between panels), so the scope toggle moved to `[`/`]`. Lazygit uses `[`/`]` for previous/next tab inside a panel; githunk has no panel tabs in v0.1, and reusing those keys keeps the scope toggle one keypress away instead of displacing the navigation muscle memory every other pane shares.
- **Pane model and focus:** githunk has six numbered panes plus a separately toggled Command Log. Lazygit’s reference generally maps `0` to Main and uses panel-local focus; the extra focus IDs make githunk’s review layout explicit.
- **Filtering:** githunk uses a shared Unicode-aware case-insensitive substring filter and stable item IDs. A modal filter consumes printable input before pane/global actions; zero matches is an explicit empty view. This preserves the reference’s `/` affordance while making filtering deterministic for branch/review data.
- **Copy semantics:** `Ctrl+O` copies the exact selectable Main text and `y` opens githunk’s copy-mode menu. The reference assigns `Ctrl+O` to path/hash/selected-text variants depending on panel (lines 59, 86, 136, 237); githunk keeps Main text selection and does not make adjacent panes or Command Log selectable.
- **Review actions:** `Space`, staging/discard operations, branch checkout, stash actions, review progress, commit drill-down, and branch/upstream dialogs are review-oriented callbacks. They are not lazygit’s rebase/custom-patch command set even when a key is shared.
- **Sync safety:** Pull/push/fetch and staging are serialized through githunk’s controller and refresh callbacks. Dialogs and filters have precedence over global shortcuts, rather than allowing a character typed into a prompt to trigger a repository command.
- **Mouse behavior:** Mouse-down focuses the pane under the pointer; wheel events remain local to that pane; splitter drag remains exclusive. The lazygit document lists wheel scrolling for Main (lines 223–224), while githunk applies the same locality rule to its pane layout.
- **Filter scope:** The Branches pane is the only pane filter wired in v0.1; Files and Commits do not claim `/` behavior until their pane-specific actions are connected.

## Out of scope for v0.1
The following reference behavior is intentionally not implemented: recent-repository switching (`Ctrl+R`), rename/diff-context/render-mode controls (`(`, `)`, `{`, `}`, `|`, `\\`), shell/custom command prompts (`:`), merge/rebase/bisect/reflog/cherry-pick workflows, interactive rebase commit actions, external editors/diff tools, pull requests/browser actions, tags/worktrees, undo/redo, suspend, whitespace toggles, and lazygit’s custom patch options. These appear in the reference Global, Commits, Main patch-building, Reflog, and related sections (lines 5–35, 82–122, 229–243, 275–293), but are outside githunk’s review target.

The compatibility table does not imply that every shortcut shown in the reference is available in every githunk context. Context-aware keymap collision checks reject duplicate bindings within a context, and modal input always wins over pane/global dispatch.
