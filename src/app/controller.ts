import { GitRunner, GitCommandError } from "../git/runner"
import { loadWorkingTree } from "../git/diff"
import type { DiffDocument } from "../domain/diff/document"
import type { AppModel } from "../domain/repository"
import type { ReviewTarget, WorkingTreeScope } from "../domain/review-target"
import type { WorkingTreeSnapshot } from "../domain/repository"
import { GitMutations, type SelectionMutationOptions } from "../git/mutations"
import { MutationQueue } from "./mutation-queue"

export type WorkingTreeLoader = (target: Extract<ReviewTarget, { readonly kind: "working-tree" }>) => Promise<WorkingTreeSnapshot>

export type AppControllerOptions = {
  readonly repositoryRoot?: string
  readonly runner?: GitRunner
  readonly load?: WorkingTreeLoader
  readonly loader?: WorkingTreeLoader
  readonly mutations?: GitMutations
}

function titleFor(target: ReviewTarget): string {
  if (target.kind === "working-tree") {
    return `Working Tree — ${target.scope[0]?.toUpperCase() ?? "A"}${target.scope.slice(1)}`
  }
  if (target.kind === "branch") return `Branch — ${target.baseRef}`
  if (target.kind === "commit") return `Commit — ${target.oid}`
  return `Stash — ${target.ref}`
}

export class AppController {
  readonly runner: GitRunner | undefined
  readonly mutations: GitMutations | undefined
  readonly mutationQueue = new MutationQueue()
  private readonly loadSnapshot: WorkingTreeLoader
  private generation = 0
  private currentState: AppModel

  constructor(options: AppControllerOptions | GitRunner, loader?: WorkingTreeLoader) {
    const runner = options instanceof GitRunner ? options : options.runner
    const load = options instanceof GitRunner ? loader : options.load ?? options.loader
    const repositoryRoot = options instanceof GitRunner ? options.cwd : options.repositoryRoot ?? runner?.cwd
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
    const target: ReviewTarget = { kind: "working-tree", scope: "all" }
    this.currentState = {
      repositoryRoot: repositoryRoot ?? "",
      branch: "",
      reviewTarget: target,
      files: [],
      patches: [],
      rawPatchSections: [],
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
    await this.refreshTarget(target.kind === "working-tree" ? target : { kind: "working-tree", scope: "all" })
  }

  async setWorkingTreeScope(scope: WorkingTreeScope): Promise<void> {
    await this.refreshTarget({ kind: "working-tree", scope })
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
        }
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

  private async refreshTarget(target: Extract<ReviewTarget, { readonly kind: "working-tree" }>): Promise<void> {
    const generation = ++this.generation
    this.publishIfCurrent(generation, { loading: true })
    try {
      const snapshot = await this.loadSnapshot(target)
      if (generation !== this.generation) return
      const { upstream: _previousUpstream, banner: _previousBanner, ...previousState } = this.currentState
      this.currentState = {
        ...previousState,
        ...(snapshot.upstream === undefined ? {} : { upstream: snapshot.upstream }),
        repositoryRoot: snapshot.repositoryRoot,
        branch: snapshot.branch,
        reviewTarget: snapshot.reviewTarget,
        files: snapshot.files,
        patches: snapshot.patches,
        rawPatchSections: snapshot.patches,
        loading: false,
        commandLog: this.runner?.log.records() ?? this.currentState.commandLog,
        title: titleFor(snapshot.reviewTarget),
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
