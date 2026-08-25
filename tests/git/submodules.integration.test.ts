import { afterEach, describe, expect, test } from "bun:test"
import { GitRunner } from "../../src/git/runner"
import { submoduleDepth, submoduleFullName, submoduleFullPath } from "../../src/domain/submodule"
import { listSubmodules } from "../../src/git/submodules"
import { createTempRepository, type TempRepository } from "../helpers/temp-repository"

const commitFile = async (repository: TempRepository, message: string): Promise<void> => {
  await repository.write("file.txt", `${message}\n`)
  await repository.git(["add", "file.txt"])
  const committed = await repository.git(["commit", "-m", message])
  expect(committed.exitCode).toBe(0)
}

const addSubmodule = async (parent: TempRepository, url: string, path: string): Promise<void> => {
  // Cloning over the file transport is disabled by default for submodules.
  const added = await parent.git(["-c", "protocol.file.allow=always", "submodule", "add", "-q", url, path])
  expect(added.stderr).toBe("")
  expect(added.exitCode).toBe(0)
  const committed = await parent.git(["commit", "-m", `add ${path}`])
  expect(committed.exitCode).toBe(0)
}

describe("submodule loader against real repositories", () => {
  const repositories: TempRepository[] = []
  afterEach(async () => {
    while (repositories.length > 0) await repositories.pop()?.cleanup()
  })

  const create = async (): Promise<TempRepository> => {
    const repository = await createTempRepository()
    repositories.push(repository)
    return repository
  }

  test("reports no submodules for a repository without a .gitmodules file", async () => {
    const repository = await create()
    await commitFile(repository, "base")
    expect(await listSubmodules(new GitRunner(repository.path))).toEqual([])
  })

  test("reads a single submodule as git wrote it", async () => {
    const inner = await create()
    await commitFile(inner, "inner")
    const top = await create()
    await commitFile(top, "top")
    await addSubmodule(top, inner.path, "vendor/lib")

    expect(await listSubmodules(new GitRunner(top.path))).toEqual([
      { name: "vendor/lib", path: "vendor/lib", url: inner.path },
    ])
  })

  test("recurses into nested submodules", async () => {
    const inner = await create()
    await commitFile(inner, "inner")
    const mid = await create()
    await commitFile(mid, "mid")
    await addSubmodule(mid, inner.path, "vendor/inner")
    const top = await create()
    await commitFile(top, "top")
    await addSubmodule(top, mid.path, "libs/mid")
    const updated = await top.git(["-c", "protocol.file.allow=always", "submodule", "update", "--init", "--recursive"])
    expect(updated.exitCode).toBe(0)

    const submodules = await listSubmodules(new GitRunner(top.path))
    expect(submodules.map((submodule) => [submoduleFullName(submodule), submoduleDepth(submodule)])).toEqual([
      ["libs/mid", 0],
      ["libs/mid/vendor/inner", 1],
    ])
    expect(submodules[1]!.parentModule).toEqual(submodules[0]!)
    expect(submoduleFullPath(submodules[1]!)).toBe("libs/mid/vendor/inner")
    expect(submodules[1]!.url).toBe(inner.path)
  })
})
