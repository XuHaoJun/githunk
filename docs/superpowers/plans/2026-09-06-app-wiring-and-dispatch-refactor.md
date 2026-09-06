# App Wiring and Dispatch Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `RootView`'s 47 optional callbacks with required port interfaces and a single `create-app` update wrapper, collapse `AppController`'s repeated state/error/refresh boilerplate into three helpers, and route every Branch Review intent through `ReviewWorkspaceController.dispatchIntent`.

**Architecture:** Three independent, behaviour-preserving refactors, one commit each. Scope 1 moves the UI → controller callback surface into `src/ui/root-view-ports.ts` and wraps the `create-app` handlers with `ui()` / `repositoryUi()`. Scope 2 adds `describeGitError`, `AppController.setState` and `loadAuxiliary`, then table-drives `refresh()` and deletes the loader alias options. Scope 3 rewrites `ReviewWorkspaceApp.tsx` dispatch sites to `controller.dispatchIntent(intent)`.

**Tech Stack:** Bun 1.4, strict TypeScript (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`), OpenTUI, React (Branch Review only), `bun test`.

Spec: `docs/superpowers/specs/2026-09-06-app-wiring-and-dispatch-refactor-design.md`.

## Global Constraints

- Branch: `refactor/app-wiring-and-dispatch` (already checked out).
- Do not add runtime dependencies. Do not loosen `tsconfig.json`.
- Preserve `readonly` fields, `readonly T[]` parameters and the optional-field idiom `...(x === undefined ? {} : { x })`.
- No user-visible behaviour change; `docs/lazygit-compatibility-v0.1.md` is not touched.
- Commit messages: lowercase, `refactor:` / `test:` prefix, body ending with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- Never commit red: `bun run check` (typecheck + tests) must pass before each commit.
- Exactly three commits, one per scope, with the summaries in the spec's Delivery table. Intermediate tasks end at a `bun run typecheck` checkpoint, not a commit.
- Cite lazygit `file:line` only where existing comments already do; this plan moves code and keeps those comments intact.

---

## Scope 1 — RootView ports and the create-app wrapper

### Task 1: Create `src/ui/root-view-ports.ts`

**Files:**
- Create: `src/ui/root-view-ports.ts`

**Interfaces:**
- Consumes: existing domain/git types only.
- Produces: `RepositoryCommands`, `RepositoryQueries`, `ViewHost`, `RootViewPorts` (used by Task 2 and Task 3).

Every signature below is copied from `RootViewOptions` at `src/ui/root-view.ts:203-265` with the `?` removed. `onFilterBranches` is omitted: `RootView` stores it (`root-view.ts:384,481`) but never calls it, so it is dead and is dropped here rather than carried into the ports.

- [ ] **Step 1: Write the file**

```ts
import type { DiffDocument } from "../domain/diff/document"
import type { DiscardFileMode, WorkingTreeScope } from "../domain/review-target"
import type { BranchDeleteRequest } from "../domain/branch"
import type { CommitDetails, CommitSummary } from "../domain/commit"
import type { TagPreview, TagSummary } from "../domain/tag"
import type { RefLogTarget } from "../git/ref-log"
import type { CheckoutRemoteTrackingResult, CreateBranchOptions, RemoteBranchSelection } from "../git/branches"
import type { UiState as PersistedUiState } from "./ui-state-store"

/**
 * Everything the repository view asks the application layer to *do*. Each call changes the
 * repository or the controller's model; the wiring in `src/app/create-app.ts` repaints the view
 * once the call settles. Names keep their historical `on*` prefix so the move out of
 * `RootViewOptions` is a mechanical one; the prefix carries no meaning here.
 */
export type RepositoryCommands = {
  readonly onStageFile: (path: string) => Promise<void>
  readonly onStageFiles: (paths: readonly string[], stage: boolean) => Promise<void>
  readonly onUnstageFile: (path: string) => Promise<void>
  readonly onDiscardFile: (path: string, mode: DiscardFileMode) => Promise<void>
  readonly onDiscardFiles: (paths: readonly string[], mode: DiscardFileMode) => Promise<void>
  readonly onToggleAllFiles: () => Promise<void>
  readonly onScopeChange: (scope: WorkingTreeScope) => Promise<void>
  readonly onOpenBranchReview: () => Promise<void>
  readonly onApplySelection: (document: DiffDocument, indexes: readonly number[], reverse: boolean) => Promise<void>
  readonly onDiscardSelection: (document: DiffDocument, indexes: readonly number[]) => Promise<void>
  readonly onSelectFile: (path: string) => void
  /** Drops the 300-commit bound and reloads the full history; true when a reload happened. */
  readonly onExpandCommits: () => Promise<boolean>
  readonly onMarkFocusedFileReviewed: (path?: string) => Promise<void>
  readonly onCommitMessage: (message: string) => Promise<void>
  readonly onAmendMessage: (message: string) => Promise<void>
  readonly onCreateBranch: (startPoint?: string, branchName?: string, options?: CreateBranchOptions) => Promise<void>
  readonly onCreateBranchWithAutostash: (startPoint?: string, branchName?: string, options?: CreateBranchOptions) => Promise<void>
  readonly onRefresh: () => Promise<void>
  readonly onSwitchLocalBranch: (branch: string) => Promise<void>
  readonly onDeleteBranch: (request: BranchDeleteRequest) => Promise<void>
  readonly onDeleteBranches: (requests: readonly BranchDeleteRequest[]) => Promise<void>
  readonly onDeleteBranchFromWorktree: (path: string, action: "remove" | "detach", request: BranchDeleteRequest, forceWorktree?: boolean) => Promise<void>
  readonly onFetchRemote: (remote: string) => Promise<void>
  readonly onRenameBranch: (branch: string, newName?: string) => Promise<void>
  readonly onFetch: () => Promise<void>
  readonly onPull: () => Promise<void>
  readonly onPush: () => Promise<void>
  readonly onChooseUpstream: (remote: string, branch: string) => Promise<void>
  readonly onCancelUpstream: () => Promise<void>
  readonly onPopStash: (ref: string) => Promise<void>
  readonly onCreateStash: (message: string, includeUntracked: boolean) => Promise<void>
  readonly onApplyStash: (ref: string) => Promise<void>
  readonly onDropStash: (ref: string) => Promise<void>
  readonly onDropStashes: (refs: readonly string[]) => Promise<void>
  readonly onInspectStash: (ref: string) => Promise<void>
  readonly onBrowseRemote: (remote: string) => Promise<void>
  readonly onInspectBranch: (branch: string) => Promise<void>
  readonly onCheckoutRemoteTracking: (selection: RemoteBranchSelection, confirmedMismatch?: boolean) => Promise<CheckoutRemoteTrackingResult | undefined>
  readonly onEditFile: (path: string, line?: number) => Promise<void>
}

/** Read-only lookups the view renders from. None of these change the model. */
export type RepositoryQueries = {
  readonly loadCommitInspection: (oid: string) => Promise<CommitDetails>
  readonly loadBranchCommits: (branch: string) => Promise<readonly CommitSummary[]>
  readonly loadCommitFileInspection: (oid: string, path: string) => Promise<DiffDocument>
  readonly loadTagInspection: (tag: TagSummary) => Promise<TagPreview>
  readonly loadRefLogInspection: (target: RefLogTarget) => Promise<string>
  readonly onCurrentCommitMessage: () => Promise<string>
  readonly onCheckBranchMerged: (branch: string, upstream?: string) => Promise<boolean>
}

/** Hooks the view raises toward the process hosting it. */
export type ViewHost = {
  readonly onQuit: () => void
  readonly onGeometryChange: (state: PersistedUiState) => void
  /**
   * Fired whenever a git operation this view started has settled, however it settled. The single
   * choke point for "githunk just touched the repository": the refs watcher re-seeds its baseline
   * here, so githunk's own commits and checkouts are never mistaken for external ones.
   */
  readonly onMutationSettled: () => void
  readonly onPreviewError: (error: unknown) => void
  readonly isBranchReviewActive: () => boolean
}

export type RootViewPorts = {
  readonly commands: RepositoryCommands
  readonly queries: RepositoryQueries
  readonly host: ViewHost
}
```

- [ ] **Step 2: Typecheck**

Run: `bun run typecheck`
Expected: exit 0 (the file is not imported yet, but must compile).

### Task 2: `RootView` consumes `ports`

**Files:**
- Modify: `src/ui/root-view.ts` (options type `:203-265`, fields `:319-385`, constructor copies `:442-493`, ~100 call sites)

**Interfaces:**
- Consumes: `RootViewPorts` from Task 1.
- Produces: `new RootView(renderer, model, { sidePanelRatio?, logHeight?, logVisible?, ports })`. Task 3 depends on this constructor shape.

- [ ] **Step 1: Replace the options type**

Replace lines `203-265` (`export type RootViewOptions = { … }`) with:

```ts
export type RootViewOptions = {
  readonly sidePanelRatio?: number
  readonly logHeight?: number
  readonly logVisible?: boolean
  readonly ports: RootViewPorts
}
```

Add the import next to the other `./` imports:

```ts
import type { RootViewPorts } from "./root-view-ports"
```

The constructor signature loses its default: `constructor(renderer: CliRenderer, model: AppModel, options: RootViewOptions)`.

- [ ] **Step 2: Delete the 47 private callback fields and their constructor copies**

Delete every field of the form `private readonly onX: (…) | undefined` and `private readonly loadX: (…) | undefined` and `private readonly isBranchReviewActive: …` in the field block (`:319-385`, plus `onQuit`, `onGeometryChange`, `onMutationSettled` at `:425-427`). Add one field in their place:

```ts
  private readonly ports: RootViewPorts
```

In the constructor, delete the block `this.onStageFile = options.onStageFile` … `this.onMarkFocusedFileReviewed = options.onMarkFocusedFileReviewed` (`:442-493`) and write:

```ts
    this.ports = options.ports
```

Keep the doc comment that sat on `onMutationSettled` in `RootViewOptions`; it now lives in `ViewHost` (Task 1).

- [ ] **Step 3: Rewrite call sites mechanically**

Use these substitutions over the whole file (a scripted `sed` is fine; review the diff afterwards):

| From | To |
| --- | --- |
| `this.<name>?.(` where `<name>` is in `RepositoryCommands` | `this.ports.commands.<name>(` |
| `this.<name>!(` (commands) | `this.ports.commands.<name>(` |
| `this.<name>(` (commands, already unguarded) | `this.ports.commands.<name>(` |
| `this.<name>?.(` / `!(` / `(` for names in `RepositoryQueries` | `this.ports.queries.<name>(` |
| `this.onQuit?.()`, `this.onGeometryChange?.(`, `this.onMutationSettled?.()`, `this.onPreviewError?.(`, `this.isBranchReviewActive?.()` | `this.ports.host.<name>(` |
| `const checkMerged = this.onCheckBranchMerged` (`:2896`) | `const checkMerged = this.ports.queries.onCheckBranchMerged` |

Pass-through of a callback as a value (for example `this.onCheckBranchMerged` assigned to a local, or `this.loadCommitInspection` handed to `mainGate.request`) becomes the `this.ports.…` member; no `.bind` is needed because the wiring in create-app supplies arrow functions.

- [ ] **Step 4: Delete the presence guards and their dead branches**

Every guard listed by `grep -nE 'this\.(on[A-Z]|load[A-Z]|isBranchReviewActive)[A-Za-z]*\s*(===|!==)\s*undefined' src/ui/root-view.ts` is now unreachable. Handle each shape:

1. `if (this.onX === undefined) return` on its own line → delete the line.
2. `if (this.mutationInFlight || this.onX === undefined) return` → `if (this.mutationInFlight) return`.
3. `if (a === undefined || this.onX === undefined) return` → `if (a === undefined) return`.
4. `if (this.onX !== undefined) { body }` → `body` (unwrapped).
5. `if (cond && this.onX !== undefined)` → `if (cond)`.
6. Branches that only run when a callback is *absent* are deleted whole, including their body:
   - `actionEditFile` `:2226-2231` ("Edit not available in this context").
   - `actionDiscardSelection` `:2398-2402` ("batch discard is unavailable").
   - `beginBranchDelete` `:2886-2890` (worktree bottom-title fallback; the following `this.openWorktreeDeleteMenu(branch, worktree, request); return` stays).
   - `handleBranchDialogKey` `:3805` (`return true`) and `:3809-3813`: `autostashOperation` is always assigned, `operation` for rename is always assigned. Keep `if (operation === undefined) return true` only if `operation` can still be undefined after the rewrite; if TypeScript reports it as always defined, delete it.
   - `handleStashDialogKey` `:3847` (`return true`).
   - `requestRefLog` `:4298-4303` (the "No git behind the view" synchronous install; the `load`/`present`/`request` path is the only path left).
   - `syncPreviewForFocus` `:4400-4403` (`installSynchronous` fallback for a missing `loadCommitInspection`).
7. `openAmendDialog` `:3961` `if (this.onCurrentCommitMessage === undefined) return` → delete.

After this step `grep -c 'this\.on[A-Z]' src/ui/root-view.ts` must be 0 and `grep -c 'this\.load[A-Z]' src/ui/root-view.ts` must be 0 (remaining hits are `this.ports.…`).

- [ ] **Step 5: Typecheck**

Run: `bun run typecheck`
Expected: errors only in `src/app/create-app.ts` (it still passes the flat option bag). No errors in `src/ui/root-view.ts`. If TypeScript flags an unused local (`autostashOperation` never undefined, etc.), simplify as described in Step 4.

### Task 3: `create-app` wrapper and ports wiring

**Files:**
- Modify: `src/app/create-app.ts:272-480` (RefsWatcher `isBusy`, `new RootView(...)`), `:499-532` (BackgroundRefresher `isBusy`)
- Test: existing `tests/ui/dispatch.integration.test.ts`, `tests/app/create-app.test.ts`, `tests/app/create-app.integration.test.ts`

**Interfaces:**
- Consumes: `RootViewPorts` (Task 1), new `RootView` constructor (Task 2).
- Produces: nothing new outside the file.

- [ ] **Step 1: Add the helpers directly above `refsWatcher = new RefsWatcher({`** (`:272`)

```ts
  const shouldRender = (): boolean => screenController?.shouldRenderRepository() ?? true
  /** Repaints the repository screen from the controller's model, unless Branch Review owns the screen. */
  const syncView = (): void => { if (shouldRender()) view.update(controller.state) }
  /**
   * Runs a controller call and repaints however it settles. Every UI-driven controller call goes
   * through here so the `try { … } finally { view.update(controller.state) }` contract lives in
   * one place.
   */
  const ui = <A extends unknown[], R>(fn: (...args: A) => Promise<R>) =>
    async (...args: A): Promise<R> => {
      try { return await fn(...args) } finally { syncView() }
    }
  /** `ui`, but a no-op while Branch Review owns the screen: the repository view cannot act then. */
  const repositoryUi = <A extends unknown[]>(fn: (...args: A) => Promise<void>) =>
    async (...args: A): Promise<void> => {
      if (!shouldRender()) return
      await ui(fn)(...args)
    }
  const isBusy = (): boolean => {
    if (!shouldRender()) return false
    return refreshInFlight || view.isMutating
  }
```

`view.isMutating` is a public getter (`src/ui/root-view.ts:790`); the previous `as unknown as { isMutating?: boolean }` cast is dropped.

- [ ] **Step 2: Use `isBusy` and `syncView` in the RefsWatcher block**

Replace the `RefsWatcher` options (`:273-291`) with:

```ts
  refsWatcher = new RefsWatcher({
    snapshot: () => loadRefsSnapshot(options.runner),
    onExternalChange: async () => {
      if (!shouldRender()) {
        // Hidden repository refresh without repainting the review screen
        void controller.refresh().catch(() => undefined)
        await scheduleCoalescedReviewRefresh()
        return
      }
      await controller.refresh()
      syncView()
    },
    isBusy,
  })
```

- [ ] **Step 3: Replace the `new RootView(...)` call (`:292-480`)**

```ts
  view = new RootView(renderer, controller.state, {
    ports: {
      commands: {
        onStageFile: repositoryUi((path) => controller.stageFile(path)),
        onStageFiles: repositoryUi((paths, stage) => stage ? controller.stageFiles(paths) : controller.unstageFiles(paths)),
        onUnstageFile: repositoryUi((path) => controller.unstageFile(path)),
        onDiscardFile: repositoryUi((path, mode) => controller.discardFile(path, mode)),
        onDiscardFiles: repositoryUi((paths, mode) => controller.discardFiles(paths, mode)),
        onToggleAllFiles: repositoryUi(() => controller.toggleAllFiles()),
        onScopeChange: repositoryUi((scope) => controller.setWorkingTreeScope(scope)),
        onOpenBranchReview: async () => {
          if (!shouldRender()) return
          try { await screenController.openBranchReview() } catch (error) {
            syncView()
            throw error
          }
        },
        onApplySelection: repositoryUi((document, indexes, reverse) => controller.applySelection(document, indexes, { reverse, wholeFile: false })),
        onDiscardSelection: repositoryUi((document, indexes) => controller.discardSelection(document, indexes, { wholeFile: false })),
        onSelectFile: (path) => {
          if (!shouldRender()) return
          controller.selectFile(path)
          syncView()
        },
        onExpandCommits: async () => {
          const expanded = await controller.expandCommits()
          // Preserve an open filter/search prompt across the reload: the default
          // update clears in-progress filtering (root-view `update`), which would
          // drop the session the expansion was opened for.
          if (expanded && shouldRender()) view.update(controller.state, { preserveFilterInput: true })
          return expanded
        },
        onMarkFocusedFileReviewed: repositoryUi((path) => controller.markFocusedFileReviewed(path)),
        onCommitMessage: repositoryUi((message) => controller.commit(message)),
        onAmendMessage: repositoryUi((message) => controller.amend(message)),
        onCreateBranch: repositoryUi(async (startPoint, branchName, createOptions) => {
          if (branchName === undefined) return
          await controller.createBranch(branchName, startPoint, createOptions)
        }),
        onCreateBranchWithAutostash: repositoryUi(async (startPoint, branchName, createOptions) => {
          if (branchName === undefined) return
          await controller.createBranchWithAutostash(branchName, startPoint, createOptions)
        }),
        onRefresh: ui(() => controller.refresh()),
        onSwitchLocalBranch: repositoryUi((branch) => controller.switchLocalBranch(branch)),
        onDeleteBranch: repositoryUi(async (request) => {
          if (request.mode === "local") {
            await controller.deleteBranch(request.branch, { force: request.force, confirmed: request.force })
          } else if (request.mode === "remote") {
            if (request.remote === undefined || request.remoteBranch === undefined) throw new Error("remote branch deletion requires an upstream")
            await controller.deleteRemoteBranch(request.remote, request.remoteBranch)
          } else {
            if (request.remote === undefined || request.remoteBranch === undefined) throw new Error("local and remote deletion requires an upstream")
            await controller.deleteLocalAndRemoteBranch(request.branch, request.remote, request.remoteBranch, { force: request.force, confirmed: request.force })
          }
        }),
        onDeleteBranches: repositoryUi((requests) => controller.deleteBranches(requests)),
        onDeleteBranchFromWorktree: ui((path, action, request, forceWorktree) => controller.deleteBranchFromWorktree(path, action, request, forceWorktree)),
        onFetchRemote: ui((remote) => controller.fetchRemote(remote)),
        onRenameBranch: repositoryUi(async (branch, newName) => {
          if (newName === undefined) return
          await controller.renameBranch(branch, newName)
        }),
        onFetch: ui(() => controller.fetch()),
        onPull: ui(() => controller.pull()),
        onPush: ui(() => controller.push()),
        onChooseUpstream: ui((remote, branch) => controller.chooseUpstream(remote, branch)),
        onCancelUpstream: ui(() => controller.cancelUpstreamChoice()),
        onPopStash: ui((ref) => controller.popStash(ref)),
        onCreateStash: ui((message, includeUntracked) => controller.createStash(message, { includeUntracked })),
        onApplyStash: ui((ref) => controller.applyStash(ref)),
        onDropStash: ui((ref) => controller.dropStash(ref, { confirmed: true })),
        onDropStashes: ui((refs) => controller.dropStashes(refs, { confirmed: true })),
        onInspectStash: ui((ref) => controller.inspectStash(ref)),
        onBrowseRemote: ui((remote) => controller.browseRemote(remote)),
        onInspectBranch: ui((branchRef) => controller.inspectBranch(branchRef)),
        onCheckoutRemoteTracking: async (selection, confirmedMismatch) => {
          if (!shouldRender()) return undefined
          try {
            const result = await controller.checkoutRemoteTracking(selection, confirmedMismatch === true ? { confirmedMismatch: true } : undefined)
            if (shouldRender()) view.update(controller.state, { preserveRemoteCheckout: result?.kind === "mismatch" })
            return result
          } catch (error) {
            syncView()
            throw error
          }
        },
        onEditFile: async (path, line) => {
          // `LogAction(Tr.Actions.OpenFile)` (pkg/gui/controllers/helpers/files_helper.go:78). Logged
          // at the wiring, not inside the default `editFile` above, so it fires whether the default or
          // an injected `options.onEditFile` runs.
          options.runner.log.logAction(LOG_ACTIONS.openFile)
          await editFile(path, line)
        },
      },
      queries: {
        loadCommitInspection: (oid) => controller.loadCommitInspection(oid),
        loadBranchCommits: options.loadBranchCommits ?? ((branch) => controller.loadBranchCommits(branch)),
        loadCommitFileInspection: (oid, path) => controller.loadCommitFileInspection(oid, path),
        loadTagInspection: (tag) => controller.loadTagInspection(tag),
        loadRefLogInspection: (target) => controller.loadRefLogInspection(target),
        onCurrentCommitMessage: ui(() => controller.currentCommitMessage()),
        onCheckBranchMerged: options.onCheckBranchMerged ?? ((branch, upstream) => controller.branchIsMerged(branch, upstream)),
      },
      host: {
        onQuit: () => options.onQuit?.(),
        onGeometryChange: (state) => {
          latestGeometry = state
          options.onGeometryChange?.(state)
        },
        // Whatever githunk just did to the repository is now the baseline for ref polling. Index events
        // remain queued because the watcher cannot attribute a concurrent index write safely.
        onMutationSettled: () => { void refsWatcher.resync() },
        onPreviewError: (error) => controller.recordInspectionError(error),
        isBranchReviewActive: () => screenController?.active.kind === "branch-review",
      },
    },
  })
```

Behavioural notes to preserve exactly: which handlers used the leading `if (!(shouldRenderRepository)) return` guard (they use `repositoryUi`) and which did not (they use `ui`). The table above mirrors the original file line by line; do not "upgrade" a `ui` handler to `repositoryUi`. `onCreateBranch`'s original checked `branchName === undefined` *before* the screen guard; since both are early returns with no side effects, the order does not matter.

- [ ] **Step 4: Replace the BackgroundRefresher `isBusy` and repaint calls (`:499-532`)**

```ts
        fetch: async () => {
          // lazygit's background fetch is DontLog() while its foreground one is not
          // (pkg/commands/git_commands/sync.go:65-84).
          await controller.fetch(undefined, { background: true })
          syncView()
          await refsWatcher.resync()
        },
        refresh: async () => {
          await controller.refreshFiles()
          syncView()
        },
```

and replace the inline `isBusy: () => { … }` object with `isBusy,` (keeping the two explanatory comments above it).

Also replace the other repaint sites in the file with `syncView()`: `:189` (index watcher `onExternalChange`), `:236` (`editFile`), `:283`, and the `refresh()` method of the returned `App` (`:549`). Leave `renderPullRequests` (`:490-493`) as is; it takes a `state` argument.

- [ ] **Step 5: Typecheck, run the wiring suites**

Run: `bun run typecheck`
Expected: exit 0.

Run: `bun test tests/ui/dispatch.integration.test.ts tests/app/create-app.test.ts tests/app/create-app.integration.test.ts tests/ui/branch-actions.integration.test.ts tests/ui/filter-search.integration.test.ts`
Expected: all pass.

- [ ] **Step 6: Full gate and commit**

Run: `bun run check`
Expected: typecheck exit 0, all tests pass.

```bash
git add src/ui/root-view-ports.ts src/ui/root-view.ts src/app/create-app.ts
git commit -m "refactor: route root view callbacks through required ports

RootView is built only by create-app, which supplied every one of the 47
optional callbacks, so the optionality was fiction. The callbacks now live
in three required interfaces in src/ui/root-view-ports.ts (commands,
queries, host); RootView holds one ports field instead of 47 and the
branches that existed only for an absent callback are gone. create-app
wraps controller calls with ui()/repositoryUi() so the repaint-on-settle
contract is written once instead of 35 times. onFilterBranches was never
invoked and is removed.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Scope 2 — AppController helpers and loader options

### Task 4: `describeGitError`

**Files:**
- Create: `src/git/error-message.ts`
- Create: `tests/git/error-message.test.ts`
- Modify: `src/app/controller.ts` (18 sites; find with `grep -n 'error instanceof GitCommandError' src/app/controller.ts`)

**Interfaces:**
- Produces: `describeGitError(error: unknown): string` (used by Task 6).

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, test } from "bun:test"
import { describeGitError } from "../../src/git/error-message"
import { GitCommandError } from "../../src/git/runner"
import type { CommandRecord } from "../../src/domain/command"

function record(overrides: Partial<CommandRecord>): CommandRecord {
  return { id: 1, cwd: "/tmp/repo", args: ["fetch"], startedAt: "2026-09-06T00:00:00.000Z", durationMs: 1, exitCode: 1, stdout: "", stderr: "", ...overrides }
}

describe("describeGitError", () => {
  test("prefers stderr of a failed git command", () => {
    const error = new GitCommandError(record({ exitCode: 128, stderr: "fatal: could not read from remote" }))
    expect(describeGitError(error)).toBe("fatal: could not read from remote")
  })

  test("falls back to the command error message when stderr is empty", () => {
    const error = new GitCommandError(record({ exitCode: 1, stderr: "" }))
    expect(describeGitError(error)).toBe("git fetch failed with exit code 1")
  })

  test("uses the message of a plain Error", () => {
    expect(describeGitError(new Error("boom"))).toBe("boom")
  })

  test("stringifies anything else", () => {
    expect(describeGitError(42)).toBe("42")
  })
})
```

`CommandRecord` (`src/domain/command.ts:1-10`) has exactly the fields `record()` fills in.

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test tests/git/error-message.test.ts`
Expected: FAIL, cannot resolve `../../src/git/error-message`.

- [ ] **Step 3: Write the module**

```ts
import { GitCommandError } from "./runner"

/**
 * The one-line banner text for a failed operation: git's own stderr when a command failed, the
 * error message otherwise. Every controller banner is built from this so the wording cannot
 * drift between call sites.
 */
export function describeGitError(error: unknown): string {
  if (error instanceof GitCommandError) return error.record.stderr || error.message
  if (error instanceof Error) return error.message
  return String(error)
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test tests/git/error-message.test.ts`
Expected: 4 pass.

- [ ] **Step 5: Replace the 18 controller sites**

Add `import { describeGitError } from "../git/error-message"` to `src/app/controller.ts`. Replace every expression of the form

```ts
error instanceof GitCommandError ? error.record.stderr || error.message : error instanceof Error ? error.message : String(error)
```

and its parenthesised variant

```ts
error instanceof GitCommandError
  ? (error.record.stderr || error.message)
  : error instanceof Error ? error.message : String(error)
```

with `describeGitError(error)`. The variable is always named `error` at these sites except `refresh()`, where it is `branchesResult.reason` etc. assigned to `const error` first; those lines are rewritten wholesale in Task 6, so replace only their ternary now. After the edit, `grep -c 'instanceof GitCommandError' src/app/controller.ts` must be 0; if so, drop `GitCommandError` from the `../git/runner` import on line 1.

- [ ] **Step 6: Typecheck and run the controller suites**

Run: `bun run typecheck && bun test tests/app/controller.test.ts tests/app/log-actions.test.ts tests/app/log-actions.integration.test.ts`
Expected: exit 0, all pass (the banner-text assertions in `log-actions` pin the wording).

### Task 5: `AppController.setState`

**Files:**
- Modify: `src/app/controller.ts` (`commandLogSnapshot` at `:252`, every `this.currentState = ` site)

**Interfaces:**
- Produces: `private setState(patch: Partial<AppModel>, omit?: readonly (keyof AppModel)[]): void` (used by Task 6).

- [ ] **Step 1: Add the helper directly below `commandLogSnapshot()`** (`:256`)

```ts
  /**
   * The one way the model changes after construction: the current state, minus `omit`, plus
   * `patch`, always carrying a fresh command-log snapshot. `omit` exists because
   * `exactOptionalPropertyTypes` forbids clearing an optional key by assigning `undefined`.
   */
  private setState(patch: Partial<AppModel>, omit: readonly (keyof AppModel)[] = []): void {
    const base: Record<string, unknown> = { ...this.currentState }
    for (const key of omit) delete base[key]
    this.currentState = { ...(base as AppModel), ...patch, ...this.commandLogSnapshot() }
  }
```

- [ ] **Step 2: Convert every `this.currentState = { ...this.currentState, … }` site**

Rules:

1. `this.currentState = { ...this.currentState, a, b, ...this.commandLogSnapshot() }` → `this.setState({ a, b })`.
2. `this.currentState = { ...this.currentState, a }` (no snapshot today) → `this.setState({ a })`. These sites are: `rebuildPullRequests` (`:268`), the three stash-target resets (`:560`, `:571`, `:596`), `selectFile` (`:972`, `:979`), `markFocusedFileReviewed` (`:994`), `markFileReviewed` (`:1021`), `ensureWorkingTreeMutation` (`:1141`), `ensureStashOperation` (`:1146`). None of them runs git between the previous snapshot and this write, so the snapshot they now carry equals the one already in the state; the change is not observable.
3. `this.currentState = { ...this.currentState, ...this.commandLogSnapshot() }` (`refreshPullRequests` catch, `:290`) → `this.setState({})`.
4. `publishIfCurrent` (`:1405-1407`) → `if (generation === this.generation) this.setState(update)`.
5. Key removals:
   - `inspectBranch` (`:842-848`): replace the destructuring and assignment with
     ```ts
     this.setState({ commits: history.commits, ...(history.warning === undefined ? {} : { banner: history.warning }) }, ["banner"])
     ```
   - `cancelUpstreamChoice` (`:904-905`) → `this.setState({}, ["upstreamChoice"])`.
   - `refreshStashTarget` (`:1383-1397`): replace the destructuring and assignment with
     ```ts
     this.setState({
       reviewTarget: target,
       files,
       patches: [patch],
       rawPatchSections: [patch],
       reviewStatuses,
       reviewSummary,
       loading: false,
       title: titleFor(target, this.currentState.branch),
       ...(review.warning === undefined ? {} : { banner: review.warning }),
     }, ["banner"])
     ```
6. Sites that stay as direct assignments, each with a one-line comment `// Not setState: …`:
   - The constructor's initial state (`:228`): there is no prior state.
   - `refreshTarget` (`:1331-1348`): it removes five keys and rebuilds from `nextState`; convert it too if the rewrite is mechanical — `this.setState({ …patch fields… }, ["upstream", "upstreamChoice", "banner", "selectionId", "focusId"])` — otherwise leave it and say why in the comment. The patch fields are those listed after `...nextState`; keep `...this.commandLogSnapshot()` out of the patch because `setState` adds it.

After the step, `grep -c 'this.currentState = ' src/app/controller.ts` must be at most 2 (constructor, and `refreshTarget` if left).

- [ ] **Step 3: Typecheck and run the app suites**

Run: `bun run typecheck && bun test tests/app`
Expected: exit 0, all pass.

### Task 6: Table-driven `refresh()`

**Files:**
- Modify: `src/app/controller.ts:306-471` (`refresh()`)
- Test: `tests/app/controller.test.ts` (add one test after `"a failing worktree or submodule listing only raises a banner"`, `:285-303`)

**Interfaces:**
- Consumes: `describeGitError` (Task 4), `setState` (Task 5).
- Produces: `private async loadAuxiliary<T>(load, apply)`; internal only.

- [ ] **Step 1: Write the failing precedence test**

Add to `tests/app/controller.test.ts` inside the `describe("AppController")` block:

```ts
  test("when several auxiliary listings fail the last one in load order sets the banner", async () => {
    const controller = new AppController({
      load: async (target) => snapshot(target.scope, ""),
      loadBranches: async () => { throw new Error("branches failed") },
      loadStashes: async () => [],
      loadTags: async () => [],
      loadReflog: async () => [],
      loadWorktrees: async () => [],
      loadSubmodules: async () => { throw new Error("submodules failed") },
    })
    await controller.refresh()
    expect(controller.state.banner).toBe("submodules failed")
    expect(controller.state.branches).toBeUndefined()
    expect(controller.state.submodules).toBeUndefined()
  })
```

- [ ] **Step 2: Run it against the current code to confirm it already passes**

Run: `bun test tests/app/controller.test.ts -t "last one in load order"`
Expected: PASS. This test pins today's "last write wins" behaviour so the rewrite cannot change it. (It is a characterisation test, so it passes before the refactor by design.)

- [ ] **Step 3: Add `loadAuxiliary` below `setState`**

```ts
  /**
   * One auxiliary listing of a full refresh. Auxiliary data (branches, stashes, tags, the
   * reflog, worktrees, submodules) is optional: a fresh repo, `core.logAllRefUpdates=false`, an
   * expired reflog, a bare or partially initialised worktree list all legitimately produce nothing,
   * so a failure only raises a banner and never aborts the refresh.
   */
  private async loadAuxiliary<T>(
    load: () => Promise<T>,
    apply: (value: T) => Partial<AppModel>,
  ): Promise<{ readonly patch: Partial<AppModel> } | { readonly warning: string }> {
    try {
      return { patch: apply(await load()) }
    } catch (error) {
      return { warning: describeGitError(error) }
    }
  }
```

- [ ] **Step 4: Rewrite `refresh()`**

Replace the body from `const generation = ++this.generation` through the last warning re-application (`:311-468`) with:

```ts
    const generation = ++this.generation
    // Load order is also banner order: when more than one listing fails, the later one's message
    // is what the user sees (the test "last one in load order sets the banner" pins this).
    const outcomes = await Promise.all([
      this.loadAuxiliary(this.loadBranchesListing, (branches) => ({ branches })),
      this.loadAuxiliary(this.loadStashesListing, (stashes) => ({ stashes })),
      this.loadAuxiliary(this.loadTagsListing, (tags) => ({ tags })),
      this.loadAuxiliary(this.loadReflogListing, (reflog) => ({ reflog })),
      this.loadAuxiliary(this.loadWorktreesListing, (worktrees) => ({ worktrees })),
      this.loadAuxiliary(this.loadSubmodulesListing, (submodules) => ({ submodules })),
    ])
    if (generation !== this.generation) return
    let lastWarning: string | undefined
    for (const outcome of outcomes) {
      if ("patch" in outcome) {
        this.setState(outcome.patch)
      } else {
        lastWarning = outcome.warning
        this.setState({ banner: outcome.warning })
      }
    }
    const target = this.currentState.reviewTarget
    if (target.kind === "working-tree") {
      await this.refreshTarget(target)
    } else if (target.kind === "stash") {
      await this.refreshStashTarget(target.ref)
    }
    // The target refresh may have replaced the banner; an auxiliary failure still wins.
    if (lastWarning !== undefined) this.setState({ banner: lastWarning })
```

Keep the leading comment and `void this.refreshPullRequests()` above, and `this.rebuildPullRequests()` with its comment below, unchanged. The six `let xWarning` declarations are gone.

- [ ] **Step 5: Typecheck and run the controller suites**

Run: `bun run typecheck && bun test tests/app/controller.test.ts tests/app/log-actions.test.ts tests/app/filter.test.ts tests/app/commit-drilldown.test.ts`
Expected: exit 0, all pass, including the new precedence test and `"a failing worktree or submodule listing only raises a banner"`.

### Task 7: Loader options and `defaultLoaders`

**Files:**
- Modify: `src/app/controller.ts:51-86` (`AppControllerOptions`), `:167-227` (constructor)
- Test: `tests/app/controller.test.ts`, `tests/app/remote-checkout.test.ts`, `tests/acceptance/review-workflow.integration.test.ts` (existing; they exercise both constructor shapes)

**Interfaces:**
- Produces: `type AppLoaders`, `function defaultLoaders(runner: GitRunner | undefined): AppLoaders`; internal to the module.

- [ ] **Step 1: Replace the loader keys in `AppControllerOptions`**

Delete these keys and their comments: `loader`, `commitsLoader`, `commitLoader`, `branchesLoader`, `commitFilePatchLoader`, `tagsLoader`, `reflogLoader`, `worktreesLoader`, `submodulesLoader`. The type becomes:

```ts
export type AppControllerOptions = Partial<AppLoaders> & {
  readonly repositoryRoot?: string
  readonly runner?: GitRunner
  /**
   * Repaints the branches panel after an asynchronous pull-request result arrives. If the query
   * fails, the last successful result remains visible rather than disappearing transiently.
   */
  readonly onPullRequestsChanged?: (state: AppModel) => void
  readonly loadPullRequests?: PullRequestListLoader
  readonly mutations?: GitMutations
  readonly commitMutations?: CommitMutations
  readonly reviewStore?: WorkingTreeReviewStore
}
```

Add above it:

```ts
/** The Git-backed reads a controller performs; tests replace any subset. */
export type AppLoaders = {
  readonly load: WorkingTreeLoader
  readonly loadBranches: BranchListingLoader
  readonly loadCommits: CommitListLoader
  readonly loadCommit: CommitLoader
  readonly loadCommitFilePatch: CommitFilePatchLoader
  readonly loadStashes: () => Promise<readonly StashEntry[]>
  readonly loadTags: TagListLoader
  readonly loadReflog: ReflogListLoader
  readonly loadWorktrees: WorktreeListLoader
  readonly loadSubmodules: SubmoduleListLoader
}

const LOADER_KEYS = ["load", "loadBranches", "loadCommits", "loadCommit", "loadCommitFilePatch", "loadStashes", "loadTags", "loadReflog", "loadWorktrees", "loadSubmodules"] as const satisfies readonly (keyof AppLoaders)[]

/**
 * Every loader reads through `runner`. Without one (headless unit tests) the listings are empty
 * and the reads that cannot be faked throw, exactly as before.
 */
function defaultLoaders(runner: GitRunner | undefined): AppLoaders {
  if (runner === undefined) {
    return {
      load: async () => { throw new Error("AppController requires a GitRunner or loader") },
      loadBranches: async () => ({ detached: true, localBranches: [], remotes: [] }),
      loadCommits: async () => [],
      loadCommit: async () => { throw new Error("Commit details require a GitRunner") },
      loadCommitFilePatch: async () => { throw new Error("Commit file patches require a GitRunner") },
      loadStashes: async () => [],
      loadTags: async () => [],
      loadReflog: async () => [],
      loadWorktrees: async () => [],
      loadSubmodules: async () => [],
    }
  }
  return {
    load: (target, snapshotOptions) => loadWorkingTree(runner, target.scope, snapshotOptions ?? {}),
    loadBranches: () => listBranches(runner),
    loadCommits: (range, filter, listOptions) => listCommits(runner, range, filter, listOptions),
    loadCommit: (oid) => loadCommit(runner, oid),
    loadCommitFilePatch: (oid, path) => loadCommitFilePatch(runner, oid, path),
    loadStashes: () => listStashes(runner),
    loadTags: () => listTags(runner),
    loadReflog: () => listReflog(runner),
    loadWorktrees: () => listWorktrees(runner),
    loadSubmodules: () => listSubmodules(runner),
  }
}

/** The loaders an options bag actually sets, without `undefined` entries (`exactOptionalPropertyTypes`). */
function providedLoaders(options: AppControllerOptions): Partial<AppLoaders> {
  const provided: Record<string, unknown> = {}
  for (const key of LOADER_KEYS) {
    if (options[key] !== undefined) provided[key] = options[key]
  }
  return provided as Partial<AppLoaders>
}
```

- [ ] **Step 2: Rewrite the constructor's loader resolution (`:167-227`)**

```ts
  constructor(options: AppControllerOptions | GitRunner, loader?: WorkingTreeLoader) {
    const runner = options instanceof GitRunner ? options : options.runner
    const provided: Partial<AppLoaders> = options instanceof GitRunner
      ? (loader === undefined ? {} : { load: loader })
      : providedLoaders(options)
    const loaders: AppLoaders = { ...defaultLoaders(runner), ...provided }
    const repositoryRoot = options instanceof GitRunner ? options.cwd : options.repositoryRoot ?? runner?.cwd
    const shouldUseDefaultReviewStore = provided.load === undefined
    this.reviewStore = options instanceof GitRunner
      ? shouldUseDefaultReviewStore ? new WorkingTreeReviewStore({ repositoryRoot, runner }) : undefined
      : options.reviewStore ?? (!shouldUseDefaultReviewStore || runner === undefined || repositoryRoot === undefined ? undefined : new WorkingTreeReviewStore({ repositoryRoot, runner }))
    this.runner = runner
    this.mutations = runner === undefined
      ? undefined
      : options instanceof GitRunner
        ? new GitMutations(runner)
        : options.mutations ?? new GitMutations(runner)
    this.commitMutations = runner === undefined
      ? undefined
      : options instanceof GitRunner
        ? new CommitMutations(runner)
        : options.commitMutations ?? new CommitMutations(runner)
    this.loadSnapshot = loaders.load
    this.loadBranchesListing = loaders.loadBranches
    this.loadCommitList = loaders.loadCommits
    this.loadCommitDetails = loaders.loadCommit
    this.loadCommitFile = loaders.loadCommitFilePatch
    this.loadStashesListing = loaders.loadStashes
    this.loadTagsListing = loaders.loadTags
    this.loadReflogListing = loaders.loadReflog
    this.loadWorktreesListing = loaders.loadWorktrees
    this.loadSubmodulesListing = loaders.loadSubmodules
    this.loadPullRequestList = options instanceof GitRunner ? undefined : options.loadPullRequests
    this.onPullRequestsChanged = options instanceof GitRunner ? undefined : options.onPullRequestsChanged
```

The initial `this.currentState = { … }` block that follows is unchanged. Remove the now-unused `TagSummary`/`ReflogEntry`/`Worktree`/`SubmoduleConfig` casts (`as readonly TagSummary[]` etc.) — the type imports themselves stay because the loader types reference them.

- [ ] **Step 3: Confirm no alias key is referenced anywhere**

Run: `grep -rnE '\b(loader|commitsLoader|commitLoader|branchesLoader|commitFilePatchLoader|tagsLoader|reflogLoader|worktreesLoader|submodulesLoader)\s*:' src tests | grep -v useReviewHighlights`
Expected: no output. (`useReviewHighlights.ts:59` has an unrelated `loader` parameter.)

- [ ] **Step 4: Full gate and commit**

Run: `bun run check`
Expected: typecheck exit 0, all tests pass.

```bash
git add src/git/error-message.ts tests/git/error-message.test.ts src/app/controller.ts tests/app/controller.test.ts
git commit -m "refactor: table-drive controller refresh and centralize state writes

describeGitError replaces eighteen copies of the GitCommandError banner
ternary. AppController.setState is now the only way the model changes
after construction, so every write carries the command-log snapshot
instead of forty-one of fifty-two. refresh() loads its six auxiliary
listings through one loadAuxiliary helper in a fixed order; the banner
still shows the last failed listing, now pinned by a test. The eight
unused *Loader alias options are gone; defaultLoaders(runner) supplies
the Git-backed set and options overlay it.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Scope 3 — Branch Review dispatch through `dispatchIntent`

### Task 8: `dispatchIntent` unit test

**Files:**
- Create: `tests/ui/review-workspace/dispatch-intent.test.ts`

**Interfaces:**
- Consumes: `ReviewWorkspaceController.dispatchIntent(intent: ReviewIntent): boolean` (`src/ui/review-workspace/controller.ts:451-461`, unchanged).

- [ ] **Step 1: Write the test**

The helpers are the same shapes `tests/ui/review-workspace/refresh.integration.test.ts:16-56` uses; they are repeated here so this file stands alone.

```ts
import { describe, expect, test } from "bun:test"
import { ReviewWorkspaceController } from "../../../src/ui/review-workspace/controller"
import { createReviewDocument, createReviewHunk } from "../../../src/review/core/document"
import { createReviewIdentity, createReviewGeneration } from "../../../src/review/core/identity"
import type { ReviewFile } from "../../../src/review/core/types"
import type { GitRunner } from "../../../src/git/runner"

function fakeRunner(): GitRunner {
  const log = {
    logIntro: () => {},
    logAction: () => {},
    logCommand: () => {},
    logTip: () => {},
    lines: () => [] as unknown[],
    autoscrollArms: () => false,
    commandLogSnapshot: () => ({ entries: [] }),
  } as unknown as GitRunner["log"]
  return { run: async () => ({ stdout: "", stderr: "", exitCode: 0 }), log, cwd: "/tmp/fake" } as unknown as GitRunner
}

function makeHunk(index: number, lines: string[]) {
  return createReviewHunk({ index, oldStart: 1, oldCount: lines.filter((l) => l[0] !== "+").length, newStart: 1, newCount: lines.filter((l) => l[0] !== "-").length, lines })
}

function makeFile(key: string, path: string): ReviewFile {
  return {
    kind: "modified",
    key,
    path,
    oldBlobOid: "o1",
    newBlobOid: "n1",
    oldMode: "100644",
    newMode: "100644",
    contentId: `content-${key}`,
    patchDigest: `patch-${key}`,
    stats: { additions: 1, deletions: 1 },
    hunks: [makeHunk(0, [" a", "+b"])],
    source: "available",
  } as unknown as ReviewFile
}

function makeDoc(files: ReviewFile[]) {
  const headOid = "a".repeat(40)
  const identity = createReviewIdentity({ headRef: "refs/heads/feature", headOid, baseRef: "refs/heads/main" })
  const generation = createReviewGeneration({ baseOid: "b".repeat(40), mergeBaseOid: "c".repeat(40), headOid })
  return createReviewDocument({ identity, generation, commits: [{ oid: headOid, parents: [], author: "A", timestamp: 0, subject: "s", body: "" }], files })
}

describe("ReviewWorkspaceController.dispatchIntent", () => {
  test("returns false and leaves state untouched for an intent that fails validation", async () => {
    const doc = makeDoc([makeFile("a", "src/a.ts"), makeFile("b", "src/b.ts")])
    const controller = new ReviewWorkspaceController({ runner: fakeRunner(), loadDocument: async () => doc })
    await controller.open("refs/heads/main")
    const before = controller.state

    expect(controller.dispatchIntent({ type: "selection/select-file", fileKey: "missing" })).toBe(false)
    expect(controller.state).toBe(before)
    await controller.destroy()
  })

  test("returns true and advances state for a valid intent", async () => {
    const doc = makeDoc([makeFile("a", "src/a.ts"), makeFile("b", "src/b.ts")])
    const controller = new ReviewWorkspaceController({ runner: fakeRunner(), loadDocument: async () => doc })
    await controller.open("refs/heads/main")

    expect(controller.dispatchIntent({ type: "selection/select-file", fileKey: "b" })).toBe(true)
    expect(controller.state?.selection.fileKey).toBe("b")
    await controller.destroy()
  })

  test("returns false before a review is open", () => {
    const controller = new ReviewWorkspaceController({ runner: fakeRunner(), loadDocument: async () => makeDoc([makeFile("a", "src/a.ts")]) })
    expect(controller.dispatchIntent({ type: "feedback/cancel-draft" })).toBe(false)
    await controller.destroy()
  })
})
```

- [ ] **Step 2: Run it**

Run: `bun test tests/ui/review-workspace/dispatch-intent.test.ts`
Expected: 3 pass. This characterises existing behaviour, so it passes before the component changes. `destroy()` is async (`src/ui/review-workspace/controller.ts:749`), hence the `await`.

### Task 9: Component dispatch sites

**Files:**
- Modify: `src/ui/review-workspace/ReviewWorkspaceApp.tsx` (import `:13`; `fallbackSelectionIntent` return type `:214`; 35 dispatch sites)
- Test: `tests/ui/review-workspace/*`, `tests/acceptance/branch-review-*.integration.test.ts` (existing)

**Interfaces:**
- Consumes: `controller.dispatchIntent(intent): boolean`; `ReviewIntent` from `src/review/core/intents.ts`.

- [ ] **Step 1: Swap the import**

Line 13: replace `import { planReviewIntent } from "../../review/core/intents"` with `import type { ReviewIntent } from "../../review/core/intents"`.

Line 214: `): Parameters<typeof planReviewIntent>[1] | undefined {` → `): ReviewIntent | undefined {`.

- [ ] **Step 2: Rewrite each dispatch site**

General rule: `controller.dispatch(planReviewIntent(X, INTENT))` → `controller.dispatchIntent(INTENT)` where `X` is `current`, `latest`, `state` or `controller.state`. Remove the `try { … } catch {}` that wrapped only dispatch calls plus state setters. Where the `catch` did work, use the boolean. Site by site (line numbers are pre-edit):

1. `saveDraft` (`:501-527`): the outer `try { … } catch {}` goes. Body becomes
   ```ts
    if (editingFeedbackId) {
      const existing = current.feedback.find((feedback) => feedback.id === editingFeedbackId)
      if (!existing) {
        setEditingFeedbackId(null)
        return
      }
      const patch: { body?: string; severity?: "comment" | "blocking"; replacement?: string } = {}
      if (draft.body !== existing.body) patch.body = draft.body
      if (draft.severity !== existing.severity) patch.severity = draft.severity
      if (draft.replacement !== undefined && draft.replacement !== existing.replacement) patch.replacement = draft.replacement
      if (Object.keys(patch).length > 0) {
        controller.dispatchIntent({ type: "feedback/edit", id: existing.id, ...patch, updatedAt: new Date().toISOString() })
      }
      if (controller.state?.draft) controller.dispatchIntent({ type: "feedback/cancel-draft" })
      setEditingFeedbackId(null)
    } else {
      controller.dispatchIntent({ type: "feedback/create", id: draftId(), createdAt: new Date().toISOString() })
    }
    pendingDeleteFeedbackRef.current = null
    setPendingDeleteFeedbackId(null)
    setComposerFocus("body")
    setFeedbackMessage(null)
    session.invalidate()
   ```
   Note: previously a validation error in `feedback/edit` aborted the whole block (the setters after it did not run). With `dispatchIntent` the setters run regardless. `feedback/edit` can only fail if the feedback id is unknown, which the `existing` lookup above rules out, so the observable behaviour is the same.
2. `deleteFeedback` (`:540-546`): drop `try`/`catch`; `controller.dispatchIntent({ type: "feedback/delete", id: feedbackId })` then the three lines after it.
3. `reanchorFeedback` (`:603-615`): keep the recovery.
   ```ts
    if (controller.dispatchIntent({ type: "feedback/reanchor", id: feedbackId, anchor, updatedAt: new Date().toISOString() })) {
      setReanchorFeedbackId(null)
      setFeedbackMessage(null)
      setPendingRangeAnchor(null)
      pendingDeleteFeedbackRef.current = null
      setPendingDeleteFeedbackId(null)
    } else {
      setReanchorFeedbackId(feedbackId)
      setFeedbackMessage("The selected source is not a valid anchor for this feedback.")
    }
    session.invalidate()
   ```
   The `try { anchor = createRangeAnchor(…) } catch {}` blocks earlier in the function are *not* dispatch sites; leave them.
4. `editFeedback` (`:622-637`): drop `try`/`catch`; `controller.dispatchIntent({ type: "feedback/start-draft", … })` then the setters.
5. `selectFeedback` (`:651-659`):
   ```ts
    controller.dispatchIntent({ type: "selection/select-file", fileKey: file.key })
    if (feedback.anchor.kind === "range") {
      controller.dispatchIntent({ type: "selection/viewport-anchor", fileKey: file.key, hunkIndex: feedback.anchor.ownerHunkIndex, reveal: "hunk" })
    }
    setFocus("stream")
    session.invalidate()
   ```
6. `selectDiffAddress` (`:667-697`): the outer `try` also guarded `createLineSelection`, which throws for a bad address. Keep a `try` around only that call:
   ```ts
    let selection: ReviewLineSelection
    try {
      selection = createLineSelection(file, { hunkIndex: address.hunkIndex, side: address.side, line: address.line })
    } catch {
      return
    }
    controller.dispatchIntent({ type: "selection/set-line", selection })
    setFocus("stream")
    … (rest unchanged, including the inner try/catch around createRangeAnchor)
   ```
   Import `ReviewLineSelection` with `import type { ReviewLineSelection } from "../../review/core/state"` if it is not already imported.
7. `executeCommand`, `review.moveDown`/`moveUp` (`:778`, `:792-794`, `:798-800`): drop each `try { controller.dispatch(...) } catch {}` for a bare `controller.dispatchIntent(...)`. The `createLineSelection` call at `:791` can throw; keep `try { const lineSelection = createLineSelection(file, address); controller.dispatchIntent({ type: "selection/set-line", selection: lineSelection }); setRangeStart(null); setPendingRangeAnchor(null) } catch {}` as is except for the dispatch line.
8. `movement` block (`:815-825`):
   ```ts
    if (movement) {
      const before = current.selection
      controller.dispatchIntent({ type: "selection/move", unit: movement.unit, direction: movement.direction })
      const after = controller.state
      if (after?.selection.fileKey === before.fileKey && after.selection.hunkIndex === before.hunkIndex) {
        const fallback = fallbackSelectionIntent(current, movement.unit, movement.direction)
        if (fallback) controller.dispatchIntent(fallback)
      }
      setRangeStart(null)
      setPendingRangeAnchor(null)
      return true
    }
   ```
9. `review.nextUnreviewed`/`prevUnreviewed` (`:832`), `nextFeedback`/`prevFeedback` (`:842`), `markViewed` (`:851`), `cycleFilterScope` (`:947`): bare `controller.dispatchIntent(...)`.
10. `review.createFeedback` (`:902-920`): drop the outer `try`/`catch` around the `feedback/start-draft` dispatch and setters; the inner `try { anchor = createRangeAnchor(…) } catch {}` stays.
11. `handleKey` escape (`:987`) and filter clear (`:1015`): bare `controller.dispatchIntent(...)`.
12. Sidebar filter input (`:1193`, `:1202`): bare `controller.dispatchIntent({ type: "filter/set-query", query })` and `… query: "" })`.
13. Composer toggles and textareas (nine sites between `:1400` and `:1535`, each reading `const latest = controller.state` first): `controller.dispatchIntent({ type: "feedback/update-draft", kind: "note" })` etc. Where the original had no `try`, a thrown validation error used to escape into the OpenTUI mouse handler; now it is swallowed by `dispatchIntent`. This is the one intentional difference in this scope: an interaction on a toggle with no draft open becomes a no-op instead of an uncaught exception. Keep the `if (!latest?.draft) return` style guards that precede these calls where present; they still short-circuit the common case.

After the edits: `grep -c 'planReviewIntent' src/ui/review-workspace/ReviewWorkspaceApp.tsx` must be 0 and `grep -c 'controller.dispatch(' src/ui/review-workspace/ReviewWorkspaceApp.tsx` must be 0.

- [ ] **Step 3: Typecheck and run the Branch Review suites**

Run: `bun run typecheck && bun test tests/ui/review-workspace tests/acceptance/branch-review-workspace.integration.test.ts tests/acceptance/branch-review-artifact.integration.test.ts tests/acceptance/review-workflow.integration.test.ts`
Expected: exit 0, all pass. If a test fails on a `feedbackMessage` string, compare the failing site with the list above; the recovery branches in items 3 and 6 are the only places that set messages.

- [ ] **Step 4: Full gate and commit**

Run: `bun run check`
Expected: typecheck exit 0, all tests pass.

```bash
git add src/ui/review-workspace/ReviewWorkspaceApp.tsx tests/ui/review-workspace/dispatch-intent.test.ts
git commit -m "refactor: dispatch branch review intents through the controller

ReviewWorkspaceController.dispatchIntent already plans an intent against
the controller's live state and reports failure as false; the component
never used it and instead planned against a snapshot it had read earlier,
inside thirty-five try/catch blocks. Every dispatch now goes through
dispatchIntent, the empty catches are gone, and the three sites that
recovered from a failure branch on the boolean. dispatchIntent gains a
unit test for the true/false contract.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Self-review notes

- Spec coverage: Scope 1 → Tasks 1-3 (ports, RootView, wrapper, `isBusy` dedupe, `noopPorts` not created because no test constructs `RootView`; spec allows this). Scope 2 → Task 4 (`describeGitError` + test), Task 5 (`setState`, 11 no-snapshot sites reviewed in Step 2), Task 6 (table + precedence test), Task 7 (alias removal, `defaultLoaders`, positional overload kept). Scope 3 → Task 8 (unit test), Task 9 (35 sites, recovery branches, `ReviewIntent` type, `dispatch` stays public).
- Names used across tasks: `RootViewPorts`, `RepositoryCommands`, `RepositoryQueries`, `ViewHost` (Task 1 → 2, 3); `shouldRender`, `syncView`, `ui`, `repositoryUi`, `isBusy` (Task 3 only); `describeGitError` (Task 4 → 6); `setState` (Task 5 → 6); `loadAuxiliary` (Task 6); `AppLoaders`, `LOADER_KEYS`, `defaultLoaders`, `providedLoaders` (Task 7).
