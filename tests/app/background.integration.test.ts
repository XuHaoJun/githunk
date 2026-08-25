import { afterEach, describe, expect, test } from "bun:test"
import { createTestRenderer } from "@opentui/core/testing"
import type { CliRenderer } from "@opentui/core"
import { createApp, backgroundOptionsFromEnv, type App } from "../../src/app/create-app"
import { GitRunner } from "../../src/git/runner"
import { createTempRepository, type TempRepository } from "../helpers/temp-repository"

/**
 * The background routines, end to end: a commit that appears on the remote while githunk is
 * running must show up as a behind-count without anyone pressing a key. lazygit's `git.autoFetch`
 * (pkg/gui/background.go:44-58) followed by `PostFetchRefresh`.
 */
describe("background auto-fetch", () => {
  let repository: TempRepository | undefined
  let bare: TempRepository | undefined
  let other: TempRepository | undefined
  let app: App | undefined
  let renderer: CliRenderer | undefined

  afterEach(async () => {
    app?.destroy()
    renderer?.destroy()
    app = undefined
    renderer = undefined
    await repository?.cleanup()
    await bare?.cleanup()
    await other?.cleanup()
    repository = undefined
    bare = undefined
    other = undefined
  })

  test("a commit pushed elsewhere turns into a behind-count with no keypress", async () => {
    repository = await createTempRepository()
    await repository.write("a.txt", "one\n")
    await repository.git(["add", "a.txt"])
    await repository.git(["commit", "-m", "first commit"])
    bare = await createTempRepository()
    await bare.git(["config", "core.bare", "true"])
    await repository.git(["remote", "add", "origin", bare.path])
    await repository.git(["push", "-u", "origin", "HEAD"])

    const setup = await createTestRenderer({ width: 120, height: 40, useMouse: true })
    renderer = setup.renderer
    app = createApp({
      repositoryRoot: repository.path,
      runner: new GitRunner(repository.path),
      renderer: setup.renderer,
      background: { enabled: true, autoFetch: true, autoRefresh: false, fetchIntervalMs: 50 },
    })
    await app.refresh()
    await setup.flush()

    const currentName = app.controller.state.branches!.localBranches.find((branch) => branch.isCurrent)!.name
    const behind = (): string | undefined =>
      app!.controller.state.branches!.localBranches.find((branch) => branch.name === currentName)?.behindForPull
    expect(behind()).toBe("0")

    // Somebody else pushes.
    other = await createTempRepository()
    await other.git(["remote", "add", "origin", bare.path])
    await other.git(["fetch", "origin"])
    await other.git(["checkout", "-B", currentName, `origin/${currentName}`, "--quiet"])
    await other.write("a.txt", "two\n")
    await other.git(["add", "a.txt"])
    await other.git(["commit", "-m", "second commit"])
    await other.git(["push", "origin", currentName])

    // Polls the *frame*, not just the model: the routine refreshes the branches, asks `gh` for
    // pull requests, and only then pushes the model into the view, so the model can be ahead of
    // what is drawn.
    for (let attempt = 0; attempt < 400 && !setup.captureCharFrame().includes("↓1"); attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 20))
      await setup.flush()
    }
    expect(behind()).toBe("1")
    // And the branch row says so, in lazygit's arrow form.
    expect(setup.captureCharFrame()).toContain("↓1")
  }, 20_000)

  test("a commit made outside the app shows up on its own, with no keypress", async () => {
    // lazygit's `git.autoDetectExternalChanges`: poll a refs fingerprint and refresh when it moves
    // (pkg/gui/background.go:169-208).
    repository = await createTempRepository()
    await repository.write("a.txt", "one\n")
    await repository.git(["add", "a.txt"])
    await repository.git(["commit", "-m", "first commit"])

    const setup = await createTestRenderer({ width: 120, height: 40, useMouse: true })
    renderer = setup.renderer
    app = createApp({
      repositoryRoot: repository.path,
      runner: new GitRunner(repository.path),
      renderer: setup.renderer,
      background: { enabled: true, autoFetch: false, autoRefresh: false, autoDetectExternalChanges: true, externalChangeIntervalMs: 30 },
    })
    await app.refresh()
    await setup.flush()
    expect(setup.captureCharFrame()).not.toContain("made in another terminal")

    // Somebody else — another terminal, an editor's git integration — commits.
    await repository.write("a.txt", "two\n")
    await repository.git(["add", "a.txt"])
    await repository.git(["commit", "-m", "made in another terminal"])

    for (let attempt = 0; attempt < 200 && !setup.captureCharFrame().includes("made in another terminal"); attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 20))
      await setup.flush()
    }
    expect(setup.captureCharFrame()).toContain("made in another terminal")
  }, 20_000)

  test("detection off means the outside commit stays invisible", async () => {
    repository = await createTempRepository()
    await repository.write("a.txt", "one\n")
    await repository.git(["add", "a.txt"])
    await repository.git(["commit", "-m", "first commit"])

    const setup = await createTestRenderer({ width: 120, height: 40, useMouse: true })
    renderer = setup.renderer
    app = createApp({
      repositoryRoot: repository.path,
      runner: new GitRunner(repository.path),
      renderer: setup.renderer,
      background: { enabled: true, autoFetch: false, autoRefresh: false, autoDetectExternalChanges: false, externalChangeIntervalMs: 30 },
    })
    await app.refresh()
    await setup.flush()

    await repository.write("a.txt", "two\n")
    await repository.git(["add", "a.txt"])
    await repository.git(["commit", "-m", "made in another terminal"])
    await new Promise((resolve) => setTimeout(resolve, 200))
    await setup.flush()
    expect(setup.captureCharFrame()).not.toContain("made in another terminal")
  }, 20_000)

  test("no background options means no timers at all", async () => {
    repository = await createTempRepository()
    await repository.write("a.txt", "one\n")
    await repository.git(["add", "a.txt"])
    await repository.git(["commit", "-m", "first commit"])
    const setup = await createTestRenderer({ width: 120, height: 40, useMouse: true })
    renderer = setup.renderer
    app = createApp({ repositoryRoot: repository.path, runner: new GitRunner(repository.path), renderer: setup.renderer })
    await app.refresh()
    const before = app.controller.state.commandLog.length
    await new Promise((resolve) => setTimeout(resolve, 120))
    expect(app.controller.state.commandLog.length).toBe(before)
  }, 20_000)
})

describe("backgroundOptionsFromEnv", () => {
  test("defaults to lazygit's behaviour and lets each half be switched off", () => {
    expect(backgroundOptionsFromEnv({})).toEqual({
      enabled: true,
      autoFetch: true,
      autoRefresh: true,
      autoDetectExternalChanges: true,
      fetchIntervalMs: 60_000,
      refreshIntervalMs: 10_000,
      externalChangeIntervalMs: 2_000,
    })
    expect(backgroundOptionsFromEnv({ GITHUNK_AUTO_FETCH: "0" }).autoFetch).toBe(false)
    expect(backgroundOptionsFromEnv({ GITHUNK_AUTO_REFRESH: "false" }).autoRefresh).toBe(false)
    expect(backgroundOptionsFromEnv({ GITHUNK_DETECT_EXTERNAL_CHANGES: "0" }).autoDetectExternalChanges).toBe(false)
    expect(backgroundOptionsFromEnv({ GITHUNK_EXTERNAL_CHANGE_INTERVAL: "3" }).externalChangeIntervalMs).toBe(3_000)
    expect(backgroundOptionsFromEnv({ GITHUNK_BACKGROUND: "0" }).enabled).toBe(false)
    expect(backgroundOptionsFromEnv({ GITHUNK_FETCH_INTERVAL: "5" }).fetchIntervalMs).toBe(5_000)
    // Nonsense falls back rather than disabling the routine outright.
    expect(backgroundOptionsFromEnv({ GITHUNK_REFRESH_INTERVAL: "nope" }).refreshIntervalMs).toBe(10_000)
  })
})
