import { join } from "node:path"
import { GitRunner } from "../git/runner"
import type { ReviewDatabase } from "../domain/review-progress"
import { LocalStateFile } from "../storage/local-state-file"

const fileName = "githunk/working-tree-review-state-v1.json"

export function emptyWorkingTreeReviewDatabase(): ReviewDatabase {
  return { version: 1, baseByBranch: {}, targets: {} }
}

function isDatabase(value: unknown): value is ReviewDatabase {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false
  const candidate = value as Partial<ReviewDatabase>
  if (candidate.version !== 1 || candidate.baseByBranch === null || typeof candidate.baseByBranch !== "object" || Array.isArray(candidate.baseByBranch) || candidate.targets === null || typeof candidate.targets !== "object" || Array.isArray(candidate.targets)) return false
  for (const base of Object.values(candidate.baseByBranch)) {
    if (base === null || typeof base !== "object" || typeof base.ref !== "string") return false
  }
  for (const target of Object.values(candidate.targets)) {
    if (target === null || typeof target !== "object" || Array.isArray(target) || target.files === null || typeof target.files !== "object" || Array.isArray(target.files)) return false
    for (const file of Object.values(target.files)) {
      if (file === null || typeof file !== "object" || Array.isArray(file) || typeof file.reviewedFingerprint !== "string" || typeof file.reviewedAt !== "string") return false
    }
  }
  return true
}

export type WorkingTreeReviewStoreOptions = {
  readonly repositoryRoot?: string | undefined
  readonly runner?: GitRunner | undefined
  readonly onWarning?: ((warning: string) => void) | undefined
}

export class WorkingTreeReviewStore {
  private readonly runner: GitRunner
  private readonly onWarning: ((warning: string) => void) | undefined
  private readonly file: LocalStateFile
  warning: string | undefined

  constructor(repositoryRootOrOptions: string | WorkingTreeReviewStoreOptions) {
    const options = typeof repositoryRootOrOptions === "string"
      ? { repositoryRoot: repositoryRootOrOptions }
      : repositoryRootOrOptions
    this.runner = options.runner ?? new GitRunner(options.repositoryRoot)
    this.onWarning = options.onWarning
    this.file = new LocalStateFile({ runner: this.runner, relativePath: fileName, pathKind: "working-tree-review-state" })
  }

  get path(): string {
    return this.file.path
  }

  async load(): Promise<ReviewDatabase> {
    this.warning = undefined
    const text = await this.file.readText()
    if (text === undefined) return emptyWorkingTreeReviewDatabase()
    try {
      const parsed: unknown = JSON.parse(text)
      if (!isDatabase(parsed)) throw new Error("schema version is not 1")
      return parsed
    } catch {
      const corruptPath = await this.file.quarantine()
      this.warning = `Working tree review state was corrupt; moved to ${corruptPath}`
      this.onWarning?.(this.warning)
      return emptyWorkingTreeReviewDatabase()
    }
  }

  async save(database: ReviewDatabase): Promise<void> {
    await this.file.writeText(`${JSON.stringify(database)}\n`)
  }
}
