import { GitRunner, GitCommandError } from "../git/runner"
import { loadWorkingTree } from "../git/diff"
import type { AppModel } from "../domain/repository"
import type { ReviewTarget, WorkingTreeScope } from "../domain/review-target"
import type { WorkingTreeSnapshot } from "../domain/repository"

export type WorkingTreeLoader = (target: Extract<ReviewTarget, { readonly kind: "working-tree" }>) => Promise<WorkingTreeSnapshot>

export type AppControllerOptions = {
  readonly repositoryRoot?: string
  readonly runner?: GitRunner
  readonly load?: WorkingTreeLoader
  readonly loader?: WorkingTreeLoader
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
  private readonly loadSnapshot: WorkingTreeLoader
  private generation = 0
  private currentState: AppModel

  constructor(options: AppControllerOptions | GitRunner, loader?: WorkingTreeLoader) {
    const runner = options instanceof GitRunner ? options : options.runner
    const load = options instanceof GitRunner ? loader : options.load ?? options.loader
    const repositoryRoot = options instanceof GitRunner ? options.cwd : options.repositoryRoot ?? runner?.cwd
    this.runner = runner
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
    const generation = ++this.generation
    const target = this.currentState.reviewTarget
    this.publishIfCurrent(generation, { loading: true })
    try {
      const snapshot = await this.loadSnapshot(target.kind === "working-tree" ? target : { kind: "working-tree", scope: "all" })
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

  async setWorkingTreeScope(scope: WorkingTreeScope): Promise<void> {
    const target: ReviewTarget = { kind: "working-tree", scope }
    this.currentState = { ...this.currentState, reviewTarget: target, title: titleFor(target) }
    await this.refresh()
  }

  private publishIfCurrent(generation: number, update: Pick<AppModel, "loading">): void {
    if (generation === this.generation) this.currentState = { ...this.currentState, ...update }
  }
}
