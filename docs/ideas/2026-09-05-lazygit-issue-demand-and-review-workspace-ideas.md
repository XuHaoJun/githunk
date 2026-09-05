# lazygit Issue Demand and Branch Review Workspace Ideas — 2026-09-05

Survey of open lazygit issues (GitHub search API, sorted by reactions and comments, plus
keyword slices), reconciled against githunk's current code and `docs/githunk-prd-v0.1.md`
§19–22. Recorded so the demand evidence and the code findings do not have to be re-derived.

This record is evidence-bounded. Claims about githunk carry a `file:line`; claims about
lazygit carry an issue number and its reaction/comment count at the time of the survey.
Nothing here has been implemented, and nothing here is a committed roadmap.

## Demand clusters in lazygit

| Cluster | Issues (👍 / comments at survey time) |
| --- | --- |
| Diff reading experience | #1113 fullscreen diff (43 / 22, highest-voted feature request); #2659 Improved diff UX (opened by the maintainer, concedes the ref-compare flow is unintuitive and A..B vs A...B is confusing); #5836 sticky file/hunk header; #3967 and #5775 select/copy text from the patch panel; #1707 page scroll; #2032 `C-d`/`C-u`; #2117 pager during interactive staging; #1274 diff blinking; #2128 tree-sitter (32) |
| Compare against arbitrary base | #3767 relative diff (14); #3792 `git log A...B` (18 comments); #4211; #4477 multi-commit diff |
| Search | #3279 Git-based commit log search (38) — wants message body, author, path and **diff content**, with a repo-vs-branch scope switch; #3904 search inside filter-by-path mode; #3265; #1489 |
| Review / PR workflow | #2527 stacked PRs (40); #5833 GitHub stack (22); #3639 review PRs in the TUI; #4950 PR integration; #2914 IDEA-style changelists (23 comments); #4767 commit-wise review — **closed as not planned**, maintainers redirected to interactive rebase |
| Commit message | #941 suggest from history (20); #1670 conventional-commit lint; #2581 syntax highlight; #1307 gitmoji; #4995 `prepare-commit-msg` hook; #4627 non-modal commit panel; #3212 / #2579 AI commit messages (maintainers redirect to custom commands, will not build in) |
| Patch in/out | #3396 apply patch from clipboard (17) — notes lazygit can copy a patch out but has no binding to use one; #4894 export a commit as a patch file |
| Large-repo performance | #5163 nixpkgs unusably slow; #4591 checking out thousands of files; #3907 large files freeze; #2460 memory reached 9.6GB |
| Ecosystem signal | #4655 "Stepping back as maintainer" (188) — the highest-reaction issue in the repository |

## Already covered in githunk — do not rebuild

| lazygit demand | githunk today |
| --- | --- |
| #1113 fullscreen diff | Two distinct mechanisms, see below |
| #3967 / #5775 patch selection and copy | Product core, `src/domain/diff/` |
| #4740 runtime side-panel width | Draggable splitters |
| #4767 commit-wise review | `ReviewProjection` has `{ kind: "commit"; oid }` (`src/review/core/types.ts:103`) — model only, see gap 1 |
| Line-anchored review comments | `ReviewFeedback` with range anchor and `stale` / `orphaned` resolution (`src/review/core/types.ts:81-90`) |
| Arbitrary compare base | Commit `4ebc628` |
| lazygit `{` / `}` diff context size | Superseded by workspace `z` expand context gap, which reads real source between hunks (`src/ui/review-workspace/controller.ts:521-540`) |

## Fullscreen diff vs the Branch Review workspace

These are not the same layer, and conflating them produced a wrong first pass at this survey.

**Screen-mode (`+` / `_`)** is a geometry parameter on the repository screen: `normal | half |
full` through `computeLayout` (`src/ui/layout.ts:125-159`, `src/ui/root-view.ts:297,1465-1470`).
Content, panes and keys are unchanged; only width allocation moves. It is lazygit `screenMode`
parity.

**The Branch Review workspace** is a separate screen, swapped wholesale by `AppScreenController`
(`src/app/screen-controller.ts:48,157,218`):

| | Repository screen | Branch Review workspace |
| --- | --- | --- |
| Renderer | OpenTUI panes | React (`ReactReviewHost`) |
| Keys | `GITHUNK_BINDINGS` | `src/ui/review-workspace/command-catalog.ts` |
| Focus | Pane focus manager | `sidebar \| stream \| filter \| composer` |
| Layout | `computeLayout` + splitters | `l` cycles `auto \| split \| stack`, auto picks on `diffWidth >= 64` (`ReviewWorkspaceApp.tsx:245,287,725`) |
| Data | `AppModel` | `ReviewProjection` / `ReviewFeedback` / artifacts |
| Diff | One file at a time | Continuous cross-file stream, `]` / `[` hunk, `.` / `,` file |

The workspace's `stack` layout plus the `0` / `1` tabs already provides a fullscreen diff by a
different mechanism. So #1113 is satisfied twice over, by two unrelated code paths.

## Verified gaps in the workspace

1. **Projections are modelled but not reachable.** `ReviewProjection` supports `aggregate`,
   `since-last-review` and `commit` (`src/review/core/types.ts:100-104`), the Git loaders exist
   and are integration-tested against real repositories (`src/review/git/load-review-projection.ts`,
   `tests/review/git/projections.integration.test.ts`), but nothing in `src/` called them and no
   command switched projection. Per-commit review (lazygit #4767, closed as not planned) and
   "what did the agent change since my last review" (PRD §22's loop) both existed in the model
   with no key bound to them.

   *Correction to an earlier revision of this line:* it claimed the catalog's
   `available` gate was unused. It was not — `command-catalog.ts:156` gates the
   mark-viewed command on `canMarkViewedInProjection`, which deliberately permits
   marking viewed inside a `since-last-review` lens and refuses it inside a
   `commit` one.

   *Status:* the `since-last-review` half shipped (`s` in the workspace); the `commit` half
   still needs a commit-list UI the sidebar does not have.
2. **The workspace filter has no content dimension.** `/` matches file paths only
   (`reviewFileMatchesFilter`, `src/review/core/selectors.ts:80-100`) and `f` cycles review
   status (`all | unreviewed | changed | feedback`, `src/review/core/state.ts:33`). lazygit
   #3279's two open design questions — what is the search scope, and how are results shown —
   have ready answers here: scope is the projection, presentation is the existing sidebar plus
   a greyed-out stream.
3. **No sticky file/hunk header in the stream.** The stream is exactly the continuous
   cross-file scroll surface #5836 describes; the repository screen hurts less because the file
   list stays on screen. Already scoped as PRD §19.2.
4. **Finish review has one output channel.** The markdown leaves only through the clipboard
   (`src/ui/review-workspace/finish-dialog.ts:211-215`). When OSC52 is blocked there is no
   fallback, a known risk per `docs/clipboard-compatibility-v0.1.md`. A file export answers
   both this and lazygit #4894.

## Candidate ordering

1. ~~Bind `commit` and `since-last-review` projections in the workspace.~~ `since-last-review`
   done; `commit` deferred behind a commit-list UI. The switch turned out to touch more than the
   catalog: a projection swaps `ReviewState.document`, so the generation-refresh path had to drop
   a stale lens, and the header label had to stop hardcoding `Aggregate`.
2. Diff-content search in the workspace (lazygit #3279).
3. Sticky file/hunk header in the stream (lazygit #5836, PRD §19.2).
4. File export channel for finish review (lazygit #4894).

## Considered and set aside

- **Apply patch from clipboard** (#3396, 17): touches only the repository screen, no
  contribution to the main review flow. The export half is kept, as item 4 above.
- **lazygit `{` / `}` context size**: superseded by `z`, and `{` / `}` are already bound to
  next/prev feedback in the workspace (`command-catalog.ts:93,101`). Only ignore-whitespace
  survives from that group, and in the workspace it is a projection load parameter rather than
  a display toggle, so it needs separate design.
- **Stacked PRs / PR review** (#2527 40, #3639, #4950): turns githunk into a `gh` client and
  brings auth, rate limits and offline behaviour. Smallest useful slice would be reading the
  current branch's PR base and feeding the existing base-selection flow.
- **AI commit messages** (#3212, 25): lazygit routes these to custom commands, and githunk's
  no-runtime-dependency rule points the same way — an external command hook, not built in.
- **Interactive rebase / cherry-pick** (compatibility matrix row 19): parity backfill, not
  differentiation.
- **Line-level blame**: zero lazygit issues carry "blame" in the title, so there is no demand
  evidence for it. Noted only as a possible precursor to PRD §21's blast-radius direction.
