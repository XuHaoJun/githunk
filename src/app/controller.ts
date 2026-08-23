import { GitRunner, GitCommandError } from "../git/runner"
import { loadWorkingTree } from "../git/diff"
import { loadBranchReview, type BranchReviewSnapshot } from "../git/branch-review"
import { inferReviewBase, currentBranchRef, resolveRefOid, reviewBaseCandidates, type BaseInference } from "../git/base-inference"
import { parseDiff } from "../domain/diff/parse"
import type { DiffDocument } from "../domain/diff/document"
import type { AppModel, PatchSection } from "../domain/repository"
import type { ReviewTarget, WorkingTreeScope, ChangedFile } from "../domain/review-target"
import type { WorkingTreeSnapshot } from "../domain/repository"
import { reviewStateFor, type ReviewDatabase, type ReviewFileState } from "../domain/review-progress"
import { fingerprintFile, targetKey } from "../review/fingerprint"
import { emptyReviewDatabase, ReviewStore } from "../review/store"
import { GitMutations, type SelectionMutationOptions } from "../git/mutations"
import { MutationQueue } from "./mutation-queue"

export type WorkingTreeLoader = (target: Extract<ReviewTarget, { readonly kind: "working-tree" }>) => Promise<WorkingTreeSnapshot>
export type BranchReviewLoader = (baseRef: string) => Promise<BranchReviewSnapshot>
export type BaseInferenceLoader = () => Promise<BaseInference>

export type AppControllerOptions = {
  readonly repositoryRoot?: string
  readonly runner?: GitRunner
  readonly load?: WorkingTreeLoader
  readonly loader?: WorkingTreeLoader
  readonly loadBranch?: BranchReviewLoader
  readonly branchLoader?: BranchReviewLoader
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

export class AppController {
  readonly runner: GitRunner | undefined
  readonly mutations: GitMutations | undefined
  readonly reviewStore: ReviewStore | undefined
  readonly mutationQueue = new MutationQueue()
  private readonly loadSnapshot: WorkingTreeLoader
  private readonly loadBranchSnapshot: BranchReviewLoader
  private readonly inferBase: BaseInferenceLoader
  private generation = 0
  private currentState: AppModel
  private reviewDatabase: ReviewDatabase = emptyReviewDatabase()
  private workingTreeCursor: { readonly selectionId?: string; readonly focusId?: string } = {}
  private branchCursor: { readonly selectionId?: string; readonly focusId?: string } = {}

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
    this.loadSnapshot = load ?? ((target) => {
      if (runner === undefined) throw new Error("AppController requires a GitRunner or loader")
      return loadWorkingTree(runner, target.scope)
    })
    this.loadBranchSnapshot = options instanceof GitRunner
      ? (baseRef) => loadBranchReview(options, baseRef)
      : options.loadBranch ?? options.branchLoader ?? (runner === undefined ? async () => { throw new Error("Branch review requires a GitRunner") } : (baseRef) => loadBranchReview(runner, baseRef))
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
    }
  }

  get state(): AppModel {
    return this.currentState
  }

  async refresh(): Promise<void> {
    const target = this.currentState.reviewTarget
    if (target.kind === "working-tree") {
      await this.refreshTarget(target)
    } else if (target.kind === "branch") {
      await this.refreshBranchTarget(target.baseRef)
    }
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
    await this.rememberBase(baseRef)
    await this.refreshBranchTarget(baseRef)
  }

  async chooseBase(baseRef: string): Promise<void> {
    await this.setBranchBase(baseRef)
  }

  private async openBranchReview(): Promise<void> {
    let baseRef: string | undefined
    let stalePersistedBase = false
    const branchKey = this.runner === undefined ? this.currentState.branch : await currentBranchRef(this.runner)
    if (branchKey !== undefined && this.reviewStore !== undefined) {
      try {
        this.reviewDatabase = await this.reviewStore.load()
        const persisted = ownValue(this.reviewDatabase.baseByBranch, branchKey)?.ref
        if (persisted !== undefined) {
          if (this.runner !== undefined && await resolveRefOid(this.runner, persisted) !== undefined) baseRef = persisted
          else stalePersistedBase = true
        }
      } catch {
        baseRef = undefined
      }
    }
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
        this.currentState = { ...this.currentState, basePicker: picker, loading: false }
        return
      }
      baseRef = inferred.ref
      await this.rememberBase(baseRef, branchKey)
    }
    await this.refreshBranchTarget(baseRef)
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
      reviewSummary: this.reviewSummaryFor(reviewStatuses, this.currentState.files),
    }
  }

  async stageFile(path: string): Promise<void> {
    await this.runMutation(() => this.mutations?.stageFile(path))
  }

  async unstageFile(path: string): Promise<void> {
    await this.runMutation(() => this.mutations?.unstageFile(path))
  }

  async applySelection(document: DiffDocument, includedLineIndexes: readonly number[], options: SelectionMutationOptions): Promise<void> {
    await this.runMutation(() => this.mutations?.applySelection(document, includedLineIndexes, options))
  }

  async discardSelection(document: DiffDocument, includedLineIndexes: readonly number[], options?: Omit<SelectionMutationOptions, "reverse"> & { readonly reverse?: false }): Promise<void> {
    await this.runMutation(() => this.mutations?.discardSelection(document, includedLineIndexes, options))
  }

  async discardFile(path: string, untracked = false): Promise<void> {
    await this.runMutation(() => this.mutations?.discardFile(path, untracked))
  }

  async toggleAllFiles(): Promise<void> {
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
  private async refreshTarget(target: Extract<ReviewTarget, { readonly kind: "working-tree" }>): Promise<void> {
    const generation = ++this.generation
    this.publishIfCurrent(generation, { loading: true })
    try {
      const snapshot = await this.loadSnapshot(target)
      if (generation !== this.generation) return
      const review = await this.reviewForSnapshot(snapshot.reviewTarget, snapshot.files, snapshot.patches)
      if (generation !== this.generation) return
      const cursor = this.workingTreeCursor
      const { upstream: _previousUpstream, banner: _previousBanner, basePicker: _previousPicker, ...previousState } = this.currentState
      this.currentState = {
        ...previousState,
        ...(snapshot.upstream === undefined ? {} : { upstream: snapshot.upstream }),
        ...(review.warning === undefined ? {} : { banner: review.warning }),
        ...(cursor.selectionId === undefined ? {} : { selectionId: cursor.selectionId }),
        ...(cursor.focusId === undefined ? {} : { focusId: cursor.focusId }),
        repositoryRoot: snapshot.repositoryRoot,
        branch: snapshot.branch,
        reviewTarget: snapshot.reviewTarget,
        files: snapshot.files,
        patches: snapshot.patches,
        rawPatchSections: snapshot.patches,
        reviewStatuses: review.statuses,
        reviewSummary: review.summary,
        loading: false,
        commandLog: this.runner?.log.records() ?? this.currentState.commandLog,
        title: titleFor(snapshot.reviewTarget, snapshot.branch),
      }
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

  private async refreshBranchTarget(baseRef: string): Promise<void> {
    const generation = ++this.generation
    this.publishIfCurrent(generation, { loading: true })
    try {
      const snapshot = await this.loadBranchSnapshot(baseRef)
      if (generation !== this.generation) return
      const review = await this.reviewForSnapshot(snapshot.reviewTarget, snapshot.files, snapshot.patches)
      if (generation !== this.generation) return
      const cursor = this.branchCursor
      const { upstream: _previousUpstream, banner: _previousBanner, basePicker: _previousPicker, ...previousState } = this.currentState
      this.currentState = {
        ...previousState,
        branch: snapshot.branch,
        reviewTarget: snapshot.reviewTarget,
        files: snapshot.files,
        patches: snapshot.patches,
        rawPatchSections: snapshot.patches,
        reviewStatuses: review.statuses,
        reviewSummary: this.reviewSummaryFor(review.statuses, snapshot.files, snapshot.commitCount),
        loading: false,
        commandLog: this.runner?.log.records() ?? this.currentState.commandLog,
        title: titleFor(snapshot.reviewTarget, snapshot.branch),
        ...(cursor.selectionId === undefined ? {} : { selectionId: cursor.selectionId }),
        ...(cursor.focusId === undefined ? {} : { focusId: cursor.focusId }),
      }
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

  private publishIfCurrent(generation: number, update: Pick<AppModel, "loading">): void {
    if (generation === this.generation) this.currentState = { ...this.currentState, ...update }
  }
}
