import { afterEach, describe, expect, test } from "bun:test"
import { createTempRepository, type TempRepository } from "../helpers/temp-repository"
import { GitRunner } from "../../src/git/runner"
import { UiStateStore, defaultUiState } from "../../src/ui/ui-state-store"

describe("UiStateStore", () => {
  let repository: TempRepository | undefined
  afterEach(async () => { await repository?.cleanup() })

  test("returns defaults when nothing has been saved", async () => {
    repository = await createTempRepository()
    const store = new UiStateStore(new GitRunner(repository.path))
    expect(await store.load()).toEqual(defaultUiState())
  })

  test("round-trips the geometry a drag produced", async () => {
    repository = await createTempRepository()
    const store = new UiStateStore(new GitRunner(repository.path))
    await store.save({ sidePanelRatio: 0.42, commandLogHeight: 11, commandLogVisible: true })
    expect(await store.load()).toEqual({ sidePanelRatio: 0.42, commandLogHeight: 11, commandLogVisible: true })
  })

  test("falls back to defaults rather than throwing on a corrupt file", async () => {
    repository = await createTempRepository()
    const runner = new GitRunner(repository.path)
    const store = new UiStateStore(runner)
    await store.save({ sidePanelRatio: 0.42, commandLogHeight: 11, commandLogVisible: true })
    await Bun.write(await new UiStateStore(runner).path(), "{ this is not json")
    expect(await store.load()).toEqual(defaultUiState())
  })

  test("rejects out-of-range values rather than trusting the file", async () => {
    repository = await createTempRepository()
    const runner = new GitRunner(repository.path)
    const store = new UiStateStore(runner)
    await Bun.write(await store.path(), JSON.stringify({ version: 1, sidePanelRatio: 9, commandLogHeight: -4, commandLogVisible: "yes" }))
    expect(await store.load()).toEqual(defaultUiState())
  })
})
