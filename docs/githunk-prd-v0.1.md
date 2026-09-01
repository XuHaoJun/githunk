# githunk v0.1 — Product Requirements Document

**Status:** Draft
**Date:** 2026-08-24
**Primary use case:** Reviewing coding-agent output
**Product category:** Review-first Git TUI
> **Branch Review cutover (2026-08-27):** The Branch Review portions of this document (§8.2, §9 for Branch Review, §13 as it applied to Branch Review, and the `branch` review target) are **superseded** by the approved spec `docs/superpowers/specs/2026-08-27-branch-review-workspace-design.md`. That spec defines the dedicated full-screen Review Workspace entered with `b`, its coverage/invalidation, projections, feedback lifecycle, immutable artifacts, and persistence. This PRD remains the source for Working Tree review, daily-driver Git core, and v0.1 success criteria; do not duplicate the new spec here.

---

## 1. Product Summary

**githunk** is a Git TUI designed primarily for reviewing changes produced by coding agents.

It should retain enough of lazygit's layout, keyboard muscle memory, and everyday Git functionality to serve as a daily driver, while substantially improving the experience of:

* reading large diffs;
* selecting and copying exact portions of patches;
* reviewing changes over SSH;
* tracking review progress;
* understanding a coding agent's complete change set rather than isolated commits;
* eventually understanding blast radius and regression risk.

The fundamental product idea is:

> **Treat the diff/patch as an interactive review workspace, not merely terminal output.**

githunk is not intended to differentiate by reinventing ordinary Git operations. Familiar Git operations should feel close to lazygit; product differentiation should primarily come from review ergonomics.

---

# 2. Problem

Coding agents can modify many files and hundreds or thousands of lines in one task.

Traditional Git TUIs are primarily optimized around performing Git operations. Their diff panes are useful for inspection, but are not designed as rich review surfaces.

A particularly important example is text selection.

When a TUI enables terminal mouse capture, native terminal text selection commonly requires an override such as `Shift + drag`. That selection operates on terminal screen cells rather than application-level panels.

For a layout such as:

```text
┌─────────────────────┬─────────────────────────────────────┐
│ Changed Files       │ Patch                               │
│                     │                                     │
│ src/foo.ts          │ - const oldValue = foo();           │
│ src/bar.ts          │ + const value = foo();              │
│ src/baz.ts          │ + console.log(value);               │
│                     │                                     │
└─────────────────────┴─────────────────────────────────────┘
```

selecting several lines from the Patch pane can unintentionally include text rendered in the Changed Files pane.

For coding-agent review this is particularly frustrating because selected code is frequently copied into:

* coding agents;
* LLM conversations;
* search tools;
* issue trackers;
* review discussions;
* terminal commands;
* documentation.

githunk should understand that the Patch pane is a logical document and copy only text belonging to that document.

---

# 3. Product Principles

## 3.1 Review first

When a trade-off exists between optimizing a rare Git administration workflow and improving code review, prefer review.

## 3.2 Preserve lazygit muscle memory

Existing lazygit users should be able to perform common operations without relearning the application.

Preserve wherever practical:

* `0` for the main pane;
* `1`–`5` for left-side pane navigation;
* common stage/unstage behavior;
* common commit operations;
* push/pull conventions;
* branch navigation;
* stash operations;
* filtering/search conventions;
* general navigation conventions.

Do **not** preserve lazygit behavior merely for historical compatibility when doing so would prevent a major review improvement.

New review-specific functionality should preferably receive new shortcuts rather than replacing familiar lazygit shortcuts.

## 3.3 Familiar layout, review-specific information architecture

githunk does not need to reproduce lazygit's exact panel grouping.

The `0 / 1–5` navigation model remains familiar, while panel contents may be reorganized around review workflows.

## 3.4 Mouse and keyboard are both first-class

Keyboard-first workflows must remain efficient.

Mouse support should additionally make these actions natural:

* focus panes;
* select text;
* scroll;
* resize panes;
* inspect files;
* interact with review state.

Mouse support must not make text copying worse.

## 3.5 Remote development is first-class

Running githunk through SSH is an expected workflow, not an edge case.

Clipboard support must therefore include OSC52 or equivalent remote-friendly behavior.

## 3.6 Explain the review target

The UI must always make it obvious **what changes are currently being reviewed**.

The user should never have to wonder whether the displayed diff means:

* unstaged changes;
* staged changes;
* all working-tree changes;
* one commit;
* or the complete branch change set.

---

# 4. Primary User Stories

## 4.1 Prototype workflow

A coding agent modifies files without committing.

```text
Coding agent
     ↓
working tree changes
     ↓
githunk
     ↓
review files
     ↓
copy / search / inspect
     ↓
stage selected changes
     ↓
commit
     ↓
push
```

The primary review target is the working tree.

---

## 4.2 Formal coding-agent workflow

A coding agent is required to commit its work.

```text
base branch
     │
     ├── agent commit A
     ├── agent commit B
     ├── agent commit C
     └── HEAD
```

The primary question is not:

> What did commit C change?

It is:

> What did this coding agent change in total?

Therefore the default review target is:

```text
base...HEAD
```

Individual commits remain available for drill-down.

---

## 4.3 Remote development

The user SSHes into a development server and runs githunk.

They select several lines in the patch pane and copy them.

The selected text should arrive in the **local machine's clipboard** without requiring the user to understand whether OSC52, tmux, Wayland, X11, or another mechanism is responsible.

---

## 4.4 Remote branch checkout

The user needs a branch that currently only exists on a remote.

```text
Branches / Remotes
       ↓
origin
       ↓
feature/foo
       ↓
checkout
```

githunk creates or switches to the corresponding local tracking branch.

The user should not need to leave githunk and manually run:

```text
git switch --track origin/feature/foo
```

---

# 5. v0.1 Information Architecture

Use the following primary layout.

```text
┌──────────────────────┬─────────────────────────────────────────────┐
│ 1 Status / Review    │                                             │
├──────────────────────┤                                             │
│ 2 Files              │                                             │
├──────────────────────┤                  0 Main                     │
│ 3 Branches / Remotes │          Diff / Commit / Details           │
├──────────────────────┤                                             │
│ 4 Commits            │                                             │
├──────────────────────┼─────────────────────────────────────────────┤
│ 5 Stash              │ Command Log                                 │
└──────────────────────┴─────────────────────────────────────────────┘
```

The layout preserves lazygit's familiar numbered-panel model while allowing review-specific content.

---

# 6. Pane Definitions

## 6.1 Pane 1 — Status / Review

Shows repository and current review context.

Example:

```text
REVIEW
────────────────────
Branch Changes

feature/payment
vs origin/main

17 / 24 reviewed
2 changed after review

7 commits
24 files
+813 -224
```

For Working Tree mode:

```text
REVIEW
────────────────────
Working Tree

12 files
4 staged
8 unstaged

7 / 12 reviewed
```

Future risk/blast-radius information may also appear contextually in this pane.

---

## 6.2 Pane 2 — Files

Displays files belonging to the current review target.

Example:

```text
○ src/auth.ts
● src/user.ts
! src/payment.ts
◐ tests/payment.test.ts
```

Review indicators:

```text
○  not reviewed
◐  reviewing
●  reviewed
!  changed after review
```

File status and staged/unstaged state must remain visually distinguishable from review status.

---

## 6.3 Pane 3 — Branches / Remotes

Supports:

### Local branches

* list;
* search/filter;
* switch;
* create;
* delete;
* rename.

### Remotes

* list configured remotes;
* fetch;
* enter a remote to browse its branches.

### Remote branches

* list;
* search/filter;
* inspect commits;
* checkout.

When selecting:

```text
origin/feature/foo
```

and the local branch does not exist, githunk should create:

```text
feature/foo
```

tracking:

```text
origin/feature/foo
```

and switch to it.

If the matching local tracking branch already exists, githunk should switch to it.

---

## 6.4 Pane 4 — Commits

For Branch Review:

```text
base
 ├─ agent commit A
 ├─ agent commit B
 ├─ agent commit C
 └─ HEAD
```

The main review remains the aggregate:

```text
base...HEAD
```

Selecting an individual commit allows inspection of that commit without changing the overall review-progress model.

v0.1 does **not** require commit-by-commit review completion.

---

## 6.5 Pane 5 — Stash

Support common daily operations:

* list;
* inspect;
* apply;
* pop;
* drop.

Additional advanced stash operations may follow later.

---

## 6.6 Pane 0 — Main Review Surface

The main pane is the most important surface in githunk.

Depending on context it may display:

* working-tree diff;
* staged diff;
* aggregate branch diff;
* individual commit;
* stash diff;
* branch commit history;
* remote branch history.

In review contexts, maximizing useful patch space takes priority.

---

## 6.7 Command Log

The lower-right region shows executed Git commands and relevant command output.

Users must be able to:

* show/hide it;
* focus it;
* scroll it;
* resize it vertically.

Command failures must remain inspectable.

---

# 7. Resizable Layout

The main vertical divider between the left panels and Main must support mouse drag.

```text
LEFT              MAIN
│                   │
│         ⇆         │
│                   │
```

The horizontal divider between Main and Command Log must also support mouse drag.

Expected behaviors:

* immediate visual resize;
* sensible minimum pane sizes;
* terminal resize does not corrupt layout;
* splitter drag must not accidentally begin text selection;
* text selection must not accidentally resize a splitter.

A future enhancement may support double-clicking a divider to collapse/restore a region.

---

# 8. Review Targets

githunk v0.1 supports two primary review modes.

## 8.1 Working Tree Review

Designed primarily for prototyping and exploratory coding-agent work.

Support viewing:

```text
All working-tree changes
Staged
Unstaged
```

The exact active target must always be visible.

---
## 8.2 Branch Review — superseded

> **Superseded by `docs/superpowers/specs/2026-08-27-branch-review-workspace-design.md` (§5–§13, §15).**
> The old in-pane Branch Review mode and its `BranchReviewSnapshot`/`branchReviewTarget`/`review-state-v1.json` contract are removed. The dedicated full-screen Review Workspace entered from the repository screen with `b` (and closed with `Escape`) replaces it.
>
> **Cutover notes (do not duplicate the spec):**
> - **Storage isolation:** Working Tree and Stash review progress now live in `working-tree-review-state-v1.json`; Branch Review uses only the v2 store at `.git/githunk/review-state-v2.json` (`version: 2`, `baseByHead`, `reviews`). No record from the combined `review-state-v1.json` is migrated; that file is intentionally ignored.
> - **Immutable artifacts:** each finished review writes one JSON file at `.git/githunk/reviews/<review-id>/<artifact-id>.json` (`ReviewArtifactV1`) and offers deterministic Markdown derived from that artifact for clipboard/export. Artifacts are exclusive-create and digest-verified; retries reuse the same artifact id.
> - **Dedicated keys (§5.4):** `j`/`k`/`arrows` row scroll, `]`/`[` next/prev hunk, `.`/`,` next/prev file, `n`/`N` next/prev unreviewed/invalidated, `}`/`{` next/prev pending feedback, `/` filter, `tab` focus cycle, `v` range, `c` create feedback, `r` Viewed, `0`/`1`/`2` layout auto/split/stack, `R` finish, `?` help, `Escape` close.
> - **Read-only invariant:** Branch Review never invokes repository mutation Git commands; working-tree changes never appear in the `base...HEAD` document.

Original 8.2 description (branch `base...HEAD` aggregate) is retained here only as historical context; product behavior is defined by the superseding spec.

Default (historical):

Designed primarily for formal coding-agent work where agents commit their changes.

```text
base...HEAD
```

This represents the complete change set introduced by the branch since it diverged from its review base.

The user reviews the aggregate result rather than being forced through commits sequentially.

---

# 9. Automatic Base Selection
v0.1 should automatically infer a likely review base.

The chosen base must always be shown prominently.

Example:

```text
feature/payment
vs origin/main
```

Base inference should prefer reliable repository information such as the primary remote's default branch.

If githunk cannot determine a base with sufficient confidence, it should prompt the user instead of silently selecting a questionable base.
The selected value may be remembered locally (Branch Review now persists the chosen `baseRef` per head in `.git/githunk/review-state-v2.json` under `baseByHead`; key is the canonical head ref or `detached:<oid>`).

> **Branch Review note:** inference rules above still describe Branch Review base selection (§5.1 of the superseding spec), but the old `review-state-v1.json` storage and `BranchReviewSnapshot` loader are removed. The dedicated workspace loads the remembered base from the v2 store or infers/prompts per the same rules, then builds a `ReviewDocument` for `base...HEAD`.

The complete **Compare Against Arbitrary Base** interface is deferred to v0.2.

---

# 10. Precise Patch Selection

This is a release-blocking githunk capability.

The patch pane must behave as an application-aware text document.

Given:

```text
┌────────────────────┬────────────────────────────────────┐
│ FILES              │ PATCH                              │
│                    │                                    │
│ foo.ts             │ - const old = foo();              │
│ bar.ts             │ + const value = foo();            │
│ baz.ts             │ + console.log(value);             │
│                    │                                    │
└────────────────────┴────────────────────────────────────┘
```

dragging inside Patch across multiple rows must never accidentally include:

```text
foo.ts
bar.ts
baz.ts
```

because those cells happen to share terminal rows.

Selection must operate on patch content, not terminal screen rows.

---

# 11. Copy UX

Copy is a first-class review operation.

At minimum v0.1 should support:

### Copy selected text

Return exactly the text selected inside the patch/document.

### Copy selected added code

For:

```diff
- const value = oldValue;
+ const value = calculateValue();
+ console.log(value);
```

produce:

```text
const value = calculateValue();
console.log(value);
```

### Copy selected removed code

Produce the removed source without unrelated surrounding UI text.

### Copy as patch

Preserve enough patch information for the selection to be shared or reapplied where practical.

### Copy whole hunk / file patch

Provide quick keyboard operations without requiring manual selection.

Copy functionality should be accessible through familiar keyboard interaction as well as mouse selection.

---

# 12. SSH Clipboard

v0.1 must support remote clipboard workflows.

Preferred behavior:

```text
selection
    ↓
githunk
    ↓
clipboard abstraction
    ↓
OSC52 / compatible mechanism
    ↓
local terminal
    ↓
local system clipboard
```

OpenTUI currently exposes OSC52 clipboard functionality intended to work over SSH, although terminal policy may reject OSC52.

Therefore v0.1 must test and document a compatibility matrix rather than assuming API invocation guarantees clipboard delivery.

Important environments:

* local terminal;
* SSH;
* SSH + tmux;
* SSH + zellij.

Failure should be understandable rather than silent whenever practical.

---

# 13. Review Progress

v0.1 includes lightweight per-file review progress.

States:

```text
○ not reviewed
◐ reviewing
● reviewed
! changed after review
```

The user can explicitly mark a file reviewed.

Review progress should persist across githunk restarts.

> **Branch Review cutover:** For Branch Review, persistence is now `.git/githunk/review-state-v2.json` and immutable artifacts at `.git/githunk/reviews/<review-id>/<artifact-id>.json`. The old combined `review-state-v1.json` is not read or migrated for Branch Review; Working Tree and Stash progress continue in `working-tree-review-state-v1.json` (starts empty, restricted to those targets). See superseding spec §12–§13.

Persistence must:

* remain local to the repository/user;
* not dirty the working tree;
* not accidentally become committed project state.

---

## 13.1 Change invalidation
When a reviewed file changes after being marked reviewed:

```text
● reviewed
    ↓
file content changes
    ↓
! changed after review
```

This is particularly important when a coding agent continues working after the user has already reviewed part of its output.

---

# 14. Daily-Driver Git Core

v0.1 should contain enough common Git behavior that users do not need to return to lazygit during the normal coding-agent review flow.

## Files

* stage file;
* unstage file;
* stage hunk;
* unstage hunk;
* stage selected lines;
* unstage selected lines;
* discard file changes;
* discard hunk/selected changes where safely supported.

## Commit

* commit;
* amend;
* edit commit message.

## Branches

* local branch list;
* switch;
* create;
* delete;
* rename.

## Remotes

* list;
* fetch;
* browse remote branches;
* checkout remote branch to local tracking branch.

## History

* commit list;
* inspect commit;
* inspect commit files/diff.

## Stash

* list;
* inspect;
* apply;
* pop;
* drop.

## Synchronization

* fetch;
* pull;
* push.

## General

* command log;
* search/filter;
* keyboard navigation;
* mouse scrolling/focus where appropriate.

---

# 15. Lazygit Compatibility

githunk should maintain a compatibility table for common lazygit shortcuts.

Examples of behaviors worth preserving include lazygit's current conventions for push/pull, filtering, remotes, remote branches and stash operations.

Compatibility is a product requirement, not an implementation requirement.

The goal is:

> A lazygit user should be able to open githunk and perform ordinary Git work mostly from muscle memory.

Exact compatibility is not required for advanced or review-specific features.

---

# 16. Selection Spike

Before committing the main application to OpenTUI, implement a disposable interaction spike.

The spike should **not** implement Git.

Use deterministic fixtures.

```text
┌────────────────────┆──────────────────────────────────────────────┐
│ LEFT               ┆ PATCH                                      │
│                    ┆                                            │
│ foo.ts             ┆ @@ -10,6 +10,8 @@                          │
│ bar.ts             ┆                                            │
│ baz.ts             ┆ - const old = foo();                       │
│ 中文檔案.ts        ┆ + const value = foo();                     │
│ 🚀.ts              ┆ + console.log(value);                      │
│                    ┆                                            │
└────────────────────┴──────────────────────────────────────────────┘
                     ↑
              draggable splitter
```

OpenTUI currently exposes selectable code renderables, making it a strong candidate for this interaction model.

---

## 16.1 Spike fixture requirements

Include:

* ASCII;
* Chinese text;
* emoji;
* tabs;
* blank lines;
* long paths;
* long source lines;
* wrapped source lines;
* line numbers;
* syntax highlighting;
* multiple hunks.

The goal is to expose differences between:

```text
terminal cells
Unicode characters
JavaScript string positions
wrapped visual rows
logical source lines
```

---

## 16.2 Spike acceptance criteria

### S1 — Basic pane isolation

Select five lines entirely inside Patch.

Clipboard contains only Patch text.

### S2 — Partial first/last lines

Begin and end selection in the middle of lines.

Copied content exactly follows those logical character boundaries.

### S3 — Adjacent pane contamination

Fill the left pane with text on every terminal row.

A multiline Patch selection must contain **zero left-pane text**.

### S4 — Scrolling

Scroll the Patch pane and select visible text.

Copied text corresponds to the correct underlying logical lines.

### S5 — Wrapped lines

Select text spanning a wrapped source line.

Clipboard output reconstructs the logical source text correctly.

### S6 — Unicode

Selection works correctly with:

* CJK;
* emoji;
* wide characters;
* combining characters where relevant.

### S7 — Terminal resize

Resize the terminal before and during ordinary use.

Selection mapping remains correct.

### S8 — Vertical splitter

Resize left/right regions using the mouse.

Selection and resize interactions remain independent.

### S9 — Command-log splitter

Resize Main/Command Log vertically.

### S10 — OSC52 local

Selected text reaches the local clipboard in a compatible terminal.

### S11 — SSH

Selected text reaches the client clipboard from a remote githunk process.

### S12 — tmux / zellij

Record confirmed behavior and required configuration for both environments.

---

# 17. Technology Decision Gate

OpenTUI is the preferred framework **only if the Selection Spike succeeds**.

Reasons for evaluating it first:

* application-aware selection;
* selectable code/text renderables;
* mouse interaction;
* OSC52 clipboard support.

If OpenTUI cannot reliably satisfy pane-isolated selection, Unicode/wrapping behavior, resizing, or remote clipboard requirements, the project should reconsider the UI framework before building the Git functionality.

Possible fallback:

```text
Ratatui
+
custom document/selection abstraction
```

The spike is disposable.

Its purpose is to answer the framework question, not become the foundation of the application.

---

# 18. v0.1 Non-Goals

The following are explicitly not required for v0.1:

* complete lazygit feature parity;
* interactive rebase;
* advanced cherry-pick workflows;
* merge-conflict editor;
* bisect;
* submodule management;
* worktree management;
* editing remote URLs;
* GitHub/GitLab PR management;
* issue management;
* AI-generated reviews;
* AI-generated commit messages;
* collaboration/comment threads;
* plugin system;
* semantic diff;
* dependency/blast-radius analysis;
* arbitrary-base comparison UI.

These can be reconsidered after the review core proves useful.

---

# 19. v0.2 Review Enhancements

## 19.1 Compare Against Arbitrary Base

Allow selecting:

* local branch;
* remote branch;
* tag;
* commit.

Then review:

```text
selected-base...HEAD
```

This extends the automatic Branch Review model rather than replacing it.

---

## 19.2 Sticky File / Hunk Header

When scrolling through a large diff, retain context such as:

```text
src/payment/service.ts

class PaymentService
capturePayment()
────────────────────────────
```

The user should not lose track of which file or hunk they are reviewing.

---

## 19.3 Side-by-Side Diff

Provide an alternate view:

```text
┌─────────────────────────┬─────────────────────────┐
│ Before                  │ After                   │
│                         │                         │
│ return oldValue;        │ const x = newValue;    │
│                         │ return x;               │
└─────────────────────────┴─────────────────────────┘
```

Selection remains document-aware.

Potential semantics:

```text
select left  → old code
select right → new code
```

---

# 20. Later Review Intelligence

## 20.1 Semantic / Symbol-Aware Diff

Move beyond raw hunks.

Example:

```text
src/order.ts

class OrderService
└── calculateTotal()
    ├── discount logic changed
    └── tax calculation changed
```

Potential implementation may use Tree-sitter or another language-aware parser.

This must complement rather than hide the raw Git diff.

---

# 21. Blast Radius / Risk Review

Long-term, githunk should help answer:

> The coding agent changed this file or function. What else could it have broken?

A future integration may use a provider such as **code-review-graph**.

code-review-graph currently models functions, classes, imports, calls, inheritance and tests using Tree-sitter-backed graph data, and exposes blast-radius analysis including callers, dependents and potentially affected tests.

It also exposes review-oriented risk information such as affected flows and test gaps.

Possible githunk presentation:

```text
FILES
────────────────────────
🔴 payment.ts       HIGH
🟡 checkout.ts      MED
🟢 formatter.ts     LOW
```

Selecting `payment.ts`:

```text
IMPACT
────────────────────────
Risk          HIGH
Callers       12
Affected flows 3
Affected tests 4
Test gaps      2
```

The objective is **not** merely to draw a graph.

The objective is:

> Tell the reviewer where they should look next and why.

---

## 21.1 Review Intelligence Provider

githunk should avoid coupling its internal architecture permanently to one analysis engine.

Conceptual boundary:

```text
githunk
   │
   └── Review Intelligence Provider
          │
          ├── none
          ├── code-review-graph
          └── future provider
```

This is an architectural seam only in early versions.

v0.1 does not need to implement it.

---

# 22. Future Review Workflow

A mature githunk workflow may eventually become:

```text
Coding agent completes work
          ↓
githunk determines review target
          ↓
aggregate diff
          ↓
files ranked by risk
          ↓
review high-risk changes first
          ↓
inspect blast radius
          ↓
inspect affected callers/tests/flows
          ↓
mark reviewed
          ↓
agent modifies file again
          ↓
review automatically invalidated
          ↓
complete review
          ↓
stage / commit / push
```

This is the long-term product direction.

---

# 23. v0.1 Success Criteria

githunk v0.1 is successful when the following workflow can be completed without opening lazygit:

```text
open repository
      ↓
identify review target
      ↓
review coding-agent output
      ↓
copy exact patch/code selections
      ↓
track reviewed files
      ↓
stage/unstage selected changes
      ↓
commit/amend
      ↓
switch branches if needed
      ↓
checkout remote branch if needed
      ↓
pull/fetch/push
```

In addition:

1. Selecting text in the right-side patch pane must never accidentally copy adjacent left-pane content.
2. SSH clipboard must work in at least a documented set of commonly supported terminals.
3. Left/right and Main/Command Log regions must be mouse-resizable.
4. Common lazygit keyboard muscle memory must remain recognizable.
5. Both Working Tree and `base...HEAD` Branch Review must be first-class workflows.
6. The currently active review target and branch base must always be visible.
7. Reviewed files that change again must be visibly invalidated.
8. Remote branches must be browsable and directly switchable to local tracking branches.

---

# 24. Major Risks

## OpenTUI selection behavior

The framework appears well aligned with githunk's requirements, but the critical interaction must be proven through the spike before committing the project to it.

## OSC52 compatibility

OSC52 depends partly on terminal and multiplexer policy. Capability detection cannot guarantee that every terminal accepted the clipboard operation.

## Partial staging correctness

Mapping arbitrary user-selected lines into valid Git patches can have edge cases.

This functionality requires extensive tests around:

* neighboring hunks;
* context lines;
* additions;
* deletions;
* mixed changes;
* renamed files;
* line-ending differences.

## Review-state invalidation

Review progress must be tied to the content or review target strongly enough that stale `reviewed` states are never misleading.

## Automatic base inference

Git does not universally encode the intended PR/base branch.

When confidence is low, githunk must prefer asking or clearly warning rather than presenting an incorrect review range as authoritative.

---

# 25. Roadmap Summary

```text
SPIKE
──────────────────────────────
OpenTUI
panel-aware selection
Unicode / wrapping
mouse resize
OSC52 / SSH / tmux / zellij


v0.1
──────────────────────────────
daily-driver Git core
lazygit muscle memory
Working Tree Review
Branch Review: base...HEAD
precise copy
SSH clipboard
review progress
remote branch → local checkout
resizable layout


v0.2
──────────────────────────────
arbitrary base
sticky headers
side-by-side diff
additional review ergonomics


v0.3+
──────────────────────────────
semantic/symbol-aware diff
blast-radius analysis
risk indicators
affected tests / callers / flows
review intelligence providers
```

---

# 26. Product Identity

**Name:** githunk

Suggested positioning:

> **githunk — a Git TUI built for reviewing coding-agent changes.**

Alternative short description:

> **A review-first Git TUI with precise patch selection, SSH clipboard, and lazygit muscle memory.**

Long-term positioning:

> **Understand what changed, what it affects, and what you still need to review.**

