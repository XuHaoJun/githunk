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
import { checkoutRemoteTracking, createBranch, deleteBranch, fetchRemote, listBranches, listRemoteBranches, renameBranch, switchLocal, type CheckoutRemoteTrackingOptions, type CheckoutRemoteTrackingResult, type DeleteBranchOptions, type RemoteBranchSelection } from "../git/branches"
import { MutationQueue } from "./mutation-queue"
export type WorkingTreeLoader = (target: Extract<ReviewTarget, { readonly kind: "working-tree" }>) => Promise<WorkingTreeSnapshot>
export type BranchReviewLoader = (baseRef: string) => Promise<BranchReviewSnapshot>
export type BranchListingLoader = () => Promise<BranchListing>
export type CommitListLoader = (range: string, filter?: string) => Promise<readonly CommitSummary[]>
export type CommitLoader = (oid: string) => Promise<CommitDetails>
export type CommitFilePatchLoader = (oid: string, path: string) => Promise<DiffDocument>
export type BaseInferenceLoader = () => Promise<BaseInference>

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
  readonly mutations?: GitMutations
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
function rawPatchForFile(file: ChangedFile, patches: readonly PatchSection[]): string {
  let result = ""
  for (const section of patches) {
    const document = parseDiff(section.text)
    for (const parsed of document.files) {
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
    const path = file.newPath ?? file.oldPath
    if (path === undefined || path === "/dev/null") return []
    const additions = file.lines.filter((line) => line.kind === "addition").length
    const deletions = file.lines.filter((line) => line.kind === "deletion").length
    return [{
      path,
      ...(file.oldPath !== undefined && file.newPath !== undefined && file.oldPath !== file.newPath ? { previousPath: file.oldPath } : {}),
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
  readonly runner: GitRunner | undefined
  readonly mutations: GitMutations | undefined
  readonly reviewStore: ReviewStore | undefined
  readonly mutationQueue = new MutationQueue()
  private readonly loadSnapshot: WorkingTreeLoader
  private readonly loadBranchSnapshot: BranchReviewLoader
  private readonly loadBranchesListing: BranchListingLoader
  private readonly automaticBranchListing: boolean
  private readonly loadCommitList: CommitListLoader
  private readonly loadCommitDetails: CommitLoader
  private readonly loadCommitFile: CommitFilePatchLoader
  private readonly inferBase: BaseInferenceLoader
  private readonly automaticCommitHistory: boolean
  private generation = 0
  private currentState: AppModel
  private reviewDatabase: ReviewDatabase = emptyReviewDatabase()
  private workingTreeCursor: { readonly selectionId?: string; readonly focusId?: string } = {}
  private branchCursor: { readonly selectionId?: string; readonly focusId?: string } = {}
  private pendingBranchWarning: string | undefined
  private commitOriginTarget: { readonly kind: "branch"; readonly baseRef: string } | { readonly kind: "working-tree"; readonly scope: WorkingTreeScope } | undefined

  constructor(options: AppControllerOptions | GitRunner, loader?: WorkingTreeLoader) {
    const runner = options instanceof GitRunner ? options : options.runner
    const load = options instanceof GitRunner ? loader : options.load ?? options.loader
    const repositoryRoot = options instanceof GitRunner ? options.cwd : options.repositoryRoot ?? runner?.cwd
    this.automaticCommitHistory = options instanceof GitRunner || options.loadCommits !== undefined || options.commitsLoader !== undefined
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
    this.loadSnapshot = load ?? ((target) => {
      if (runner === undefined) throw new Error("AppController requires a GitRunner or loader")
      return loadWorkingTree(runner, target.scope)
    })
    this.loadBranchSnapshot = options instanceof GitRunner
      ? (baseRef) => loadBranchReview(options, baseRef)
      : options.loadBranch ?? options.branchLoader ?? (runner === undefined ? async () => { throw new Error("Branch review requires a GitRunner") } : (baseRef) => loadBranchReview(runner, baseRef))
    this.automaticBranchListing = options instanceof GitRunner || (options.loadBranches !== undefined || options.branchesLoader !== undefined) || (options.load === undefined && options.loader === undefined && runner !== undefined)
    this.loadBranchesListing = options instanceof GitRunner
      ? () => listBranches(options)
      : options.loadBranches ?? options.branchesLoader ?? (load === undefined && runner !== undefined ? () => listBranches(runner) : async () => ({ detached: true, localBranches: [], remotes: [] }))
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
      commandLog: runner?.log.records() ?? [],
      title: titleFor(target),
      commits: [],
    }
  }
  get state(): AppModel {
    return this.currentState
  }

  async refresh(): Promise<void> {
    const branchWarning = this.automaticBranchListing ? await this.refreshBranches() : undefined
    const target = this.currentState.reviewTarget
    if (target.kind === "working-tree") {
      await this.refreshTarget(target)
    } else if (target.kind === "branch") {
      await this.openBranchReview()
    }
    if (branchWarning !== undefined) {
      this.currentState = {
        ...this.currentState,
        banner: branchWarning,
        commandLog: this.runner?.log.records() ?? this.currentState.commandLog,
      }
    }
  }

  async refreshBranches(): Promise<string | undefined> {
    try {
      const branches = await this.loadBranchesListing()
      this.currentState = {
        ...this.currentState,
        branches,
        commandLog: this.runner?.log.records() ?? this.currentState.commandLog,
      }
      return undefined
    } catch (error) {
      const banner = error instanceof GitCommandError
        ? (error.record.stderr || error.message)
        : error instanceof Error ? error.message : String(error)
      this.currentState = {
        ...this.currentState,
        banner,
        commandLog: this.runner?.log.records() ?? this.currentState.commandLog,
      }
      return banner
    }
  }
  async switchLocal(branch: string): Promise<void> {
    await this.switchLocalBranch(branch)
  }
  async switchLocalBranch(branch: string): Promise<void> {
    await this.runBranchMutation(() => this.requireRunnerOperation((runner) => switchLocal(runner, branch)))
  }

  async createBranch(branch: string, startPoint?: string): Promise<void> {
    await this.runBranchMutation(() => this.requireRunnerOperation((runner) => createBranch(runner, branch, startPoint)))
  }

  async deleteBranch(branch: string, options?: DeleteBranchOptions): Promise<void> {
    await this.runBranchMutation(() => this.requireRunnerOperation((runner) => deleteBranch(runner, branch, options)))
  }

  async renameBranch(oldName: string, newName: string): Promise<void> {
    await this.runBranchMutation(() => this.requireRunnerOperation((runner) => renameBranch(runner, oldName, newName)))
  }

  async fetchRemote(remote: string): Promise<void> {
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
          commandLog: this.runner?.log.records() ?? this.currentState.commandLog,
        }
      } catch (error) {
        const banner = error instanceof GitCommandError
          ? (error.record.stderr || error.message)
          : error instanceof Error ? error.message : String(error)
        this.currentState = { ...this.currentState, banner, commandLog: this.runner?.log.records() ?? this.currentState.commandLog }
        throw error
      }
    })
  }
  async inspectBranch(branchRef: string): Promise<void> {
    await this.mutationQueue.run(async () => {
      const history = await this.loadCommitHistory(branchRef)
      this.commitOriginTarget = { kind: "branch", baseRef: branchRef }
      const { banner: _previousBanner, ...previousState } = this.currentState
      this.currentState = {
        ...previousState,
        commits: history.commits,
        ...(history.warning === undefined ? {} : { banner: history.warning }),
        commandLog: this.runner?.log.records() ?? this.currentState.commandLog,
      }
    })
  }



  async checkoutRemoteTracking(remoteRef: string | RemoteBranchSelection, options?: CheckoutRemoteTrackingOptions): Promise<CheckoutRemoteTrackingResult | undefined> {
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
            commandLog: this.runner?.log.records() ?? this.currentState.commandLog,
          }
          return result
        }
        const wasCommit = this.currentState.reviewTarget.kind === "commit"
        const origin = wasCommit ? this.commitOriginTarget : undefined
        if (wasCommit) {
          this.commitOriginTarget = undefined
          const {
            banner: _previousBanner,
            basePicker: _previousPicker,
            commitDetails: _previousCommitDetails,
            commitFilePath: _previousCommitFilePath,
            branchReviewTarget: _previousBranchReviewTarget,
            selectionId: _previousSelectionId,
            focusId: _previousFocusId,
            ...previousState
          } = this.currentState
          const target: Extract<ReviewTarget, { readonly kind: "working-tree" }> = {
            kind: "working-tree",
            scope: origin?.kind === "working-tree" ? origin.scope : "all",
          }
          this.currentState = {
            ...previousState,
            reviewTarget: target,
            title: titleFor(target, this.currentState.branch),
            files: [],
            patches: [],
            rawPatchSections: [],
            commits: [],
            loading: false,
          }
          const branchWarning = await this.refreshBranches()
          const inferred = await this.inferBase().catch(() => undefined)
          if (origin?.kind === "branch" && inferred?.kind === "choose") {
            await this.refreshTarget(target)
            this.currentState = { ...this.currentState, basePicker: inferred, loading: false }
          } else if (origin?.kind === "branch" && inferred?.kind === "confident") {
            const loaded = await this.refreshBranchTarget(inferred.ref)
            if (loaded) await this.rememberBase(inferred.ref)
          } else if (origin?.kind === "branch") {
            await this.openBranchReview()
          } else {
            await this.refreshTarget(target)
          }
          if (branchWarning !== undefined) {
            this.currentState = { ...this.currentState, banner: branchWarning }
          }
          return result
        }
        this.commitOriginTarget = undefined
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
          commandLog: this.runner?.log.records() ?? this.currentState.commandLog,
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

  async selectCommit(oid: string): Promise<void> {
    this.rememberCursor()
    let details: CommitDetails
    try {
      details = await this.loadCommitDetails(oid)
    } catch (error) {
      this.currentState = { ...this.currentState, banner: error instanceof GitCommandError ? (error.record.stderr || error.message) : error instanceof Error ? error.message : String(error), commandLog: this.runner?.log.records() ?? this.currentState.commandLog }
      return
    }
    if (this.commitOriginTarget === undefined) {
      const origin = this.currentState.branchReviewTarget ?? this.currentState.reviewTarget
      this.commitOriginTarget = origin.kind === "branch"
        ? { kind: "branch", baseRef: origin.baseRef }
        : origin.kind === "working-tree"
          ? { kind: "working-tree", scope: origin.scope }
          : undefined
    }
    const files = changedFilesFromDocument(details.document)
    const patch = { label: "BRANCH" as const, text: details.document.text }
    const { banner: _previousBanner, commitFilePath: _previousCommitFilePath, ...previousState } = this.currentState
    this.currentState = {
      ...previousState,
      reviewTarget: { kind: "commit", oid },
      commitDetails: details,
      files,
      patches: [patch],
      rawPatchSections: [patch],
      ...(files[0] === undefined ? {} : { selectionId: files[0].path, focusId: files[0].path }),
      title: titleFor({ kind: "commit", oid }, this.currentState.branch),
      loading: false,
      commandLog: this.runner?.log.records() ?? this.currentState.commandLog,
    }
  }

  async selectCommitFile(path: string): Promise<void> {
    const details = this.currentState.commitDetails
    if (this.currentState.reviewTarget.kind !== "commit" || details === undefined) return
    let document: DiffDocument
    try {
      document = await this.loadCommitFile(this.currentState.reviewTarget.oid, path)
    } catch (error) {
      this.currentState = { ...this.currentState, banner: error instanceof GitCommandError ? (error.record.stderr || error.message) : error instanceof Error ? error.message : String(error), commandLog: this.runner?.log.records() ?? this.currentState.commandLog }
      return
    }
    const files = changedFilesFromDocument(document)
    const patch = { label: "BRANCH" as const, text: document.text }
    this.currentState = {
      ...this.currentState,
      commitFilePath: path,
      files: files.length > 0 ? files : this.currentState.files.filter((file) => file.path === path),
      patches: [patch],
      rawPatchSections: [patch],
      selectionId: path,
      focusId: path,
      loading: false,
      commandLog: this.runner?.log.records() ?? this.currentState.commandLog,
    }
  }

  async navigateBack(): Promise<void> {
    if (this.currentState.reviewTarget.kind !== "commit") return
    if (this.currentState.commitFilePath !== undefined) {
      const details = this.currentState.commitDetails
      if (details === undefined) return
      const patch = { label: "BRANCH" as const, text: details.document.text }
      const files = changedFilesFromDocument(details.document)
      const { commitFilePath: _previousCommitFilePath, ...previousState } = this.currentState
      this.currentState = {
        ...previousState,
        files,
        patches: [patch],
        rawPatchSections: [patch],
        ...(files[0] === undefined ? {} : { selectionId: files[0].path, focusId: files[0].path }),
      }
      return
    }
    const target = this.commitOriginTarget
    this.commitOriginTarget = undefined
    if (target?.kind === "branch") {
      await this.refreshBranchTarget(target.baseRef)
      return
    }
    if (target?.kind === "working-tree") {
      await this.refreshTarget({ kind: "working-tree", scope: target.scope })
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
          commandLog: this.runner?.log.records() ?? this.currentState.commandLog,
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
      rawPatch: rawPatchForFile(file, this.currentState.rawPatchSections),
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
  async stageFile(path: string): Promise<void> {
    if (!this.ensureWorkingTreeMutation()) return
    await this.runMutation(() => this.mutations?.stageFile(path))
  }

  async unstageFile(path: string): Promise<void> {
    if (!this.ensureWorkingTreeMutation()) return
    await this.runMutation(() => this.mutations?.unstageFile(path))
  }

  async applySelection(document: DiffDocument, includedLineIndexes: readonly number[], options: SelectionMutationOptions): Promise<void> {
    if (!this.ensureWorkingTreeMutation()) return
    await this.runMutation(() => this.mutations?.applySelection(document, includedLineIndexes, options))
  }

  async discardSelection(document: DiffDocument, includedLineIndexes: readonly number[], options?: Omit<SelectionMutationOptions, "reverse"> & { readonly reverse?: false }): Promise<void> {
    if (!this.ensureWorkingTreeMutation()) return
    await this.runMutation(() => this.mutations?.discardSelection(document, includedLineIndexes, options))
  }

  async discardFile(path: string, untracked = false): Promise<void> {
    if (!this.ensureWorkingTreeMutation()) return
    await this.runMutation(() => this.mutations?.discardFile(path, untracked))
  }


  async toggleAllFiles(): Promise<void> {
    if (!this.ensureWorkingTreeMutation()) return
    await this.mutationQueue.run(async () => {
      const files = this.currentState.files
      const shouldStage = files.some((file) => file.untracked || file.worktreeStatus !== ".")
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
          commandLog: this.runner?.log.records() ?? this.currentState.commandLog,
        }
        throw error
      }
    })
  }
  private ensureWorkingTreeMutation(): boolean {
    if (this.currentState.reviewTarget.kind === "working-tree") return true
    this.currentState = { ...this.currentState, banner: "Branch Review is read-only" }
    return false
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
          commandLog: this.runner?.log.records() ?? this.currentState.commandLog,
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
    for (const file of files) {
      const fingerprint = fingerprintFile(target, {
        currentPath: file.path,
        previousPath: file.previousPath,
        rawPatch: rawPatchForFile(file, patches),
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
    if (!this.automaticCommitHistory) return { commits: [] }
    try {
      return { commits: await this.loadCommitList(range) }
    } catch (error) {
      const warning = error instanceof GitCommandError
        ? (error.record.stderr || error.message)
        : error instanceof Error ? error.message : String(error)
      return { commits: this.currentState.commits ?? [], warning }
    }
  }
  private async refreshTarget(target: Extract<ReviewTarget, { readonly kind: "working-tree" }>): Promise<void> {
    const generation = ++this.generation
    this.publishIfCurrent(generation, { loading: true })
    try {
      const snapshot = await this.loadSnapshot(target)
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
      const {
        upstream: _previousUpstream,
        banner: _previousBanner,
        basePicker: _previousPicker,
        selectionId: _previousSelectionId,
        focusId: _previousFocusId,
        commitDetails: _previousCommitDetails,
        commitFilePath: _previousCommitFilePath,
        branchReviewTarget: _previousBranchReviewTarget,
        ...previousState
      } = this.currentState
      this.currentState = {
        ...previousState,
        ...(snapshot.upstream === undefined ? {} : { upstream: snapshot.upstream }),
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
        commandLog: this.runner?.log.records() ?? this.currentState.commandLog,
        title: titleFor(snapshot.reviewTarget, snapshot.branch),
      }
      this.commitOriginTarget = undefined
    } catch (error) {
      if (generation !== this.generation) return
      const banner = error instanceof GitCommandError
        ? (error.record.stderr || error.message)
        : error instanceof Error ? error.message : String(error)
      this.currentState = {
        ...this.currentState,
        loading: false,
        banner,
        commandLog: this.runner?.log.records() ?? this.currentState.commandLog,
      }
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
        banner: _previousBanner,
        basePicker: _previousPicker,
        selectionId: _previousSelectionId,
        focusId: _previousFocusId,
        commitDetails: _previousCommitDetails,
        commitFilePath: _previousCommitFilePath,
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
        commandLog: this.runner?.log.records() ?? this.currentState.commandLog,
        title: titleFor(snapshot.reviewTarget, snapshot.branch),
        ...(selectionId === undefined ? {} : { selectionId }),
        ...(focusId === undefined ? {} : { focusId }),
      }
      this.commitOriginTarget = undefined
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
        commandLog: this.runner?.log.records() ?? this.currentState.commandLog,
      }
      return false
    }
  }

  private publishIfCurrent(generation: number, update: Pick<AppModel, "loading">): void {
    if (generation === this.generation) this.currentState = { ...this.currentState, ...update }
  }
}
