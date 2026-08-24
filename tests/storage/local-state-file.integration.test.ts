import { afterEach, describe, expect, test } from "bun:test"
import { stat } from "node:fs/promises"
import { createTempRepository, type TempRepository } from "../helpers/temp-repository"
import { GitRunner } from "../../src/git/runner"
import { LocalStateFile } from "../../src/storage/local-state-file"

describe("LocalStateFile", () => {
  let repository: TempRepository | undefined
  afterEach(async () => { await repository?.cleanup() })

  test("returns undefined for a file that does not exist", async () => {
    repository = await createTempRepository()
    const file = new LocalStateFile({ runner: new GitRunner(repository.path), relativePath: "githunk/example-v1.json" })
    expect(await file.readText()).toBeUndefined()
  })

  test("writes atomically with owner-only permissions and reads back", async () => {
    repository = await createTempRepository()
    const file = new LocalStateFile({ runner: new GitRunner(repository.path), relativePath: "githunk/example-v1.json" })
    await file.writeText('{"a":1}')
    expect(await file.readText()).toBe('{"a":1}')
    const path = await file.resolvePath()
    expect(path).toContain(".git")
    expect((await stat(path)).mode & 0o777).toBe(0o600)
  })

  test("quarantines an unreadable file under a corrupt name", async () => {
    repository = await createTempRepository()
    const file = new LocalStateFile({ runner: new GitRunner(repository.path), relativePath: "githunk/example-v1.json" })
    await file.writeText("not json")
    const quarantined = await file.quarantine()
    expect(quarantined).toContain(".corrupt-")
    expect(await file.readText()).toBeUndefined()
  })
})
