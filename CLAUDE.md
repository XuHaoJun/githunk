## What this is

githunk is a **review-first Git TUI**: lazygit's layout, keybindings and everyday Git
functionality, plus the things lazygit does not do — selecting and copying exact patch text out of
the right-hand pane without dragging in left-pane cells, per-file review progress, and
mouse-draggable splitters. See `docs/githunk-prd-v0.1.md` (§1–3 for the product idea, §19 for the
v0.2 scope: arbitrary compare base, sticky file/hunk header, side-by-side diff).

Bun + TypeScript, one runtime dependency: `@opentui/core` (version floats; `bun.lock` is the pin).

## Commands

```bash
bun run check                       # tsc --noEmit && bun test — the gate; never commit red
bun run typecheck
bun test
bun test tests/ui/layout.test.ts    # one file
bun test -t "computeLayout side"    # one describe/it by name
bun run start                       # run the TUI in the current repository
bun run dev                         # same, with --watch
bun run spike:selection             # the disposable PRD §16 selection spike
bun run build:bin                   # host standalone binary → dist/githunk
```

`*.integration.test.ts` and `tests/acceptance/*` spawn real `git` against temp repositories
(`tests/helpers/temp-repository.ts`, `tests/helpers/shell-harness.ts` — the latter also drives a
real `createTestRenderer` with mock keys/mouse and captures frames). They are slower and need `git`
on PATH; plain `*.test.ts` files are pure unit tests over injected loaders. Branch Review acceptance is
`tests/acceptance/branch-review-workspace.integration.test.ts` (coverage/reconciliation) and
`tests/acceptance/branch-review-artifact.integration.test.ts` (feedback/artifact/transaction recovery).

## Architecture

One-way data flow. Nothing in `src/domain` or `src/git` knows about the UI; the UI never spawns git.

```
GitRunner ──► src/git/*  ──► AppController ──► AppModel (immutable snapshot)
 (spawns)     (parsing)      (src/app)              │
                                                    ▼
                                        RootView.update(model) ──► panes ──► OpenTUI
```

- **`src/domain/`** — types and pure functions only (`AppModel` lives in `domain/repository.ts`;
  `model.ts` just re-exports it). `ReviewTarget` is the central discriminated union:
  `working-tree | branch | commit | stash`.
- **`src/git/`** — everything that shells out. All of it goes through `GitRunner.run()`, which
  spawns `git --no-pager`, pins `LC_ALL=C`, and appends a `CommandRecord` to the `CommandLog` that
  backs the Command Log pane. `readOnly` sets `GIT_OPTIONAL_LOCKS=0`; `optionalLocks` is the one
  documented exception (a *foreground* status is allowed to persist git's stat-cache).
- **`src/app/controller.ts`** — the only mutable state holder. Every loader is injectable
  (`loadCommits`, `loadBranches`, `inferBase`, …), which is how unit tests avoid git entirely.
  Writes are serialised through `MutationQueue`.
- **`src/ui/root-view.ts`** — ~3400 lines, deliberately the single owner of view state, focus,
  gestures and dispatch. Read `handleAction` first; it is the exhaustive switch over `Action`.
- **`src/app/create-app.ts`** — the wiring seam. Every controller call is wrapped in
  `try { … } finally { view.update(controller.state) }`. A `renderer`-less `createApp` returns a
  headless app (no timers, no `gh`) for tests.

### Things worth knowing before editing

**`runUiMutation` is the choke point.** Every UI-driven git write goes through it. It sets
`view.isMutating` (which pauses all background routines, lazygit's `backgroundRefreshesPaused`) and
fires `onMutationSettled` in its `finally` (which re-seeds `RefsWatcher`'s baseline so githunk's own
writes are not reported back as external changes). New mutations must use it.

**Keybindings are data.** `GITHUNK_BINDINGS` in `src/ui/bindings.ts` maps keys → `Action` per
`BindingContext` (a `FocusId`, `"global"`, or `"modal"`); the same table drives the hints bar and the
`?` menu. Resolution is availability-aware — an unavailable context binding falls through to the
global binding for that key — so `resolve`/`dispatch` callers **must** pass both `model` and `ui`.
Add a key by adding a binding plus a `case` in `handleAction`, never by pattern-matching raw keys.

**Layout is a pure function.** `computeLayout(terminal, request)` in `src/ui/layout.ts` (over the
`boxlayout.ts` engine) returns a `LayoutGeometry`; a window absent from `geometry.windows` is hidden.
Splitter drags just feed it a new `sidePanelRatio` / `logHeight`. Test layout changes against
`computeLayout` directly, not through the view.

**Panes share machinery.** `createPane`/`PaneHandle` (`panes/common.ts`), `ListState` with stable
row ids (`list-view.ts`, columns carry a `priority` for width-based truncation), and `PanelState`
for the tabbed side windows plus their transient drill-down children (`panel-state.ts`).
Async main-pane content must go through `MainPreviewGate` (`main-preview.ts`) — a monotonic
generation counter that discards stale previews when the selection moved on.

**The diff pipeline is the product.** `parse.ts` → `DiffDocument` (every line carries
`startUtf16`/`endUtf16` into the raw patch) → `render.ts` builds the display text plus
`displayToRaw` / `segments` maps → `selection.ts` maps OpenTUI's native selection *back* to raw
patch offsets (handling wide chars, combining marks and wrapped rows) → `transform.ts` produces the
`CopyMode` variants (`text | added | removed | patch | hunk | file`). Copy is OSC52-only via
`ui/clipboard.ts`; delivery is never assumed to have worked (`docs/clipboard-compatibility-v0.1.md`).

**Two OpenTUI performance rules, both load-bearing.** `panes/pane-text.ts` is the *only* place that
touches OpenTUI internals: assigning `TextRenderable.content` costs chunks × lines, so text
goes in unstyled via the buffer's `setText` and colour arrives as line-indexed highlights.
`panes/diff-text.ts` then paints only the rows near the viewport.

**Background routines** (`app/background.ts`) mirror lazygit's three: fetch (60s), working-tree
refresh (10s), external-ref detection (2s, via `RefsWatcher` + `git/refs-snapshot.ts`). Off unless
`createApp` is given `background.enabled`; tunable through `GITHUNK_BACKGROUND`,
`GITHUNK_AUTO_FETCH`, `GITHUNK_AUTO_REFRESH`, `GITHUNK_DETECT_EXTERNAL_CHANGES`,
`GITHUNK_FETCH_INTERVAL`, `GITHUNK_REFRESH_INTERVAL`, `GITHUNK_EXTERNAL_CHANGE_INTERVAL`.

**Persistence lives under `.git/`, never the worktree** — `.git/githunk/ui-state-v1.json` (pane
geometry) and, for review progress, `.git/githunk/review-state-v2.json` (Branch Review, `version: 2`) plus immutable artifacts at `.git/githunk/reviews/<review-id>/<artifact-id>.json`, and `.git/githunk/working-tree-review-state-v1.json` (Working Tree/Stash, restricted and starting empty — no migration from the old combined `review-state-v1.json`). All are written atomically at mode `0600` by `storage/local-state-file.ts`, which refuses symlinked paths. `git status` must stay clean.

## Release

Prebuilt `bun --compile` binaries per platform (hunk's shape in `learn-projects/hunk`):
meta package `@xuhaojun/githunk` plus five optional platform packages
(`@xuhaojun/githunk-{linux,darwin}-{x64,arm64}`, `@xuhaojun/githunk-windows-x64`).
`bin/githunk.js` execs the installed platform binary when present and falls back to the
Node bundle (`dist/githunk.js`, needs Node 26.1+) otherwise. `install.sh` puts the standalone
binary into `$GITHUNK_INSTALL_DIR` / `$XDG_BIN_HOME` / `~/.local/bin`;
`githunk update [version] [--check]` self-updates curl installs (npm installs go through npm).

```bash
# release: bump, push, tag — .github/workflows/release-prebuilt-npm.yml does the rest (~10 min)
git commit -m "chore: bump 0.4.0" && git push origin main
git tag v0.4.0 && git push origin v0.4.0
bun run stage:prebuilt:release      # CI form; local single-platform: bun run ./scripts/stage-prebuilt-npm.ts
bun run check:prebuilt-pack && bun run smoke:prebuilt-install
bun run publish:prebuilt:npm -- --dry-run --tag latest
```

Rules learned the hard way:
- Tag must equal `package.json` version (`scripts/check-release-version.ts` fails fast).
  Prerelease tags (`vX.Y.Z-beta.N`) publish to the `beta` dist-tag, never `latest`.
- Never move a tag after anything published; npm versions are immutable — bump instead.
  Retry via rerun-failed-jobs or `workflow_dispatch(publish=true)`.
- The `npm` environment must carry NO deployment branch policy: tags cannot satisfy
  branch rules and the publish job is rejected.
- npm trusted-publisher Organization must be `XuHaoJun` (exact case — the OIDC owner claim
  is case-sensitive); direct `npm publish` must be an allowed action.
- GitHub artifact names reject `/`, so matrix uploads use unscoped `artifact_name`; scoped
  names nest under `@scope/` dirs — always list/order staged packages through
  `listStagedPackageDirs` / `sortStagedForPublish`, never a flat readdir.
- x64 always compiles `-baseline` (the default runtime SIGILLs pre-Haswell CPUs; the workflow
  proves it under QEMU-emulated Nehalem); linux splits musl vs glibc.
- CLI version comes from a bundled `package.json` import (`src/cli/args.ts`) — never a
  filesystem walk, which returns `0.0.0-dev` inside compiled binaries.

## Working conventions

**lazygit is the specification.** It is vendored as a submodule at `learn-projects/lazygit`
(`git submodule update --init` if absent). When implementing parity behaviour, read the Go source
and cite it — `pkg/gui/background.go:169-208`, `user_config.go:1002` — in the code comment *and* the
commit message, the way the existing code and history do. Keybinding reference:
`learn-projects/lazygit/docs/keybindings/Keybindings_en.md`.

**Record parity status.** `docs/lazygit-compatibility-v0.1.md` holds the authoritative status matrix
(`compatible` / `githunk review extension` / `not yet implemented` / `blocked`). Exactly four things
are review extensions: main-pane selection/copy, the lower-right review area, draggable splitters,
and the command log's failed-command output block. Update the matrix when a row's status changes.

**Constraints.** No new runtime dependencies. `strict` TypeScript with `noUncheckedIndexedAccess`
and `exactOptionalPropertyTypes` — hence the pervasive
`...(x === undefined ? {} : { x })` spread idiom for optional fields; keep it rather than loosening
the compiler. Prefer `readonly` fields and `readonly T[]` params.

**Commits** use `feat:` / `fix:` / `refactor:` / `perf:` / `test:` / `docs:` prefixes with a
lowercase summary, and bodies that explain *why lazygit does it that way*, with file:line citations.
Match that depth.

**Claims are evidence-bounded.** `docs/release-checklist-v0.1.md` and the clipboard matrix
distinguish `Automated` / `Manual smoke observed` / `Not tested`. Do not upgrade a status without
running the thing.
**`.superpowers` is local-only (prefer A).** `.superpowers/` is gitignored (`.gitignore:2`) — never `git add -f` it. Task evidence stays local via `local://`/`artifact://` or PR description; only `docs/superpowers/` (no dot) is tracked for specs/plans.
