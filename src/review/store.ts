import { mkdir, open, rename, stat, unlink } from "node:fs/promises"
import { dirname, isAbsolute, join } from "node:path"
import { randomUUID } from "node:crypto"
import { GitRunner } from "../git/runner"
import type { ReviewDatabase } from "../domain/review-progress"

const fileName = "githunk/review-state-v1.json"

export function emptyReviewDatabase(): ReviewDatabase {
  return { version: 1, baseByBranch: {}, targets: {} }
}

function isDatabase(value: unknown): value is ReviewDatabase {
  if (value === null || typeof value !== "object") return false
  const candidate = value as Partial<ReviewDatabase>
  if (candidate.version !== 1 || candidate.baseByBranch === null || typeof candidate.baseByBranch !== "object" || candidate.targets === null || typeof candidate.targets !== "object") return false
  for (const target of Object.values(candidate.targets)) {
    if (target === null || typeof target !== "object" || target.files === null || typeof target.files !== "object") return false
    for (const file of Object.values(target.files)) {
      if (file === null || typeof file !== "object" || typeof file.reviewedFingerprint !== "string" || typeof file.reviewedAt !== "string") return false
    }
  }
  return true
}

export type ReviewStoreOptions = {
  readonly repositoryRoot?: string | undefined
  readonly runner?: GitRunner | undefined
  readonly onWarning?: ((warning: string) => void) | undefined
}

export class ReviewStore {
  private readonly runner: GitRunner
  private readonly onWarning: ((warning: string) => void) | undefined
  private resolvedPath: string | undefined
  warning: string | undefined

  constructor(repositoryRootOrOptions: string | ReviewStoreOptions) {
    const options = typeof repositoryRootOrOptions === "string"
      ? { repositoryRoot: repositoryRootOrOptions }
      : repositoryRootOrOptions
    this.runner = options.runner ?? new GitRunner(options.repositoryRoot)
    this.onWarning = options.onWarning
  }

  get path(): string {
    return this.resolvedPath ?? join(this.runner.cwd, ".git", fileName)
  }

  async load(): Promise<ReviewDatabase> {
    this.warning = undefined
    const path = await this.resolvePath()
    let text: string
    try {
      text = await Bun.file(path).text()
    } catch (error) {
      if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") return emptyReviewDatabase()
      throw error
    }
    try {
      const parsed: unknown = JSON.parse(text)
      if (!isDatabase(parsed)) throw new Error("schema version is not 1")
      return parsed
    } catch {
      const corruptPath = `${path}.corrupt-${Date.now()}`
      await rename(path, corruptPath)
      this.warning = `Review state was corrupt; moved to ${corruptPath}`
      this.onWarning?.(this.warning)
      return emptyReviewDatabase()
    }
  }

  async save(database: ReviewDatabase): Promise<void> {
    const path = await this.resolvePath()
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`
    const handle = await open(temporary, "wx", 0o600)
    try {
      await handle.writeFile(`${JSON.stringify(database)}\n`, "utf8")
      await handle.chmod(0o600)
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(temporary, path)
    try {
      const directory = await open(dirname(path), "r")
      try { await directory.sync() } finally { await directory.close() }
    } catch {
      // Directory fsync is not available on every supported filesystem.
    }
    const mode = (await stat(path)).mode & 0o777
    if (mode !== 0o600) {
      const fix = await open(path, "r+")
      try { await fix.chmod(0o600); await fix.sync() } finally { await fix.close() }
    }
    await unlink(temporary).catch(() => undefined)
  }

  private async resolvePath(): Promise<string> {
    if (this.resolvedPath !== undefined) return this.resolvedPath
    const output = (await this.runner.run(["rev-parse", "--git-path", fileName], { readOnly: true })).stdout.trim()
    if (output.length === 0) throw new Error("git returned an empty review state path")
    this.resolvedPath = isAbsolute(output) ? output : join(this.runner.cwd, output)
    return this.resolvedPath
  }
}
