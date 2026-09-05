## Project

githunk is a review-first Git TUI: lazygit's layout, keybindings and everyday Git workflow,
plus exact patch selection/copy, per-file review progress and draggable splitters.
Bun + strict TypeScript + OpenTUI; Branch Review uses React. `package.json` defines commands
and dependencies; `bun.lock` pins the dependency graph. Do not add runtime dependencies.

## Working rules

- **lazygit is the parity specification.** Read the vendored Go source in
  `learn-projects/lazygit` (`git submodule update --init` if absent). Cite the relevant
  `file:line` in code comments and commit bodies, explaining why the behavior exists.
  Examples: `pkg/gui/background.go:169-208`, `user_config.go:1002`.
  Key reference: `learn-projects/lazygit/docs/keybindings/Keybindings_en.md`.
- **Record parity changes** in `docs/lazygit-compatibility-v0.1.md`, the authoritative matrix:
  `compatible` / `githunk review extension` / `not yet implemented` / `blocked`.
  Its four review extensions are main-pane selection/copy, the lower-right review area,
  draggable splitters and the command log's failed-command output block.
- **Preserve strictness:** `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`,
  `readonly` fields and `readonly T[]` parameters. Use the existing optional-field idiom
  `...(x === undefined ? {} : { x })`; do not loosen compiler settings.
- **Commits:** lowercase summaries with `feat:` / `fix:` / `refactor:` / `perf:` / `test:` /
  `docs:` prefixes. Parity changes need the source citations and rationale above.
- **Evidence bounds claims.** Keep `Automated`, `Manual smoke observed` and `Not tested`
  distinct in release/clipboard documentation. Never upgrade a status without running it.
- **Local evidence stays local.** `.superpowers/` is gitignored; never `git add -f` it.
  Use `local://`, `artifact://` or the PR description for task evidence. Tracked specs/plans
  belong under `docs/superpowers/` (no leading dot).

## Commands and verification

```bash
bun run check                       # gate: typecheck + project tests; never commit red
bun run typecheck
bun run test                        # excludes learn-projects/**
bun test tests/ui/layout.test.ts     # focused file
bun test -t "computeLayout side"     # focused test name
bun run start                       # TUI in the current repository
bun run dev                         # watch mode
bun run build:bin                   # host standalone binary → dist/githunk
bun run spike:selection             # disposable PRD §16 selection spike
```

Integration tests and `tests/acceptance/*` use real Git/temp repositories and/or the OpenTUI
renderer harness; inspect the test's helpers rather than assuming every `.test.ts` is pure.
`tests/helpers/temp-repository.ts` supplies repositories; `tests/helpers/shell-harness.ts`
drives `createTestRenderer`, mock keys/mouse and captured frames. Branch Review acceptance:
- `tests/acceptance/branch-review-workspace.integration.test.ts`: coverage/reconciliation.
- `tests/acceptance/branch-review-artifact.integration.test.ts`: feedback/artifacts/recovery.

## Architecture and entry points

Repository data flows one way: `GitRunner` → Git loaders → `AppController` → immutable
`AppModel` → `RootView.update(model)` → panes → OpenTUI. Domain/Git layers do not know the UI;
the UI does not spawn Git.

| Area | Ownership / starting point |
| --- | --- |
| `src/domain/` | Pure types/functions. `AppModel` lives in `repository.ts`, re-exported by `src/app/model.ts`. `ReviewTarget`: `working-tree \| branch \| commit \| stash`. |
| `src/git/` | Git operations through `GitRunner.run()`: `git --no-pager`, `LC_ALL=C`, command logging. `readOnly` sets `GIT_OPTIONAL_LOCKS=0`; `optionalLocks` allows foreground status to persist its stat-cache. |
| `src/app/controller.ts` | Repository state; injectable loaders for tests; writes serialized through `MutationQueue`. |
| `src/ui/root-view.ts` | Repository view state, focus, gestures and dispatch. Start at `handleAction`. |
| `src/app/create-app.ts` | Wiring seam; preserve `try { … } finally { view.update(controller.state) }` around repository controller calls. Without a renderer, `createApp` is headless (no timers or `gh`). |
| `src/app/screen-controller.ts` | `AppScreenController` switches repository/Branch Review screens and restores repository focus/selection. |
| `src/ui/review-workspace/` | Branch Review controller and React UI (`ReactReviewHost`, `ReviewWorkspaceApp.tsx`). |
| `src/review/` | Review core, Git document/projection loaders, highlighting and persistence. |

### Load-bearing UI contracts

- **Mutations:** UI-driven Git writes must use `runUiMutation`. Its `isMutating` state pauses
  background Git; `onMutationSettled` runs in `finally` to reseed `RefsWatcher`, preventing
  the app's own writes from appearing as external changes.
- **Keys:** `GITHUNK_BINDINGS` in `src/ui/bindings.ts` maps context/key → `Action` and drives
  hints and `?`. Add a binding and a `handleAction` case, not raw-key matching. Pass both
  `model` and `ui` to resolution/dispatch: unavailable context bindings fall through to global.
- **Layout:** `computeLayout(terminal, request)` in `src/ui/layout.ts` uses `boxlayout.ts`.
  Missing `geometry.windows` entries are hidden. Splitters change `sidePanelRatio` / `logHeight`;
  test geometry through `computeLayout`, not the view.
- **Panes:** reuse `createPane` / `PaneHandle` (`src/ui/panes/common.ts`), stable row IDs in
  `ListState` (`src/ui/list-view.ts`, column `priority` controls truncation), and `PanelState`
  (`src/ui/panel-state.ts`) for tabs/drill-downs. Async repository main-pane content must use
  `MainPreviewGate` (`src/ui/main-preview.ts`) to discard stale selection generations.
- **Text performance:** keep pane buffer internals behind `src/ui/panes/pane-text.ts`.
  Avoid bulk `TextRenderable.content` assignment (chunks × lines); use unstyled buffer
  `setText` plus line-indexed highlights. `src/ui/panes/diff-text.ts` paints near the viewport.

### Patch selection and copy

In `src/domain/diff/`: `parse.ts` → `DiffDocument` with raw `startUtf16`/`endUtf16` offsets →
`render.ts` with `displayToRaw` / `segments` → `selection.ts` mapping native selection back to
raw patch offsets → `transform.ts` copy modes (`text | added | removed | patch | hunk | file`).
Preserve wide-character, combining-mark and wrapped-row handling. Copy is OSC52-only through
`src/ui/clipboard.ts`; delivery is never assumed. See `docs/clipboard-compatibility-v0.1.md`.

### Background work and persistence

`src/app/background.ts` mirrors lazygit's fetch (60s), working-tree refresh (10s) and
external-ref detection (2s; `RefsWatcher` + `src/git/refs-snapshot.ts`). Disabled unless
`createApp` receives `background.enabled`. Environment controls: `GITHUNK_BACKGROUND`,
`GITHUNK_AUTO_FETCH`, `GITHUNK_AUTO_REFRESH`, `GITHUNK_DETECT_EXTERNAL_CHANGES`,
`GITHUNK_FETCH_INTERVAL`, `GITHUNK_REFRESH_INTERVAL`, `GITHUNK_EXTERNAL_CHANGE_INTERVAL`.

State belongs under Git metadata, never in the worktree. `src/storage/local-state-file.ts`
resolves the Git path, refuses symlinked paths and writes atomically with mode `0600`.
Normal `.git/` layout:
- `githunk/ui-state-v1.json`: pane geometry.
- `githunk/review-state-v2.json`: Branch Review (`version: 2`).
- `githunk/reviews/<review-id>/<artifact-id>.json`: immutable review artifacts.
- `githunk/working-tree-review-state-v1.json`: restricted Working Tree/Stash progress;
  starts empty, with no migration from the old combined `review-state-v1.json`.

Persistence must not dirty `git status`.

## Release (read when packaging/publishing)

`.github/workflows/release-prebuilt-npm.yml` builds and publishes tagged releases.
`@xuhaojun/githunk` has five optional platform packages:
`@xuhaojun/githunk-{linux,darwin}-{x64,arm64}` and `@xuhaojun/githunk-windows-x64`.
`bin/githunk.js` prefers the platform binary, falling back to `dist/githunk.js` (Node 26.1+).
`install.sh` installs to `$GITHUNK_INSTALL_DIR` / `$XDG_BIN_HOME` / `~/.local/bin`;
`githunk update [version] [--check]` updates curl installs; npm installs update through npm.

Bump `package.json`, commit/push, then push the matching `v<version>` tag. Do not copy a
hardcoded version from documentation. Packaging checks (require built/staged artifacts):

```bash
bun run stage:prebuilt:release       # CI artifact root; local: bun run ./scripts/stage-prebuilt-npm.ts
bun run check:prebuilt-pack
bun run smoke:prebuilt-install
bun run publish:prebuilt:npm -- --dry-run --tag latest  # use beta for prereleases
```

Release traps to preserve:
- Tags must match `package.json` (`scripts/check-release-version.ts`). Beta prereleases publish
  to `beta`, never `latest`. Never move a published tag; npm versions are immutable. Bump, or
  retry failed jobs / `workflow_dispatch(publish=true)` as appropriate.
- The GitHub `npm` environment must have no deployment branch policy: tags cannot satisfy it.
  npm trusted-publisher Organization must be exactly `XuHaoJun` (case-sensitive OIDC claim),
  with direct `npm publish` allowed.
- Artifact names cannot contain `/`: use unscoped `artifact_name`. Staged scoped packages nest
  under `@scope/`; use `listStagedPackageDirs` / `sortStagedForPublish`, not flat `readdir`.
- x64 builds must use `-baseline` to avoid SIGILL on pre-Haswell CPUs; CI checks under
  QEMU Nehalem. Preserve Linux musl/glibc handling.
- CLI version uses bundled `package.json` (`src/cli/args.ts`), never a filesystem walk:
  compiled binaries otherwise report `0.0.0-dev`.

## Further references

- `docs/githunk-prd-v0.1.md`: product (§1–3), selection spike (§16), v0.2 scope (§19).
- `docs/lazygit-compatibility-v0.1.md`: authoritative parity status.
- `docs/release-checklist-v0.1.md`: release verification/evidence.
- `docs/clipboard-compatibility-v0.1.md`: terminal clipboard compatibility/evidence.
