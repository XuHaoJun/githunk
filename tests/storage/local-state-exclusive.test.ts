import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, stat, symlink, readFile, readdir } from "node:fs/promises"
import { join } from "node:path"
import { createTempRepository, type TempRepository } from "../helpers/temp-repository"
import { GitRunner } from "../../src/git/runner"
import { LocalStateFile } from "../../src/storage/local-state-file"

describe("LocalStateFile", () => {
  let repository: TempRepository | undefined
  afterEach(async () => {
    await repository?.cleanup()
    repository = undefined
  })

  test("creates file atomically with mode 0600 and readable content", async () => {
    repository = await createTempRepository()
    const runner = new GitRunner(repository.path)
    const file = new LocalStateFile({ runner, relativePath: "githunk/exclusive-0600.json", pathKind: "review-state" })
    const result = await file.createTextExclusive('{"hello":1}\n')
    expect(result.ok).toBe(true)
    const path = await file.resolvePath()
    const mode = (await stat(path)).mode & 0o777
    expect(mode).toBe(0o600)
    const content = await readFile(path, "utf8")
    expect(content).toBe('{"hello":1}\n')
  })

  test("refuses symlinked path component", async () => {
    repository = await createTempRepository()
    const runner = new GitRunner(repository.path)
    const gitGithunk = join(repository.path, ".git", "githunk")
    await mkdir(gitGithunk, { recursive: true })
    const target = join(repository.path, "real-target")
    await mkdir(target, { recursive: true })
    const linkPath = join(gitGithunk, "symlinked")
    await symlink(target, linkPath)
    const file = new LocalStateFile({ runner, relativePath: "githunk/symlinked/file.json", pathKind: "review-state" })
    await expect(file.createTextExclusive("hello")).rejects.toThrow(/symlinked review-state path component/)
  })

  test("returns already-exists without overwriting and keeps original content", async () => {
    repository = await createTempRepository()
    const runner = new GitRunner(repository.path)
    const file = new LocalStateFile({ runner, relativePath: "githunk/exclusive-dup.json", pathKind: "review-state" })
    const first = await file.createTextExclusive("first")
    expect(first.ok).toBe(true)
    const second = await file.createTextExclusive("second")
    expect(second.ok).toBe(false)
    if (!second.ok) expect(second.reason).toBe("already-exists")
    const path = await file.resolvePath()
    const content = await readFile(path, "utf8")
    expect(content).toBe("first")
    const mode = (await stat(path)).mode & 0o777
    expect(mode).toBe(0o600)
  })

  test("uses hard-link atomicity – temporary file is removed and directory is synced", async () => {
    repository = await createTempRepository()
    const runner = new GitRunner(repository.path)
    const file = new LocalStateFile({ runner, relativePath: "githunk/exclusive-link.json", pathKind: "review-state" })
    const result = await file.createTextExclusive("payload")
    expect(result.ok).toBe(true)
    const path = await file.resolvePath()
    const dir = join(repository.path, ".git", "githunk")
    const entries = await readdir(dir)
    const temps = entries.filter((e) => e.startsWith("exclusive-link.json.tmp-"))
    expect(temps.length).toBe(0)
    expect(await readFile(path, "utf8")).toBe("payload")
  })

  test("fsyncs through existing path discipline – second exclusive after first non-overwriting", async () => {
    repository = await createTempRepository()
    const runner = new GitRunner(repository.path)
    const file = new LocalStateFile({ runner, relativePath: "githunk/exclusive-fsync.json", pathKind: "review-state" })
    await file.createTextExclusive("a")
    expect(await file.readText()).toBe("a")
    const dup = await file.createTextExclusive("b")
    expect(dup.ok).toBe(false)
    expect(await file.readText()).toBe("a")
  })
  test("propagates non-missing state read errors", async () => {
    repository = await createTempRepository()
    const runner = new GitRunner(repository.path)
    const path = join(repository.path, ".git", "githunk", "directory-state.json")
    await mkdir(path, { recursive: true })
    const file = new LocalStateFile({ runner, relativePath: "githunk/directory-state.json", pathKind: "review-state" })
    await expect(file.readText()).rejects.toMatchObject({ code: "EISDIR" })
  })
})
