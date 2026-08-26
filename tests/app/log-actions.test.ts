import { describe, expect, test } from "bun:test"
import { AppController } from "../../src/app/controller"
import { CommandLog } from "../../src/app/command-log"
import { LOG_ACTIONS } from "../../src/app/log-actions"
import { GitRunner } from "../../src/git/runner"
import type { GitMutations } from "../../src/git/mutations"
import type { WorkingTreeSnapshot } from "../../src/domain/repository"
import type { ChangedFile } from "../../src/domain/review-target"
import type { DiffDocument } from "../../src/domain/diff/document"
import type { BranchReviewSnapshot } from "../../src/git/branch-review"
import type { StashCreateOptions } from "../../src/domain/stash"

function snapshot(files: readonly ChangedFile[] = []): WorkingTreeSnapshot {
  return {
    repositoryRoot: "/tmp/repo",
    branch: "main",
    upstream: "origin/main",
    reviewTarget: { kind: "working-tree", scope: "all" },
    files,
    patches: [{ label: "UNSTAGED", text: "" }],
  }
}

const emptyDiffDocument: DiffDocument = { text: "", lines: [], files: [] }

function branchSnapshot(baseRef: string): BranchReviewSnapshot {
  return {
    repositoryRoot: "/tmp/repo",
    branch: "main",
    baseRef,
    baseOid: "base-oid",
    headOid: "head-oid",
    mergeBaseOid: "base-oid",
    commitCount: 0,
    reviewTarget: { kind: "branch", baseRef, baseOid: "base-oid", headOid: "head-oid" },
    files: [],
    patches: [{ label: "BRANCH", text: "" }],
  }
}

/** No git runs: every method under test is stubbed, so only the label reaches the log. */
function stubMutations(): GitMutations {
  const noop = async (): Promise<void> => {}
  return {
    stageFile: noop,
    unstageFile: noop,
    discardFile: noop,
    applySelection: noop,
    discardSelection: noop,
  } as unknown as GitMutations
}

function harness(files: readonly ChangedFile[] = []): { readonly controller: AppController; readonly log: CommandLog } {
  const log = new CommandLog()
  const controller = new AppController({
    repositoryRoot: "/tmp/repo",
    runner: new GitRunner({ cwd: "/tmp/repo", log }),
    load: async () => snapshot(files),
    // Reaching a Branch Review target must not spawn real git (tests/app/controller-branch.test.ts
    // uses the same stub loaders to get there without a real repository).
    loadBranch: async (baseRef) => branchSnapshot(baseRef),
    inferBase: async () => ({ kind: "confident" as const, ref: "origin/main", oid: "base-oid", reason: "test" }),
    mutations: stubMutations(),
    commitMutations: { commit: async () => {}, amend: async () => {}, currentMessage: async () => "" } as never,
  })
  return { controller, log }
}

function actions(log: CommandLog): readonly string[] {
  return log.lines()
    .filter((line) => line.spans.some((span) => span.style === "action"))
    .map((line) => line.spans.map((span) => span.text).join(""))
}

/**
 * lazygit calls LogAction from its UI controllers, the layer where one user intent becomes N git
 * commands (pkg/gui/controllers/files_controller.go:544,559; stash_controller.go:127,141,169;
 * sync_controller.go:167,197). githunk's equivalent layer is AppController — its mutation methods
 * map one-to-one onto user intents, and unlike root-view they run without a renderer.
 */
describe("action labels", () => {
  test("stageFile logs Stage file", async () => {
    const { controller, log } = harness()
    await controller.refresh()
    await controller.stageFile("a.ts")
    expect(actions(log)).toContain(LOG_ACTIONS.stageFile)
    expect(LOG_ACTIONS.stageFile).toBe("Stage file")
  })

  test("unstageFile logs Unstage file", async () => {
    const { controller, log } = harness()
    await controller.refresh()
    await controller.unstageFile("a.ts")
    expect(actions(log)).toContain("Unstage file")
  })

  test("discardFile logs lazygit's unstaged label verbatim, typo included", async () => {
    const { controller, log } = harness()
    await controller.refresh()
    await controller.discardFile("a.ts")
    // english.go:2174 omits "in" before "selected" — that's upstream's typo, reproduced verbatim.
    expect(actions(log)).toContain("Discard all unstaged changes selected file(s)")
  })

  /**
   * staging_controller.go:239-265: staging a selection (`ApplySelection`) and discarding one
   * (`DiscardSelection`, which routes into `applySelectionAndRefresh(true)`) share the same
   * `Tr.Actions.ApplyPatch` label (english.go:2215). Both call sites are exercised directly here —
   * `applyPatch` is referenced twice in `LOG_ACTIONS`' mapping (once per method), so a static
   * reachability check alone cannot tell whether either call site still exists.
   */
  test("applySelection logs Apply patch", async () => {
    const { controller, log } = harness()
    await controller.refresh()
    await controller.applySelection(emptyDiffDocument, [], { reverse: false, wholeFile: true })
    expect(actions(log)).toEqual([LOG_ACTIONS.applyPatch])
  })

  test("discardSelection logs Apply patch", async () => {
    const { controller, log } = harness()
    await controller.refresh()
    await controller.discardSelection(emptyDiffDocument, [], { wholeFile: true })
    expect(actions(log)).toEqual([LOG_ACTIONS.applyPatch])
  })

  test("commit and amend log their own labels", async () => {
    const { controller, log } = harness()
    await controller.refresh()
    await controller.commit("m")
    await controller.amend("m")
    expect(actions(log)).toEqual(["Commit", "Amend commit"])
  })

  /** The guard runs first: a read-only target must not log an action it will not perform. */
  test("a blocked mutation logs nothing", async () => {
    const { controller, log } = harness()
    await controller.refresh()
    await controller.switchMode("branch")
    expect(controller.state.reviewTarget.kind).toBe("branch")
    await controller.stageFile("a.ts")
    expect(actions(log)).toEqual([])
  })

  /**
   * This is a shape check only — it does not compare against lazygit, so a typo like "Stagee
   * file" would still pass it. The verbatim-string requirement is carried by the individual pins
   * scattered through this file (e.g. `expect(actions(log)).toContain("Unstage file")` above).
   */
  test("every label is non-empty, starts with a capital letter, and has no trailing punctuation", () => {
    for (const label of Object.values(LOG_ACTIONS)) {
      expect(label.length).toBeGreaterThan(0)
      expect(label).not.toMatch(/[.:]$/)
      expect(label[0]).toBe(label[0]?.toUpperCase())
    }
  })

  /**
   * A missed label is silent — no test fails, the log just quietly lacks an action — so besides
   * the behavioural assertions above (which would catch a call site being deleted), this is a
   * cheap static net against the opposite mistake: a `LOG_ACTIONS` entry added but never wired to
   * any `logAction` call site, which would be dead code nobody notices either.
   */
  test("every LOG_ACTIONS entry is referenced from controller.ts or create-app.ts", async () => {
    const controllerSource = await Bun.file(`${import.meta.dir}/../../src/app/controller.ts`).text()
    const createAppSource = await Bun.file(`${import.meta.dir}/../../src/app/create-app.ts`).text()
    for (const key of Object.keys(LOG_ACTIONS)) {
      const reference = `LOG_ACTIONS.${key}`
      const referenced = controllerSource.includes(reference) || createAppSource.includes(reference)
      expect(referenced, `${reference} is not referenced from controller.ts or create-app.ts`).toBe(true)
    }
  })

  /**
   * createStash picks its label from `includeUntracked`, the way `handleStashSave`'s caller does
   * (files_controller.go:1282/:1482 push vs :1300 include-untracked -> :1516). githunk has no
   * staged-only stash, but does have this distinction.
   */
  test("createStash logs Stash all changes when untracked files are excluded", async () => {
    const { controller, log } = harness()
    await controller.refresh()
    const options: StashCreateOptions = { includeUntracked: false }
    await controller.createStash("wip", options)
    expect(actions(log)).toContain("Stash all changes")
  })

  test("createStash logs the untracked-files label verbatim when included", async () => {
    const { controller, log } = harness()
    await controller.refresh()
    const options: StashCreateOptions = { includeUntracked: true }
    await controller.createStash("wip", options)
    expect(actions(log)).toContain("Stash all changes including untracked files")
  })

  /**
   * The background fetch is `DontLog()` in lazygit (git_commands/sync.go:81): no action label,
   * so the 60-second timer never buries what the user actually ran.
   */
  test("a background fetch logs nothing, a foreground fetch logs Fetch", async () => {
    const { controller, log } = harness()
    await controller.refresh()
    await controller.fetch(undefined, { background: true })
    expect(actions(log)).toEqual([])
    await controller.fetch()
    expect(actions(log)).toEqual(["Fetch"])
  })

  /**
   * Delegating methods stay silent so one keypress never produces two labels: `switchLocal`
   * defers to `switchLocalBranch`, which is the one that logs (branches_controller.go:417,516).
   *
   * Branch mutations go straight to the real `GitRunner` (unlike `stageFile` etc., which route
   * through the injectable `GitMutations`), so against this harness's non-repository `/tmp/repo`
   * the underlying `git switch` fails — after the label is already logged, exactly as lazygit logs
   * unconditionally before attempting the command (command_log_panel.go:25-44 has no error path).
   * The rejection is swallowed here because only the label is under test.
   */
  test("switchLocal logs exactly one Checkout branch, not two", async () => {
    const { controller, log } = harness()
    await controller.refresh()
    await controller.switchLocal("feature").catch(() => {})
    expect(actions(log)).toEqual(["Checkout branch"])
  })

  /**
   * githunk-only actions that run no git command get no label
   * (markFileReviewed, setBranchBase, switchMode into working-tree).
   */
  test("githunk-only review actions log nothing", async () => {
    const { controller, log } = harness()
    await controller.refresh()
    await controller.markFocusedFileReviewed("a.ts")
    await controller.setWorkingTreeScope("staged")
    expect(actions(log)).toEqual([])
  })

  /**
   * files_controller.go:555-557 returns `NothingToStageForSubmodule` *before* the `LogAction` at
   * :559 when there is nothing left to stage or unstage — a clean tree must not write an action
   * line for a `for` loop that iterates zero files. `controller.ts`'s `toggleAllFiles` guards on
   * `files.length === 0` for the same reason.
   */
  test("toggleAllFiles on a clean tree logs nothing", async () => {
    const { controller, log } = harness()
    await controller.refresh()
    await controller.toggleAllFiles()
    expect(actions(log)).toEqual([])
  })

  const stagedFile: ChangedFile = { path: "staged.ts", indexStatus: "M", worktreeStatus: ".", untracked: false, conflicted: false, additions: 1, deletions: 0 }
  const unstagedFile: ChangedFile = { path: "unstaged.ts", indexStatus: ".", worktreeStatus: "M", untracked: false, conflicted: false, additions: 1, deletions: 0 }

  test("toggleAllFiles logs Unstage all files when everything is already staged", async () => {
    // shouldStage is `files.some((file) => file.untracked || file.worktreeStatus !== ".")`
    // (controller.ts:954); a fully-staged file (worktreeStatus ".", not untracked) keeps that
    // false, landing on the "nothing left to stage" branch (files_controller.go:544 vs :559).
    const { controller, log } = harness([stagedFile])
    await controller.refresh()
    await controller.toggleAllFiles()
    expect(actions(log)).toEqual(["Unstage all files"])
  })

  test("toggleAllFiles logs Stage all files when an unstaged file is present", async () => {
    // A file with worktreeStatus other than "." trips `shouldStage` true.
    const { controller, log } = harness([unstagedFile])
    await controller.refresh()
    await controller.toggleAllFiles()
    expect(actions(log)).toEqual(["Stage all files"])
  })

  /**
   * Carried fix from task 12's review of task 11: `toggleAllFiles` used to check
   * `this.currentState.files.length === 0` *before* enqueueing onto `mutationQueue`
   * (controller.ts, pre-fix), but read `this.currentState.files` again *inside* the queued
   * callback. `MutationQueue.run` chains rather than rejects, and the 10-second working-tree
   * background refresh (`refreshFiles`, controller.ts:474-478) shares the same queue — so a
   * refresh in flight when the user presses `a` could pass the outer guard on a stale non-empty
   * `files`, queue behind the refresh, have the refresh empty `files`, and then have the re-read
   * inside the callback see `[]`: `shouldStage` is false on an empty array, so it logged "Unstage
   * all files" for a zero-iteration loop — exactly what the guard exists to prevent
   * (files_controller.go:555-557 / :559).
   *
   * This constructs that race deterministically: `refreshFiles()` is left in flight on a gated
   * loader (so `currentState.files` is provably still non-empty when `toggleAllFiles()` is
   * called), and only then released to complete with an empty snapshot before `toggleAllFiles`'s
   * queued callback runs.
   */
  test("toggleAllFiles re-reads files after a same-queue refresh empties the tree, not before it", async () => {
    const log = new CommandLog()
    let releaseGate: (() => void) | undefined
    const gate = new Promise<void>((resolve) => { releaseGate = resolve })
    let loadCount = 0
    const controller = new AppController({
      repositoryRoot: "/tmp/repo",
      runner: new GitRunner({ cwd: "/tmp/repo", log }),
      load: async () => {
        loadCount += 1
        if (loadCount === 1) return snapshot([unstagedFile])
        // The second load (refreshFiles' background refresh) pauses here until the test releases
        // it, so `toggleAllFiles()` below is provably called while `currentState.files` is still
        // the first load's non-empty snapshot.
        await gate
        return snapshot([])
      },
      loadBranch: async (baseRef) => branchSnapshot(baseRef),
      inferBase: async () => ({ kind: "confident" as const, ref: "origin/main", oid: "base-oid", reason: "test" }),
      mutations: stubMutations(),
      commitMutations: { commit: async () => {}, amend: async () => {}, currentMessage: async () => "" } as never,
    })
    await controller.refresh()
    expect(controller.state.files).toEqual([unstagedFile])

    const refreshPromise = controller.refreshFiles()
    // refreshFiles is awaiting `gate` inside the queue; currentState.files is still [unstagedFile].
    const togglePromise = controller.toggleAllFiles()
    releaseGate!()
    await refreshPromise
    await togglePromise

    expect(controller.state.files).toEqual([])
    expect(actions(log)).toEqual([])
  })

  /**
   * The remaining labelled methods reach real git directly (`requireRunnerOperation`), unlike
   * `stageFile` etc. above, which route through the injectable `GitMutations`/`CommitMutations`
   * seams. Against this harness's non-repository `/tmp/repo` the git command itself fails, but —
   * as with `switchLocal` above — the label is logged synchronously before that async failure, so
   * asserting the label and swallowing the rejection still exercises the real call site.
   */
  const realGitCases: ReadonlyArray<{
    readonly name: string
    readonly expected: string
    readonly run: (controller: AppController) => Promise<unknown>
  }> = [
    { name: "createBranch", expected: "Create branch", run: (controller) => controller.createBranch("feature") },
    { name: "deleteBranch", expected: "Delete local branch", run: (controller) => controller.deleteBranch("feature") },
    { name: "renameBranch", expected: "Rename branch", run: (controller) => controller.renameBranch("old", "new") },
    { name: "fetchRemote", expected: "Fetch", run: (controller) => controller.fetchRemote("origin") },
    { name: "checkoutRemoteTracking", expected: "Checkout branch", run: (controller) => controller.checkoutRemoteTracking("origin/feature") },
    { name: "applyStash", expected: "Apply stash", run: (controller) => controller.applyStash("stash@{0}") },
    { name: "popStash", expected: "Pop stash", run: (controller) => controller.popStash("stash@{0}") },
    { name: "dropStash", expected: "Drop stash", run: (controller) => controller.dropStash("stash@{0}", { confirmed: true }) },
    { name: "fetch (foreground)", expected: "Fetch", run: (controller) => controller.fetch() },
    { name: "pull", expected: "Pull", run: (controller) => controller.pull() },
    { name: "push", expected: "Push", run: (controller) => controller.push() },
  ]
  for (const { name, expected, run } of realGitCases) {
    test(`${name} logs "${expected}" before the git command it attempts`, async () => {
      const { controller, log } = harness()
      await controller.refresh()
      await run(controller).catch(() => {})
      expect(actions(log)).toEqual([expected])
    })
  }

  /**
   * `chooseUpstream` reads `currentState.upstreamChoice`, which pull/push populate on discovering
   * there is no upstream (git/sync.ts's `UpstreamRequired`). Reaching that naturally needs a real
   * branch with no upstream configured; that path is git/sync.ts's own concern, not this label's,
   * so the private field is set directly to isolate what's under test here — that
   * `chooseUpstream` logs `Set branch upstream` itself and then still gets `push`'s own label from
   * delegating to it (remote_branches_controller.go:187; english.go:2210).
   */
  test("chooseUpstream logs Set branch upstream, then push's own label", async () => {
    const { controller, log } = harness()
    await controller.refresh()
    const mutableController = controller as unknown as { currentState: typeof controller.state }
    mutableController.currentState = {
      ...controller.state,
      upstreamChoice: { kind: "upstream-required", branch: "main", candidates: [], operation: "push" },
    }
    await controller.chooseUpstream("origin", "main").catch(() => {})
    expect(actions(log)).toEqual(["Set branch upstream", "Push"])
  })
})
