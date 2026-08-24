import { mkdir, open, rename, stat, unlink, lstat } from "node:fs/promises"
import { dirname, isAbsolute, join, resolve } from "node:path"
import { randomUUID } from "node:crypto"
import type { GitRunner } from "../git/runner"

export type LocalStateFileOptions = {
  readonly runner: GitRunner
  /** Path relative to the git directory, e.g. "githunk/ui-state-v1.json". */
  readonly relativePath: string
  /** Noun for the symlink-refusal error message, e.g. "review-state". Defaults to "state". */
  readonly pathKind?: string
}

async function assertNoSymlinkInPath(path: string, pathKind: string): Promise<void> {
  const absolute = resolve(path)
  const segments = absolute.split("/").filter(Boolean)
  let current = absolute.startsWith("/") ? "/" : ""
  for (const segment of segments) {
    current = current === "/" ? `/${segment}` : `${current}/${segment}`
    try {
      if ((await lstat(current)).isSymbolicLink()) throw new Error(`refusing symlinked ${pathKind} path component: ${current}`)
    } catch (error) {
      if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") break
      throw error
    }
  }
}

export class LocalStateFile {
  private readonly runner: GitRunner
  private readonly relativePath: string
  private readonly pathKind: string
  private resolvedPath: string | undefined

  constructor(options: LocalStateFileOptions) {
    this.runner = options.runner
    this.relativePath = options.relativePath
    this.pathKind = options.pathKind ?? "state"
  }

  get path(): string {
    return this.resolvedPath ?? join(this.runner.cwd, ".git", this.relativePath)
  }

  async resolvePath(): Promise<string> {
    if (this.resolvedPath !== undefined) return this.resolvedPath
    const output = (await this.runner.run(["rev-parse", "--git-path", this.relativePath], { readOnly: true })).stdout.trim()
    if (output.length === 0) throw new Error(`git returned an empty path for ${this.relativePath}`)
    this.resolvedPath = isAbsolute(output) ? output : join(this.runner.cwd, output)
    return this.resolvedPath
  }

  async readText(): Promise<string | undefined> {
    const path = await this.resolvePath()
    await assertNoSymlinkInPath(path, this.pathKind)
    try {
      return await Bun.file(path).text()
    } catch (error) {
      if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") return undefined
      throw error
    }
  }

  async writeText(text: string): Promise<void> {
    const path = await this.resolvePath()
    await assertNoSymlinkInPath(path, this.pathKind)
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`
    await assertNoSymlinkInPath(temporary, this.pathKind)
    const handle = await open(temporary, "wx", 0o600)
    try {
      await handle.writeFile(text, "utf8")
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

  async quarantine(): Promise<string> {
    const path = await this.resolvePath()
    const corruptPath = `${path}.corrupt-${Date.now()}`
    await rename(path, corruptPath)
    return corruptPath
  }
}
