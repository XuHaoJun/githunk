import { afterEach, describe, expect, test } from "bun:test"
import { createTempRepository, type TempRepository } from "../helpers/temp-repository"
import { GitRunner } from "../../src/git/runner"
import { UiStateStore, defaultUiState } from "../../src/ui/ui-state-store"
import { DEFAULT_LOG_HEIGHT } from "../../src/ui/layout"

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

  /**
   * `Gui.ShowCommandLog: true` (pkg/config/user_config.go:901), and
   * `gui.ShowExtrasWindow = userConfig.Gui.ShowCommandLog && !GetAppState().HideCommandLog`
   * (pkg/gui/gui.go:523) — so shown unless the user hid it, and the persisted choice wins.
   */
  test("the command log is shown by default", () => {
    expect(defaultUiState().commandLogVisible).toBe(true)
    expect(defaultUiState().commandLogHeight).toBe(DEFAULT_LOG_HEIGHT)
  })

  test("a persisted hidden log still wins, as HideCommandLog does", async () => {
    repository = await createTempRepository()
    const runner = new GitRunner(repository.path)
    const store = new UiStateStore(runner)
    await store.save({ sidePanelRatio: 0.4, commandLogHeight: 12, commandLogVisible: false })
    expect((await store.load()).commandLogVisible).toBe(false)
  })

  /**
   * `gui.ShowExtrasWindow = userConfig.Gui.ShowCommandLog && !GetAppState().HideCommandLog`
   * (pkg/gui/gui.go:523) inverts `HideCommandLog` at read time, and `extras_panel.go:26`
   * (`HideCommandLog = !show`) inverts it back at write time. githunk mirrors that: the on-disk
   * field is `commandLogHidden`, negated relative to the in-memory `commandLogVisible`.
   */
  test("saves commandLogHidden inverted, not commandLogVisible", async () => {
    repository = await createTempRepository()
    const runner = new GitRunner(repository.path)
    const store = new UiStateStore(runner)
    await store.save({ sidePanelRatio: 0.4, commandLogHeight: 12, commandLogVisible: false })
    const raw = JSON.parse(await Bun.file(await store.path()).text()) as Record<string, unknown>
    expect(raw.commandLogHidden).toBe(true)
    expect(raw.commandLogVisible).toBeUndefined()
    expect(raw.version).toBe(2)
  })

  /**
   * The exact file the owner had on disk (feat/lazygit-branch-parity, HEAD 22ddbe5): a build from
   * before the default flipped wrote `commandLogVisible: false` and `commandLogHeight: 8` — 8 was
   * the *old* default total (6 content rows), not a value the owner chose. Its absent
   * `commandLogHidden` marks it version-1 / pre-migration: `commandLogVisible` and
   * `commandLogHeight` are untrustworthy and take the current defaults (shown, 10), while
   * `sidePanelRatio` — a dragged value, and a field whose meaning never changed — survives.
   */
  test("migrates the owner's real pre-migration file: shown, default height, dragged ratio kept", async () => {
    repository = await createTempRepository()
    const runner = new GitRunner(repository.path)
    const store = new UiStateStore(runner)
    const ownersFile = {
      version: 1,
      sidePanelRatio: 0.33992094861660077,
      commandLogHeight: 8,
      commandLogVisible: false,
    }
    await Bun.write(await store.path(), JSON.stringify(ownersFile))
    expect(await store.load()).toEqual({
      commandLogVisible: true,
      commandLogHeight: DEFAULT_LOG_HEIGHT,
      sidePanelRatio: 0.33992094861660077,
    })
  })

  /** A version-1 file with no usable `sidePanelRatio` either degrades all the way to defaults. */
  test("a pre-migration file with an invalid sidePanelRatio falls back fully to defaults", async () => {
    repository = await createTempRepository()
    const runner = new GitRunner(repository.path)
    const store = new UiStateStore(runner)
    await Bun.write(
      await store.path(),
      JSON.stringify({ version: 1, sidePanelRatio: 9, commandLogHeight: 8, commandLogVisible: false }),
    )
    expect(await store.load()).toEqual(defaultUiState())
  })

  /**
   * The user's real choice, made after upgrading past the migration, must still be honoured —
   * otherwise this fix has just traded one unreachable state (shown, unreachable) for another
   * (hidden, unreachable).
   */
  test("a post-migration file with commandLogHidden: true loads as hidden", async () => {
    repository = await createTempRepository()
    const runner = new GitRunner(repository.path)
    const store = new UiStateStore(runner)
    await Bun.write(
      await store.path(),
      JSON.stringify({ version: 2, sidePanelRatio: 0.4, commandLogHeight: 11, commandLogHidden: true }),
    )
    expect(await store.load()).toEqual({ sidePanelRatio: 0.4, commandLogHeight: 11, commandLogVisible: false })
  })

  test("a malformed version-2 file (missing commandLogHidden) degrades to defaults", async () => {
    repository = await createTempRepository()
    const runner = new GitRunner(repository.path)
    const store = new UiStateStore(runner)
    await Bun.write(
      await store.path(),
      JSON.stringify({ version: 2, sidePanelRatio: 0.4, commandLogHeight: 11 }),
    )
    expect(await store.load()).toEqual(defaultUiState())
  })
})
