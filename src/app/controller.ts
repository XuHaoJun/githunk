import { GitRunner, GitCommandError } from "../git/runner"
import { loadWorkingTree } from "../git/diff"
import { loadBranchReview, type BranchReviewSnapshot } from "../git/branch-review"
import { listCommits, loadCommit, loadCommitFilePatch } from "../git/commits"
import type { CommitDetails, CommitSummary } from "../domain/commit"
import { inferReviewBase, currentBranchRef, resolveRefOid, reviewBaseCandidates, type BaseInference } from "../git/base-inference"
import { parseDiff } from "../domain/diff/parse"
import type { DiffDocument, DiffFile } from "../domain/diff/document"
import type { AppModel, PatchSection } from "../domain/repository"
import type { BranchListing } from "../domain/branch"
import type { WorkingTreeSnapshot } from "../domain/repository"
import type { ReviewTarget, WorkingTreeScope, ChangedFile } from "../domain/review-target"
import { reviewStateFor, type ReviewDatabase, type ReviewFileState } from "../domain/review-progress"
import { fingerprintFile, targetKey } from "../review/fingerprint"
import { emptyReviewDatabase, ReviewStore } from "../review/store"
import { GitMutations, type SelectionMutationOptions } from "../git/mutations"
import { CommitMutations } from "../git/commit-mutations"
import { checkoutRemoteTracking, createBranch, deleteBranch, fetchRemote, listBranches, listRemoteBranches, renameBranch, switchLocal, type CheckoutRemoteTrackingOptions, type CheckoutRemoteTrackingResult, type DeleteBranchOptions, type RemoteBranchSelection } from "../git/branches"
import { listStashes, loadStash, createStash as createGitStash, applyStash as applyGitStash, popStash as popGitStash, dropStash as dropGitStash } from "../git/stash"
import { fetch as fetchSync, pull as pullSync, push as pushSync, type FetchOptions, type PullOptions, type PushOptions, type PushResult } from "../git/sync"
import type { StashCreateOptions, StashDropOptions, StashEntry } from "../domain/stash"
import type { TagPreview, TagSummary } from "../domain/tag"
import { listTags, loadTagPreview } from "../git/tags"
import { loadRefLog, refLogFullName, type RefLogTarget } from "../git/ref-log"
import { pullRequestsByBranch, type PullRequest } from "../domain/pull-request"
import type { ReflogEntry } from "../domain/reflog"
import { listReflog } from "../git/reflog"
import type { Worktree } from "../domain/worktree"
import { listWorktrees } from "../git/worktrees"
import type { SubmoduleConfig } from "../domain/submodule"
import { listSubmodules } from "../git/submodules"
import { MutationQueue } from "./mutation-queue"
import { LOG_ACTIONS } from "./log-actions"
export type WorkingTreeLoader = (
  target: Extract<ReviewTarget, { readonly kind: "working-tree" }>,
  options?: { readonly background?: boolean },
) => Promise<WorkingTreeSnapshot>
export type BranchReviewLoader = (baseRef: string) => Promise<BranchReviewSnapshot>
export type BranchListingLoader = () => Promise<BranchListing>
export type CommitListLoader = (range: string, filter?: string) => Promise<readonly CommitSummary[]>
export type CommitLoader = (oid: string) => Promise<CommitDetails>
export type CommitFilePatchLoader = (oid: string, path: string) => Promise<DiffDocument>
export type BaseInferenceLoader = () => Promise<BaseInference>
export type TagListLoader = () => Promise<readonly TagSummary[]>
export type ReflogListLoader = () => Promise<readonly ReflogEntry[]>
export type WorktreeListLoader = () => Promise<readonly Worktree[]>
export type SubmoduleListLoader = () => Promise<readonly SubmoduleConfig[]>
export type PullRequestListLoader = () => Promise<readonly PullRequest[]>


export type AppControllerOptions = {
  readonly repositoryRoot?: string
  readonly runner?: GitRunner
  readonly load?: WorkingTreeLoader
  readonly loader?: WorkingTreeLoader
  readonly loadBranch?: BranchReviewLoader
  readonly branchLoader?: BranchReviewLoader
  readonly loadCommits?: CommitListLoader
  readonly commitsLoader?: CommitListLoader
  readonly loadCommit?: CommitLoader
  readonly commitLoader?: CommitLoader
  readonly loadCommitFilePatch?: CommitFilePatchLoader
  readonly loadBranches?: BranchListingLoader
  readonly branchesLoader?: BranchListingLoader
  readonly commitFilePatchLoader?: CommitFilePatchLoader
  readonly inferBase?: BaseInferenceLoader
  readonly loadStashes?: () => Promise<readonly StashEntry[]>
  readonly loadTags?: TagListLoader
  // alias for symmetry with branchesLoader; prefer loadTags
  readonly tagsLoader?: TagListLoader
  readonly loadReflog?: ReflogListLoader
  // alias for symmetry with tagsLoader; prefer loadReflog
  readonly reflogLoader?: ReflogListLoader
  readonly loadWorktrees?: WorktreeListLoader
  // alias for symmetry with tagsLoader; prefer loadWorktrees
  readonly worktreesLoader?: WorktreeListLoader
  readonly loadSubmodules?: SubmoduleListLoader
  // alias for symmetry with tagsLoader; prefer loadSubmodules
  readonly submodulesLoader?: SubmoduleListLoader
  /**
   * Pull requests for the branches panel's dots. Absent — or failing, which is what an unavailable
   * `gh` looks like — leaves the panel exactly as it renders without them.
   */
  readonly loadPullRequests?: PullRequestListLoader
  readonly mutations?: GitMutations
  readonly commitMutations?: CommitMutations
  readonly reviewStore?: ReviewStore
}
function titleFor(target: ReviewTarget, branch = ""): string {
  if (target.kind === "working-tree") {
    return `Working Tree — ${target.scope[0]?.toUpperCase() ?? "A"}${target.scope.slice(1)}`
  }
  if (target.kind === "branch") return `${branch || "Branch"} vs ${target.baseRef}`
  if (target.kind === "commit") return `Commit — ${target.oid}`
  return `Stash — ${target.ref}`
}
/**
 * Sections with their file boundaries resolved once. `rawPatchForFile` is asked for every changed
 * file, so parsing inside it made review fingerprinting cost files times patch size.
 */
type IndexedPatchSection = { readonly text: string; readonly files: readonly DiffFile[] }

function indexPatchSections(patches: readonly PatchSection[]): readonly IndexedPatchSection[] {
  return patches.map((section) => ({ text: section.text, files: parseDiff(section.text).files }))
}

function rawPatchForFile(file: ChangedFile, sections: readonly IndexedPatchSection[]): string {
  let result = ""
  for (const section of sections) {
    for (const parsed of section.files) {
      if (parsed.newPath !== file.path && parsed.oldPath !== file.path && parsed.newPath !== file.previousPath && parsed.oldPath !== file.previousPath) continue
      result += section.text.slice(parsed.startUtf16, parsed.endUtf16)
    }
  }
  return result
}
function ownValue<T>(record: Record<string, T> | undefined, key: string): T | undefined {
  return record !== undefined && Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined
}
function changedFilesFromDocument(document: DiffDocument): readonly ChangedFile[] {
  return document.files.flatMap((file: DiffFile) => {
    const path = file.newPath !== undefined && file.newPath !== "/dev/null" ? file.newPath : file.oldPath
    if (path === undefined || path === "/dev/null") return []
    const additions = file.lines.filter((line) => line.kind === "addition").length
    const deletions = file.lines.filter((line) => line.kind === "deletion").length
    return [{
      path,
      ...(file.oldPath !== undefined && file.newPath !== undefined && file.oldPath !== "/dev/null" && file.newPath !== "/dev/null" && file.oldPath !== file.newPath ? { previousPath: file.oldPath } : {}),
      indexStatus: ".",
      worktreeStatus: ".",
      untracked: false,
      conflicted: false,
      additions,
      deletions,
    }]
  })
}

export class AppController {
  readonly commitMutations: CommitMutations | undefined
  readonly runner: GitRunner | undefined
  readonly mutations: GitMutations | undefined
  readonly reviewStore: ReviewStore | undefined
  readonly mutationQueue = new MutationQueue()
  private readonly loadSnapshot: WorkingTreeLoader
  private readonly loadBranchSnapshot: BranchReviewLoader
  private readonly loadBranchesListing: BranchListingLoader
  private readonly loadStashesListing: () => Promise<readonly StashEntry[]>
  private readonly loadTagsListing: TagListLoader
  private readonly loadReflogListing: ReflogListLoader
  private readonly loadWorktreesListing: WorktreeListLoader
  private readonly loadSubmodulesListing: SubmoduleListLoader
  private readonly loadPullRequestList: PullRequestListLoader | undefined
  private readonly loadCommitList: CommitListLoader
  private readonly loadCommitDetails: CommitLoader
  private readonly loadCommitFile: CommitFilePatchLoader
  private readonly inferBase: BaseInferenceLoader
  private generation = 0
  private currentState: AppModel
  private reviewDatabase: ReviewDatabase = emptyReviewDatabase()
  private workingTreeCursor: { readonly selectionId?: string; readonly focusId?: string } = {}
  private branchCursor: { readonly selectionId?: string; readonly focusId?: string } = {}
  private priorStashStateForRefresh: AppModel | undefined
  private pendingBranchWarning: string | undefined

  constructor(options: AppControllerOptions | GitRunner, loader?: WorkingTreeLoader) {
    const runner = options instanceof GitRunner ? options : options.runner
    const load = options instanceof GitRunner ? loader : options.load ?? options.loader
    const repositoryRoot = options instanceof GitRunner ? options.cwd : options.repositoryRoot ?? runner?.cwd
    const shouldUseDefaultReviewStore = load === undefined
    this.reviewStore = options instanceof GitRunner
      ? shouldUseDefaultReviewStore ? new ReviewStore({ repositoryRoot, runner }) : undefined
      : options.reviewStore ?? (!shouldUseDefaultReviewStore || runner === undefined || repositoryRoot === undefined ? undefined : new ReviewStore({ repositoryRoot, runner }))
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
    this.loadSnapshot = load ?? ((target, snapshotOptions) => {
      if (runner === undefined) throw new Error("AppController requires a GitRunner or loader")
      return loadWorkingTree(runner, target.scope, snapshotOptions ?? {})
    })
    this.loadBranchSnapshot = options instanceof GitRunner
      ? (baseRef) => loadBranchReview(options, baseRef)
      : options.loadBranch ?? options.branchLoader ?? (runner === undefined ? async () => { throw new Error("Branch review requires a GitRunner") } : (baseRef) => loadBranchReview(runner, baseRef))
    this.loadBranchesListing = options instanceof GitRunner
      ? () => listBranches(options)
      : options.loadBranches ?? options.branchesLoader ?? (runner !== undefined ? () => listBranches(runner) : async () => ({ detached: true, localBranches: [], remotes: [] }))
    this.loadCommitList = options instanceof GitRunner
      ? (range, filter) => listCommits(options, range, filter)
      : options.loadCommits ?? options.commitsLoader ?? (runner === undefined ? async () => [] : (range, filter) => listCommits(runner, range, filter))
    this.loadCommitDetails = options instanceof GitRunner
      ? (oid) => loadCommit(options, oid)
      : options.loadCommit ?? options.commitLoader ?? (runner === undefined ? async () => { throw new Error("Commit details require a GitRunner") } : (oid) => loadCommit(runner, oid))
    this.loadCommitFile = options instanceof GitRunner
      ? (oid, path) => loadCommitFilePatch(options, oid, path)
      : options.loadCommitFilePatch ?? options.commitFilePatchLoader ?? (runner === undefined ? async () => { throw new Error("Commit file patches require a GitRunner") } : (oid, path) => loadCommitFilePatch(runner, oid, path))
    this.inferBase = options instanceof GitRunner
      ? () => inferReviewBase(options)
      : options.inferBase ?? (runner === undefined ? async () => ({ kind: "choose" as const, candidates: [], reason: "no Git runner" }) : () => inferReviewBase(runner))
    this.loadStashesListing = options instanceof GitRunner
      ? () => listStashes(options)
      : options.loadStashes ?? (runner === undefined ? async () => [] : () => listStashes(runner))
    this.loadTagsListing = options instanceof GitRunner
      ? () => listTags(options)
      : options.loadTags ??
        options.tagsLoader ??
        (runner !== undefined ? () => listTags(runner) : async () => [] as readonly TagSummary[])
    this.loadReflogListing = options instanceof GitRunner
      ? () => listReflog(options)
      : options.loadReflog ??
        options.reflogLoader ??
        (runner !== undefined ? () => listReflog(runner) : async () => [] as readonly ReflogEntry[])
    this.loadWorktreesListing = options instanceof GitRunner
      ? () => listWorktrees(options)
      : options.loadWorktrees ??
        options.worktreesLoader ??
        (runner !== undefined ? () => listWorktrees(runner) : async () => [] as readonly Worktree[])
    this.loadPullRequestList = options instanceof GitRunner ? undefined : options.loadPullRequests
    this.loadSubmodulesListing = options instanceof GitRunner
      ? () => listSubmodules(options)
      : options.loadSubmodules ??
        options.submodulesLoader ??
        (runner !== undefined ? () => listSubmodules(runner) : async () => [] as readonly SubmoduleConfig[])
    const target: ReviewTarget = { kind: "working-tree", scope: "all" }
    this.currentState = {
      repositoryRoot: repositoryRoot ?? "",
      branch: "",
      reviewTarget: target,
      files: [],
      patches: [],
      rawPatchSections: [],
      reviewStatuses: Object.create(null) as Record<string, ReviewFileState>,
      reviewSummary: { reviewed: 0, invalidated: 0, commits: 0, files: 0, additions: 0, deletions: 0 },
      loading: false,
      commandLog: runner?.log.lines() ?? [],
      ...(runner?.log === undefined ? {} : { commandLogAutoscrollArms: runner.log.autoscrollArms() }),
      title: titleFor(target),
      commits: [],
    }
  }
  get state(): AppModel {
    return this.currentState
  }

  /**
   * The log snapshot every state assignment shares. `exactOptionalPropertyTypes` is why
   * `commandLogAutoscrollArms` comes back absent rather than `undefined` when there is no runner.
   */
  private commandLogSnapshot(): Pick<AppModel, "commandLog" | "commandLogAutoscrollArms"> {
    const log = this.runner?.log
    if (log === undefined) return { commandLog: this.currentState.commandLog }
    return { commandLog: log.lines(), commandLogAutoscrollArms: log.autoscrollArms() }
  }

  /**
   * The last pull requests fetched, kept so a branch refresh can re-key them against the new branch
   * list without another network call — lazygit's `rebuildPullRequestsMap`
   * (pkg/gui/controllers/helpers/refresh_helper.go:1819-1825).
   */
  private pullRequestList: readonly PullRequest[] = []

  private rebuildPullRequests(): void {
    if (this.pullRequestList.length === 0) return
    const listing = this.currentState.branches
    this.currentState = {
      ...this.currentState,
      pullRequests: pullRequestsByBranch(this.pullRequestList, listing?.localBranches ?? [], listing?.remotes ?? []),
    }
  }

  /**
   * Asks `gh` for this repo's pull requests and re-keys them by branch. A failure is swallowed:
   * `gh` missing or unauthenticated is the common case, and lazygit likewise only logs when it
   * cannot reach GitHub (refresh_helper.go:1840-1843).
   */
  async refreshPullRequests(): Promise<void> {
    if (this.loadPullRequestList === undefined) return
    try {
      this.pullRequestList = await this.loadPullRequestList()
    } catch {
      this.pullRequestList = []
      this.currentState = { ...this.currentState, ...this.commandLogSnapshot() }
      return
    }
    const listing = this.currentState.branches
    this.currentState = {
      ...this.currentState,
      pullRequests: pullRequestsByBranch(this.pullRequestList, listing?.localBranches ?? [], listing?.remotes ?? []),
      ...this.commandLogSnapshot(),
    }
  }

  async refresh(): Promise<void> {
    const generation = ++this.generation
    const branchesPromise = this.loadBranchesListing().then(
      (value) => ({ status: "fulfilled" as const, value }),
      (reason) => ({ status: "rejected" as const, reason }),
    )
    const stashesPromise = this.loadStashesListing().then(
      (value) => ({ status: "fulfilled" as const, value }),
      (reason) => ({ status: "rejected" as const, reason }),
    )
    const tagsPromise = this.loadTagsListing().then(
      (value) => ({ status: "fulfilled" as const, value }),
      (reason) => ({ status: "rejected" as const, reason }),
    )
    const reflogPromise = this.loadReflogListing().then(
      (value) => ({ status: "fulfilled" as const, value }),
      (reason) => ({ status: "rejected" as const, reason }),
    )
    const worktreesPromise = this.loadWorktreesListing().then(
      (value) => ({ status: "fulfilled" as const, value }),
      (reason) => ({ status: "rejected" as const, reason }),
    )
    const submodulesPromise = this.loadSubmodulesListing().then(
      (value) => ({ status: "fulfilled" as const, value }),
      (reason) => ({ status: "rejected" as const, reason }),
    )
    const [branchesResult, stashesResult, tagsResult, reflogResult, worktreesResult, submodulesResult] = await Promise.all([branchesPromise, stashesPromise, tagsPromise, reflogPromise, worktreesPromise, submodulesPromise])
    if (generation !== this.generation) return
    let branchWarning: string | undefined
    let stashWarning: string | undefined
    let tagWarning: string | undefined
    let reflogWarning: string | undefined
    let worktreeWarning: string | undefined
    let submoduleWarning: string | undefined
    if (branchesResult.status === "fulfilled") {
      this.currentState = {
        ...this.currentState,
        branches: branchesResult.value,
        ...this.commandLogSnapshot(),
      }
    } else {
      const error = branchesResult.reason
      branchWarning =
        error instanceof GitCommandError ? error.record.stderr || error.message : error instanceof Error ? error.message : String(error)
      this.currentState = {
        ...this.currentState,
        banner: branchWarning,
        ...this.commandLogSnapshot(),
      }
    }
    if (stashesResult.status === "fulfilled") {
      this.currentState = {
        ...this.currentState,
        stashes: stashesResult.value,
        ...this.commandLogSnapshot(),
      }
    } else {
      const error = stashesResult.reason
      stashWarning =
        error instanceof GitCommandError ? error.record.stderr || error.message : error instanceof Error ? error.message : String(error)
      this.currentState = {
        ...this.currentState,
        banner: stashWarning,
        ...this.commandLogSnapshot(),
      }
    }
    if (tagsResult.status === "fulfilled") {
      this.currentState = {
        ...this.currentState,
        tags: tagsResult.value,
        ...this.commandLogSnapshot(),
      }
    } else {
      const error = tagsResult.reason
      tagWarning =
        error instanceof GitCommandError ? error.record.stderr || error.message : error instanceof Error ? error.message : String(error)
      this.currentState = {
        ...this.currentState,
        banner: tagWarning,
        ...this.commandLogSnapshot(),
      }
    }
    // A reflog is optional data (a fresh repo, `core.logAllRefUpdates=false` or an expired
    // reflog all leave it empty), so a failure only raises a banner — never aborts the refresh.
    if (reflogResult.status === "fulfilled") {
      this.currentState = {
        ...this.currentState,
        reflog: reflogResult.value,
        ...this.commandLogSnapshot(),
      }
    } else {
      const error = reflogResult.reason
      reflogWarning =
        error instanceof GitCommandError ? error.record.stderr || error.message : error instanceof Error ? error.message : String(error)
      this.currentState = {
        ...this.currentState,
        banner: reflogWarning,
        ...this.commandLogSnapshot(),
      }
    }
    // Worktrees and submodules are optional data too — a repository can have neither, and
    // `git worktree list` can fail outright in a bare or partially initialised repo — so a
    // failure only raises a banner, exactly as the reflog does.
    if (worktreesResult.status === "fulfilled") {
      this.currentState = {
        ...this.currentState,
        worktrees: worktreesResult.value,
        ...this.commandLogSnapshot(),
      }
    } else {
      const error = worktreesResult.reason
      worktreeWarning =
        error instanceof GitCommandError ? error.record.stderr || error.message : error instanceof Error ? error.message : String(error)
      this.currentState = {
        ...this.currentState,
        banner: worktreeWarning,
        ...this.commandLogSnapshot(),
      }
    }
    if (submodulesResult.status === "fulfilled") {
      this.currentState = {
        ...this.currentState,
        submodules: submodulesResult.value,
        ...this.commandLogSnapshot(),
      }
    } else {
      const error = submodulesResult.reason
      submoduleWarning =
        error instanceof GitCommandError ? error.record.stderr || error.message : error instanceof Error ? error.message : String(error)
      this.currentState = {
        ...this.currentState,
        banner: submoduleWarning,
        ...this.commandLogSnapshot(),
      }
    }
    const target = this.currentState.reviewTarget
    if (target.kind === "working-tree") {
      await this.refreshTarget(target)
    } else if (target.kind === "branch") {
      await this.openBranchReview()
    } else if (target.kind === "stash") {
      await this.refreshStashTarget(target.ref)
    }
    if (branchWarning !== undefined) {
      this.currentState = {
        ...this.currentState,
        banner: branchWarning,
        ...this.commandLogSnapshot(),
      }
    }
    if (stashWarning !== undefined) {
      this.currentState = { ...this.currentState, banner: stashWarning, ...this.commandLogSnapshot() }
    }
    if (tagWarning !== undefined) {
      this.currentState = { ...this.currentState, banner: tagWarning, ...this.commandLogSnapshot() }
    }
    if (reflogWarning !== undefined) {
      this.currentState = { ...this.currentState, banner: reflogWarning, ...this.commandLogSnapshot() }
    }
    if (worktreeWarning !== undefined) {
      this.currentState = { ...this.currentState, banner: worktreeWarning, ...this.commandLogSnapshot() }
    }
    if (submoduleWarning !== undefined) {
      this.currentState = { ...this.currentState, banner: submoduleWarning, ...this.commandLogSnapshot() }
    }
    // The branch list just changed, so the cached pull requests need re-keying against it.
    this.rebuildPullRequests()
  }

  /**
   * lazygit's `RefreshOptions{Scope: []{FILES}}` — the working-tree half of a refresh and nothing
   * else, which is what the 10-second background routine runs (pkg/gui/background.go:146-154).
   * Queued behind any mutation in flight, so it cannot read a half-applied index.
   */
  async refreshFiles(): Promise<void> {
    const target = this.currentState.reviewTarget
    if (target.kind !== "working-tree") return
    await this.mutationQueue.run(() => this.refreshTarget(target, { background: true }))
  }

  async refreshBranches(): Promise<string | undefined> {
    try {
      const branches = await this.loadBranchesListing()
      this.currentState = {
        ...this.currentState,
        branches,
        ...this.commandLogSnapshot(),
      }
      this.rebuildPullRequests()
      return undefined
    } catch (error) {
      const banner = error instanceof GitCommandError
        ? (error.record.stderr || error.message)
        : error instanceof Error ? error.message : String(error)
      this.currentState = {
        ...this.currentState,
        banner,
        ...this.commandLogSnapshot(),
      }
      return banner
    }
  }
  async switchLocal(branch: string): Promise<void> {
    await this.switchLocalBranch(branch)
  }
  async switchLocalBranch(branch: string): Promise<void> {
    this.logAction(LOG_ACTIONS.checkoutBranch)
    await this.runBranchMutation(() => this.requireRunnerOperation((runner) => switchLocal(runner, branch)))
  }

  async createBranch(branch: string, startPoint?: string): Promise<void> {
    this.logAction(LOG_ACTIONS.createBranch)
    await this.runBranchMutation(() => this.requireRunnerOperation((runner) => createBranch(runner, branch, startPoint)))
  }
  async createStash(message: string, options: StashCreateOptions): Promise<void> {
    if (!this.ensureWorkingTreeMutation()) return
    // `handleStashSave`'s caller picks the label from which stash variant was invoked
    // (files_controller.go:1300 vs :1282/:1482 -> :1516). githunk has no staged-only stash, but
    // does have the untracked-files distinction lazygit labels separately here.
    this.logAction(options.includeUntracked ? LOG_ACTIONS.stashIncludeUntrackedChanges : LOG_ACTIONS.stashAllChanges)
    await this.runMutation(() => this.requireRunnerOperation((runner) => createGitStash(runner, message, options)).then(() => undefined))
  }
  async applyStash(ref: string): Promise<void> {
    if (!this.ensureStashOperation()) return
    this.logAction(LOG_ACTIONS.applyStash)
    await this.runMutation(() => this.requireRunnerOperation((runner) => applyGitStash(runner, ref)))
  }
  async popStash(ref: string): Promise<void> {
    if (!this.ensureStashOperation()) return
    this.logAction(LOG_ACTIONS.popStash)
    await this.runMutation(async () => {
      await this.requireRunnerOperation((runner) => popGitStash(runner, ref))
      if (this.currentState.reviewTarget.kind === "stash" && this.currentState.reviewTarget.ref === ref) {
        this.priorStashStateForRefresh = this.currentState
        this.currentState = { ...this.currentState, reviewTarget: { kind: "working-tree", scope: "all" }, title: titleFor({ kind: "working-tree", scope: "all" }, this.currentState.branch) }
      }
    })
  }
  async dropStash(ref: string, options: StashDropOptions): Promise<void> {
    if (!this.ensureStashOperation()) return
    this.logAction(LOG_ACTIONS.dropStash)
    await this.runMutation(async () => {
      await this.requireRunnerOperation((runner) => dropGitStash(runner, ref, options))
      if (this.currentState.reviewTarget.kind === "stash" && this.currentState.reviewTarget.ref === ref) {
        this.priorStashStateForRefresh = this.currentState
        this.currentState = { ...this.currentState, reviewTarget: { kind: "working-tree", scope: "all" }, title: titleFor({ kind: "working-tree", scope: "all" }, this.currentState.branch) }
      }
    })
  }
  async inspectStash(ref: string): Promise<void> {
    if (!this.ensureStashOperation()) return
    await this.mutationQueue.run(async () => {
      await this.refreshStashTarget(ref)
    })
  }
  async fetch(remote?: string, options: FetchOptions = {}): Promise<void> {
    if (!this.ensureWorkingTreeMutation()) return
    // The background fetch is `DontLog()` in lazygit (git_commands/sync.go:81): no command line
    // and no action label, so a 60-second timer does not bury what the user actually ran.
    if (options.background !== true) this.logAction(LOG_ACTIONS.fetch)
    await this.runMutation(() => this.requireRunnerOperation((runner) => fetchSync(runner, remote, options)))
  }
  async pull(options: PullOptions = {}): Promise<void> {
    if (!this.ensureWorkingTreeMutation()) return
    this.logAction(LOG_ACTIONS.pull)
    await this.mutationQueue.run(async () => {
      try {
        const result = await this.requireRunnerOperation((runner) => pullSync(runner, options))
        if (result.kind === "upstream-required") {
          this.currentState = { ...this.currentState, upstreamChoice: result, ...this.commandLogSnapshot() }
          return
        }
        await this.refresh()
      } catch (error) {
        const banner = error instanceof GitCommandError ? (error.record.stderr || error.message) : error instanceof Error ? error.message : String(error)
        this.currentState = { ...this.currentState, banner, ...this.commandLogSnapshot() }
        throw error
      }
    })
  }

  async chooseUpstream(remote: string, branch: string): Promise<void> {
    const choice = this.currentState.upstreamChoice
    if (choice === undefined) return
    // Setting the upstream is a distinct intent lazygit labels separately
    // (remote_branches_controller.go:187, `Actions.SetBranchUpstream`; english.go:2210) before the
    // pull/push it then performs; `pull`/`push` below add their own label, so this is deliberately
    // the only site that logs twice per keypress.
    this.logAction(LOG_ACTIONS.setBranchUpstream)
    const upstream = { remote, branch }
    if (choice.operation === "pull") {
      await this.pull({ upstream })
    } else {
      await this.push({ upstream })
    }
  }
  async push(options: PushOptions = {}): Promise<PushResult> {
    if (!this.ensureWorkingTreeMutation()) return { kind: "pushed" }
    this.logAction(LOG_ACTIONS.push)
    return this.mutationQueue.run(async () => {
      try {
        const result = await this.requireRunnerOperation((runner) => pushSync(runner, options))
        if (result.kind === "upstream-required") {
          this.currentState = { ...this.currentState, upstreamChoice: result, ...this.commandLogSnapshot() }
          return result
        }
        await this.refresh()
        return result
      } catch (error) {
        const banner = error instanceof GitCommandError ? (error.record.stderr || error.message) : error instanceof Error ? error.message : String(error)
        this.currentState = { ...this.currentState, banner, ...this.commandLogSnapshot() }
        throw error
      }
    })
  }

  async deleteBranch(branch: string, options?: DeleteBranchOptions): Promise<void> {
    this.logAction(LOG_ACTIONS.deleteLocalBranch)
    await this.runBranchMutation(() => this.requireRunnerOperation((runner) => deleteBranch(runner, branch, options)))
  }

  async renameBranch(oldName: string, newName: string): Promise<void> {
    this.logAction(LOG_ACTIONS.renameBranch)
    await this.runBranchMutation(() => this.requireRunnerOperation((runner) => renameBranch(runner, oldName, newName)))
  }

  async fetchRemote(remote: string): Promise<void> {
    this.logAction(LOG_ACTIONS.fetch)
    await this.runBranchMutation(() => this.requireRunnerOperation((runner) => fetchRemote(runner, remote)))
  }

  async browseRemote(remote: string): Promise<void> {
    await this.mutationQueue.run(async () => {
      try {
        const branches = await this.requireRunnerOperation((runner) => listRemoteBranches(runner, remote))
        const listing = this.currentState.branches
        if (listing === undefined) return
        this.currentState = {
          ...this.currentState,
          branches: {
            ...listing,
            remotes: listing.remotes.map((candidate) => candidate.name === remote ? { ...candidate, branches } : candidate),
          },
          ...this.commandLogSnapshot(),
        }
      } catch (error) {
        const banner = error instanceof GitCommandError
          ? (error.record.stderr || error.message)
          : error instanceof Error ? error.message : String(error)
        this.currentState = { ...this.currentState, banner, ...this.commandLogSnapshot() }
        throw error
      }
    })
  }
  async inspectBranch(branchRef: string): Promise<void> {
    await this.mutationQueue.run(async () => {
      const history = await this.loadCommitHistory(branchRef)
      const { banner: _previousBanner, ...previousState } = this.currentState
      this.currentState = {
        ...previousState,
        commits: history.commits,
        ...(history.warning === undefined ? {} : { banner: history.warning }),
        ...this.commandLogSnapshot(),
      }
    })
  }



  async checkoutRemoteTracking(remoteRef: string | RemoteBranchSelection, options?: CheckoutRemoteTrackingOptions): Promise<CheckoutRemoteTrackingResult | undefined> {
    this.logAction(LOG_ACTIONS.checkoutBranch)
    return this.runBranchMutation(() => this.requireRunnerOperation((runner) => typeof remoteRef === "string"
      ? checkoutRemoteTracking(runner, remoteRef, options)
      : checkoutRemoteTracking(runner, remoteRef, options)))
  }

  private async requireRunnerOperation<T>(operation: (runner: GitRunner) => Promise<T>): Promise<T> {
    if (this.runner === undefined) throw new Error("Branch operations require a GitRunner")
    return operation(this.runner)
  }

  private async runBranchMutation<T>(operation: () => Promise<T>): Promise<T | undefined> {
    return this.mutationQueue.run(async () => {
      try {
        const result = await operation()
        if (result !== undefined && result !== null && typeof result === "object" && "kind" in result && result.kind === "mismatch") {
          const mismatch = result as unknown as { readonly message: string }
          this.currentState = {
            ...this.currentState,
            banner: mismatch.message,
            ...this.commandLogSnapshot(),
          }
          return result
        }
        await this.inferBase().catch(() => undefined)
        await this.refresh()
        return result
      } catch (error) {
        const banner = error instanceof GitCommandError
          ? (error.record.stderr || error.message)
          : error instanceof Error ? error.message : String(error)
        this.currentState = {
          ...this.currentState,
          banner,
          ...this.commandLogSnapshot(),
        }
        throw error
      }
    })
  }
  async setWorkingTreeScope(scope: WorkingTreeScope): Promise<void> {
    await this.switchMode("working-tree", scope)
  }

  async switchMode(mode: "working-tree" | "branch", scope: WorkingTreeScope = "all"): Promise<void> {
    this.rememberCursor()
    if (mode === "working-tree") {
      await this.refreshTarget({ kind: "working-tree", scope })
      return
    }
    await this.openBranchReview()
  }

  async setBranchBase(baseRef: string): Promise<void> {
    const loaded = await this.refreshBranchTarget(baseRef)
    if (loaded) await this.rememberBase(baseRef)
  }

  async chooseBase(baseRef: string): Promise<void> {
    await this.setBranchBase(baseRef)
  }
  async cancelBasePicker(): Promise<void> {
    const { basePicker: _picker, ...state } = this.currentState
    this.currentState = { ...state, loading: false }
  }
  async cancelUpstreamChoice(): Promise<void> {
    const { upstreamChoice: _choice, ...state } = this.currentState
    this.currentState = state
  }

  async loadCommitInspection(oid: string): Promise<CommitDetails> {
    return this.loadCommitDetails(oid)
  }

  async loadCommitFileInspection(oid: string, path: string): Promise<DiffDocument> {
    return this.loadCommitFile(oid, path)
  }

  async loadTagInspection(tag: TagSummary): Promise<TagPreview> {
    if (this.runner === undefined) throw new Error("Tag inspection requires a GitRunner")
    return loadTagPreview(this.runner, tag)
  }

  /**
   * A ref's commit graph, still carrying git's own SGR sequences. What panel 3 renders into the
   * main pane for every selection it has, the way lazygit does
   * (branches_controller.go:207 `GetGraphCmdObj`).
   */
  async loadRefLogInspection(target: RefLogTarget): Promise<string> {
    if (this.runner === undefined) throw new Error("Ref log inspection requires a GitRunner")
    return loadRefLog(this.runner, refLogFullName(target))
  }

  recordInspectionError(error: unknown): void {
    const banner = error instanceof GitCommandError
      ? error.record.stderr || error.message
      : error instanceof Error
        ? error.message
        : String(error)
    this.currentState = {
      ...this.currentState,
      banner,
      ...this.commandLogSnapshot(),
    }
  }

  private async openBranchReview(): Promise<void> {
    let baseRef: string | undefined
    let stalePersistedBase = false
    let storeWarning: string | undefined
    const branchKey = this.runner === undefined ? this.currentState.branch : await currentBranchRef(this.runner)
    if (branchKey !== undefined && this.reviewStore !== undefined) {
      try {
        this.reviewDatabase = await this.reviewStore.load()
        storeWarning = this.reviewStore.warning
        const persisted = ownValue(this.reviewDatabase.baseByBranch, branchKey)?.ref
        if (persisted !== undefined) {
          if (this.runner !== undefined && await resolveRefOid(this.runner, persisted) !== undefined) baseRef = persisted
          else stalePersistedBase = true
        }
      } catch (error) {
        storeWarning = error instanceof Error ? error.message : String(error)
        baseRef = undefined
      }
    }
    this.pendingBranchWarning = storeWarning
    if (baseRef === undefined) {
      const inferred = await this.inferBase()
      if (inferred.kind === "choose" || stalePersistedBase) {
        const picker = inferred.kind === "choose"
          ? inferred
          : {
              kind: "choose" as const,
              candidates: this.runner === undefined ? [] : await reviewBaseCandidates(this.runner),
              reason: "persisted base ref no longer resolves",
            }
        this.currentState = {
          ...this.currentState,
          basePicker: picker,
          loading: false,
          ...(storeWarning === undefined ? {} : { banner: storeWarning }),
          ...this.commandLogSnapshot(),
        }
        return
      }
      baseRef = inferred.ref
    }
    const loaded = await this.refreshBranchTarget(baseRef)
    if (loaded) await this.rememberBase(baseRef, branchKey)
  }

  private async rememberBase(baseRef: string, branchKey?: string): Promise<void> {
    if (this.reviewStore === undefined) return
    const key = branchKey ?? (this.runner === undefined ? this.currentState.branch : await currentBranchRef(this.runner))
    if (key === undefined) return
    this.reviewDatabase = {
      ...this.reviewDatabase,
      baseByBranch: { ...this.reviewDatabase.baseByBranch, [key]: { ref: baseRef } },
    }
    await this.reviewStore.save(this.reviewDatabase)
  }

  private rememberCursor(): void {
    const cursor = {
      ...(this.currentState.selectionId === undefined ? {} : { selectionId: this.currentState.selectionId }),
      ...(this.currentState.focusId === undefined ? {} : { focusId: this.currentState.focusId }),
    }
    if (this.currentState.reviewTarget.kind === "branch") this.branchCursor = cursor
    else this.workingTreeCursor = cursor
  }

  selectFile(path: string): void {
    const status = ownValue(this.currentState.reviewStatuses, path)
    if (status === undefined || status === "not-reviewed" || status === "reviewing") {
      this.currentState = {
        ...this.currentState,
        selectionId: path,
        focusId: path,
        reviewStatuses: { ...(this.currentState.reviewStatuses ?? {}), [path]: "reviewing" },
      }
    } else {
      this.currentState = { ...this.currentState, selectionId: path, focusId: path }
    }
  }

  async markFocusedFileReviewed(path?: string): Promise<void> {
    const requestedPath = path ?? this.currentState.focusId ?? this.currentState.selectionId
    const resolvedPath = requestedPath !== undefined && this.currentState.files.some((file) => file.path === requestedPath)
      ? requestedPath
      : this.currentState.files[0]?.path
    if (resolvedPath === undefined) return
    await this.markFileReviewed(resolvedPath)
  }

  async markFileReviewed(path: string): Promise<void> {
    if (this.currentState.reviewTarget.kind === "commit") {
      this.currentState = { ...this.currentState, banner: "Commit drill-down is read-only" }
      return
    }
    const file = this.currentState.files.find((candidate) => candidate.path === path)
    if (file === undefined) return
    const fingerprint = fingerprintFile(this.currentState.reviewTarget, {
      currentPath: file.path,
      previousPath: file.previousPath,
      rawPatch: rawPatchForFile(file, indexPatchSections(this.currentState.rawPatchSections)),
    })
    const key = targetKey(this.currentState.reviewTarget)
    const targetRecord = ownValue(this.reviewDatabase.targets, key) ?? { files: {} }
    const database: ReviewDatabase = {
      ...this.reviewDatabase,
      targets: {
        ...this.reviewDatabase.targets,
        [key]: {
          files: {
            ...targetRecord.files,
            [file.path]: { reviewedFingerprint: fingerprint, reviewedAt: new Date().toISOString() },
          },
        },
      },
    }
    this.reviewDatabase = database
    await this.reviewStore?.save(database)
    const reviewStatuses = { ...(this.currentState.reviewStatuses ?? {}), [path]: "reviewed" as const }
    this.currentState = {
      ...this.currentState,
      reviewStatuses,
      reviewSummary: this.reviewSummaryFor(reviewStatuses, this.currentState.files, this.currentState.reviewSummary?.commits ?? 0),
    }
  }
  async commit(message: string): Promise<void> {
    if (!this.ensureWorkingTreeMutation()) return
    this.logAction(LOG_ACTIONS.commit)
    await this.runMutation(() => this.commitMutations?.commit(message))
  }

  async amend(message: string): Promise<void> {
    if (!this.ensureWorkingTreeMutation()) return
    this.logAction(LOG_ACTIONS.amendCommit)
    await this.runMutation(() => this.commitMutations?.amend(message))
  }

  async currentCommitMessage(): Promise<string> {
    if (this.commitMutations === undefined) throw new Error("Commit mutations require a GitRunner")
    return this.commitMutations.currentMessage()
  }

  async amendMessage(): Promise<string> {
    return this.currentCommitMessage()
  }
  async stageFile(path: string): Promise<void> {
    if (!this.ensureWorkingTreeMutation()) return
    this.logAction(LOG_ACTIONS.stageFile)
    await this.runMutation(() => this.mutations?.stageFile(path))
  }

  async unstageFile(path: string): Promise<void> {
    if (!this.ensureWorkingTreeMutation()) return
    this.logAction(LOG_ACTIONS.unstageFile)
    await this.runMutation(() => this.mutations?.unstageFile(path))
  }

  async applySelection(document: DiffDocument, includedLineIndexes: readonly number[], options: SelectionMutationOptions): Promise<void> {
    if (!this.ensureWorkingTreeMutation()) return
    this.logAction(LOG_ACTIONS.applyPatch)
    await this.runMutation(() => this.mutations?.applySelection(document, includedLineIndexes, options))
  }

  async discardSelection(document: DiffDocument, includedLineIndexes: readonly number[], options?: Omit<SelectionMutationOptions, "reverse"> & { readonly reverse?: false }): Promise<void> {
    if (!this.ensureWorkingTreeMutation()) return
    this.logAction(LOG_ACTIONS.applyPatch)
    await this.runMutation(() => this.mutations?.discardSelection(document, includedLineIndexes, options))
  }

  async discardFile(path: string, untracked = false): Promise<void> {
    if (!this.ensureWorkingTreeMutation()) return
    this.logAction(LOG_ACTIONS.discardAllChangesInFile)
    await this.runMutation(() => this.mutations?.discardFile(path, untracked))
  }


  async toggleAllFiles(): Promise<void> {
    if (!this.ensureWorkingTreeMutation()) return
    await this.mutationQueue.run(async () => {
      const files = this.currentState.files
      const shouldStage = files.some((file) => file.untracked || file.worktreeStatus !== ".")
      this.logAction(shouldStage ? LOG_ACTIONS.stageAllFiles : LOG_ACTIONS.unstageAllFiles)
      try {
        for (const file of files) {
          if (shouldStage) await this.mutations?.stageFile(file.path)
          else await this.mutations?.unstageFile(file.path)
          await this.refresh()
          if (this.currentState.banner !== undefined) throw new Error(this.currentState.banner)
        }
      } catch (error) {
        const banner = error instanceof GitCommandError
          ? (error.record.stderr || error.message)
          : error instanceof Error ? error.message : String(error)
        this.currentState = {
          ...this.currentState,
          banner,
          ...this.commandLogSnapshot(),
        }
        throw error
      }
    })
  }
  private ensureWorkingTreeMutation(): boolean {
    if (this.currentState.reviewTarget.kind === "working-tree") return true
    const message = this.currentState.reviewTarget.kind === "stash" ? "Stash Review is read-only" : "Branch Review is read-only"
    this.currentState = { ...this.currentState, banner: message }
    return false
  }
  private ensureStashOperation(): boolean {
    if (this.currentState.reviewTarget.kind === "working-tree" || this.currentState.reviewTarget.kind === "stash") return true
    this.currentState = { ...this.currentState, banner: "Branch Review is read-only" }
    return false
  }

  /**
   * lazygit's `LogAction`, called from its UI controllers — the layer where one user intent
   * becomes N git commands (pkg/gui/controllers/files_controller.go:544,559;
   * pkg/gui/controllers/stash_controller.go:127,141,169;
   * pkg/gui/controllers/sync_controller.go:167,197). This controller is githunk's equivalent: its
   * mutation methods map one-to-one onto user intents, where `root-view.ts` corresponds to
   * lazygit's keybinding table and views.
   *
   * Always after the guard, so a mutation the target refuses logs nothing.
   */
  private logAction(action: string): void {
    this.runner?.log.logAction(action)
  }

  private async runMutation(operation: () => Promise<void> | undefined): Promise<void> {
    if (operation === undefined) throw new Error("Mutations require a GitRunner")
    await this.mutationQueue.run(async () => {
      try {
        await operation()
        await this.refresh()
      } catch (error) {
        const banner = error instanceof GitCommandError
          ? (error.record.stderr || error.message)
          : error instanceof Error ? error.message : String(error)
        this.currentState = {
          ...this.currentState,
          banner,
          ...this.commandLogSnapshot(),
        }
        throw error
      }
    })
  }

  private reviewSummaryFor(statuses: Readonly<Record<string, ReviewFileState>>, files: readonly ChangedFile[], commits = 0): {
    readonly reviewed: number
    readonly invalidated: number
    readonly commits: number
    readonly files: number
    readonly additions: number
    readonly deletions: number
  } {
    return {
      reviewed: Object.values(statuses).filter((status) => status === "reviewed").length,
      invalidated: Object.values(statuses).filter((status) => status === "changed-after-review").length,
      commits,
      files: files.length,
      additions: files.reduce((total, file) => total + file.additions, 0),
      deletions: files.reduce((total, file) => total + file.deletions, 0),
    }
  }

  private async reviewForSnapshot(target: ReviewTarget, files: readonly ChangedFile[], patches: readonly PatchSection[]): Promise<{
    readonly statuses: Readonly<Record<string, ReviewFileState>>
    readonly summary: { readonly reviewed: number; readonly invalidated: number; readonly commits: number; readonly files: number; readonly additions: number; readonly deletions: number }
    readonly warning?: string
  }> {
    let warning: string | undefined
    if (this.reviewStore !== undefined) {
      try {
        this.reviewDatabase = await this.reviewStore.load()
        warning = this.reviewStore.warning
      } catch (error) {
        warning = error instanceof Error ? error.message : String(error)
      }
    }
    const record = ownValue(this.reviewDatabase.targets, targetKey(target))
    const statuses: Record<string, ReviewFileState> = Object.create(null) as Record<string, ReviewFileState>
    const sections = indexPatchSections(patches)
    for (const file of files) {
      const fingerprint = fingerprintFile(target, {
        currentPath: file.path,
        previousPath: file.previousPath,
        rawPatch: rawPatchForFile(file, sections),
      })
      statuses[file.path] = reviewStateFor(ownValue(record?.files, file.path), fingerprint)
    }
    return {
      statuses,
      summary: this.reviewSummaryFor(statuses, files),
      ...(warning === undefined ? {} : { warning }),
    }
  }
  private async loadCommitHistory(range: string): Promise<{ readonly commits: readonly CommitSummary[]; readonly warning?: string }> {
    try {
      return { commits: await this.loadCommitList(range) }
    } catch (error) {
      const warning = error instanceof GitCommandError
        ? (error.record.stderr || error.message)
        : error instanceof Error ? error.message : String(error)
      return { commits: this.currentState.commits ?? [], warning }
    }
  }
  private async refreshTarget(
    target: Extract<ReviewTarget, { readonly kind: "working-tree" }>,
    options: { readonly background?: boolean } = {},
  ): Promise<void> {
    const previousState = this.priorStashStateForRefresh ?? this.currentState
    const generation = ++this.generation
    this.publishIfCurrent(generation, { loading: true })
    try {
      const snapshot = await this.loadSnapshot(target, options)
      if (generation !== this.generation) return
      const review = await this.reviewForSnapshot(snapshot.reviewTarget, snapshot.files, snapshot.patches)
      if (generation !== this.generation) return
      const history = await this.loadCommitHistory("HEAD")
      if (generation !== this.generation) return
      const cursor = this.currentState.reviewTarget.kind === "working-tree"
        ? { selectionId: this.currentState.selectionId, focusId: this.currentState.focusId }
        : this.workingTreeCursor
      const selectionId = cursor.selectionId !== undefined && snapshot.files.some((file) => file.path === cursor.selectionId) ? cursor.selectionId : undefined
      const focusId = cursor.focusId !== undefined && snapshot.files.some((file) => file.path === cursor.focusId) ? cursor.focusId : undefined
      const warning = history.warning ?? review.warning
      const {
        upstream: _previousUpstream,
        upstreamChoice: _previousUpstreamChoice,
        banner: _previousBanner,
        basePicker: _previousPicker,
        selectionId: _previousSelectionId,
        focusId: _previousFocusId,
        branchReviewTarget: _previousBranchReviewTarget,
        ...previousState
      } = this.currentState
      this.currentState = {
        ...previousState,
        ...(snapshot.upstream === undefined ? {} : { upstream: snapshot.upstream }),
        ...(warning === undefined ? {} : { banner: warning }),
        ...(focusId === undefined ? {} : { focusId }),
        repositoryRoot: snapshot.repositoryRoot,
        branch: snapshot.branch,
        reviewTarget: snapshot.reviewTarget,
        files: snapshot.files,
        patches: snapshot.patches,
        rawPatchSections: snapshot.patches,
        reviewStatuses: review.statuses,
        reviewSummary: review.summary,
        commits: history.commits,
        loading: false,
        ...this.commandLogSnapshot(),
        title: titleFor(snapshot.reviewTarget, snapshot.branch),
      }
      this.priorStashStateForRefresh = undefined
    } catch (error) {
      if (generation !== this.generation) return
      const banner = error instanceof GitCommandError
        ? (error.record.stderr || error.message)
        : error instanceof Error ? error.message : String(error)
      this.currentState = {
        ...previousState,
        banner,
        ...this.commandLogSnapshot(),
      }
      this.priorStashStateForRefresh = undefined
    }
  }

  private async refreshStashTarget(ref: string): Promise<void> {
    try {
      const loaded = await this.requireRunnerOperation((runner) => loadStash(runner, ref))
      const patch: PatchSection = { label: "BRANCH", text: loaded.patch }
      const document = parseDiff(loaded.patch)
      const files = changedFilesFromDocument(document)
      const target: ReviewTarget = { kind: "stash", ref: loaded.stash.oid }
      const review = await this.reviewForSnapshot(target, files, [patch])
      const {
        banner: _previousBanner,
        branchReviewTarget: _previousBranchReviewTarget,
        ...previousState
      } = this.currentState
      this.currentState = {
        ...previousState,
        reviewTarget: target,
        files,
        patches: [patch],
        rawPatchSections: [patch],
        reviewStatuses: review.statuses,
        reviewSummary: review.summary,
        loading: false,
        title: titleFor(target, this.currentState.branch),
        ...this.commandLogSnapshot(),
        ...(review.warning === undefined ? {} : { banner: review.warning }),
      }
    } catch (error) {
      const banner = error instanceof GitCommandError ? (error.record.stderr || error.message) : error instanceof Error ? error.message : String(error)
      this.currentState = { ...this.currentState, banner, ...this.commandLogSnapshot() }
    }
  }
  private async refreshBranchTarget(baseRef: string): Promise<boolean> {
    const generation = ++this.generation
    this.publishIfCurrent(generation, { loading: true })
    try {
      const snapshot = await this.loadBranchSnapshot(baseRef)
      if (generation !== this.generation) return false
      const review = await this.reviewForSnapshot(snapshot.reviewTarget, snapshot.files, snapshot.patches)
      if (generation !== this.generation) return false
      const history = await this.loadCommitHistory(`${snapshot.baseRef}..HEAD`)
      if (generation !== this.generation) return false
      const cursor = this.currentState.reviewTarget.kind === "branch"
        ? { selectionId: this.currentState.selectionId, focusId: this.currentState.focusId }
        : this.branchCursor
      const selectionId = cursor.selectionId !== undefined && snapshot.files.some((file) => file.path === cursor.selectionId) ? cursor.selectionId : undefined
      const focusId = cursor.focusId !== undefined && snapshot.files.some((file) => file.path === cursor.focusId) ? cursor.focusId : undefined
      const branchWarning = history.warning ?? review.warning ?? this.pendingBranchWarning
      this.pendingBranchWarning = undefined
      const {
        upstream: _previousUpstream,
        upstreamChoice: _previousUpstreamChoice,
        banner: _previousBanner,
        basePicker: _previousPicker,
        selectionId: _previousSelectionId,
        focusId: _previousFocusId,
        ...previousState
      } = this.currentState
      this.currentState = {
        ...previousState,
        ...(branchWarning === undefined ? {} : { banner: branchWarning }),
        branch: snapshot.branch,
        reviewTarget: snapshot.reviewTarget,
        branchReviewTarget: snapshot.reviewTarget,
        files: snapshot.files,
        patches: snapshot.patches,
        rawPatchSections: snapshot.patches,
        reviewStatuses: review.statuses,
        reviewSummary: this.reviewSummaryFor(review.statuses, snapshot.files, snapshot.commitCount),
        commits: history.commits,
        loading: false,
        ...this.commandLogSnapshot(),
        title: titleFor(snapshot.reviewTarget, snapshot.branch),
        ...(selectionId === undefined ? {} : { selectionId }),
        ...(focusId === undefined ? {} : { focusId }),
      }
      return true
    } catch (error) {
      if (generation !== this.generation) return false
      const banner = error instanceof GitCommandError
        ? (error.record.stderr || error.message)
        : error instanceof Error ? error.message : String(error)
      this.currentState = {
        ...this.currentState,
        loading: false,
        banner,
        ...this.commandLogSnapshot(),
      }
      return false
    }
  }

  private publishIfCurrent(generation: number, update: Pick<AppModel, "loading">): void {
    if (generation === this.generation) this.currentState = { ...this.currentState, ...update }
  }
}
