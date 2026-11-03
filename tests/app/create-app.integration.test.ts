import { afterEach, describe, expect, test } from "bun:test"
import { createTestRenderer } from "@opentui/core/testing"
import { createTempRepository, type TempRepository } from "../helpers/temp-repository"
import { GitRunner } from "../../src/git/runner"
import { createApp } from "../../src/app/create-app"

describe("createApp real wiring", () => {
  let repository: TempRepository | undefined
  let remote: TempRepository | undefined
  afterEach(async () => {
    await repository?.cleanup()
    await remote?.cleanup()
    repository = undefined
    remote = undefined
  })

  test("loads commit history, branches and stashes through the shipped wiring", async () => {
    repository = await createTempRepository()
    await repository.write("a.txt", "one\n")
    await repository.git(["add", "a.txt"])
    await repository.git(["commit", "-m", "first commit"])
    await repository.write("a.txt", "two\n")
    await repository.git(["commit", "-am", "second commit"])
    await repository.write("a.txt", "three\n")
    await repository.git(["commit", "-am", "third commit"])
    await repository.write("a.txt", "stashed\n")
    await repository.git(["stash", "push", "-m", "wip"])

    const app = createApp({ repositoryRoot: repository.path, runner: new GitRunner(repository.path) })
    await app.refresh()

    const subjects = (app.controller.state.commits ?? []).map((commit) => commit.subject)
    expect(subjects).toEqual(["third commit", "second commit", "first commit"])
    expect(app.controller.state.branches?.localBranches.length ?? 0).toBeGreaterThan(0)
    expect(app.controller.state.stashes?.length ?? 0).toBe(1)
  })

  test("runs an injected pull-request loader as part of a full refresh", async () => {
    repository = await createTempRepository()
    await repository.write("a.txt", "one\n")
    await repository.git(["add", "a.txt"])
    await repository.git(["commit", "-m", "first commit"])
    let loadCount = 0

    const app = createApp({
      repositoryRoot: repository.path,
      runner: new GitRunner(repository.path),
      loadPullRequests: async () => {
        loadCount += 1
        return []
      }
    })
    await app.refresh()

    expect(loadCount).toBe(1)
  })

  test("repaints a merged pull-request dot when the asynchronous result arrives", async () => {
    repository = await createTempRepository()
    remote = await createTempRepository()
    await repository.write("a.txt", "one\n")
    await repository.git(["add", "a.txt"])
    await repository.git(["commit", "-m", "first commit"])
    await remote.git(["config", "core.bare", "true"])
    await repository.git(["remote", "add", "origin", remote.path])
    await repository.git(["push", "-u", "origin", "master"])
    await repository.git(["checkout", "-b", "feature", "--quiet"])
    await repository.git(["push", "-u", "origin", "feature"])
    const setup = await createTestRenderer({ width: 120, height: 40, useMouse: true })
    let app: ReturnType<typeof createApp> | undefined
    try {
      app = createApp({
        repositoryRoot: repository.path,
        runner: new GitRunner(repository.path),
        renderer: setup.renderer,
        background: { enabled: false },
        loadPullRequests: async () => [
          {
            number: 42,
            title: "merged",
            state: "MERGED",
            checksState: "",
            url: "",
            headRefName: "feature",
            headRepositoryOwner: "tmp"
          }
        ]
      })
      await app.refresh()
      await app.controller.refreshPullRequests()

      expect(app.controller.state.pullRequests?.feature?.state).toBe("MERGED")
      expect(app.view?.renderedListText("branches")).toContain("●")
      await setup.flush()
      expect(setup.captureCharFrame()).toContain("●")
    } finally {
      await app?.destroy()
      setup.renderer.destroy()
    }
  })
  test("an in-flight refresh does not repaint after the app is destroyed", async () => {
    repository = await createTempRepository()
    const setup = await createTestRenderer({ width: 120, height: 40 })
    const runner = new GitRunner(repository.path)
    const run = runner.run.bind(runner)
    let releaseIndex!: () => void
    const indexGate = new Promise<void>((resolve) => {
      releaseIndex = resolve
    })
    let indexRequested!: () => void
    const indexRequest = new Promise<void>((resolve) => {
      indexRequested = resolve
    })
    runner.run = async (args, options) => {
      if (args[0] === "rev-parse" && args[1] === "--git-path" && args[2] === "index") {
        indexRequested()
        await indexGate
      }
      return run(args, options)
    }
    const app = createApp({
      repositoryRoot: repository.path,
      runner,
      renderer: setup.renderer,
      background: { enabled: true, autoFetch: false, autoDetectExternalChanges: false },
      loadPullRequests: async () => []
    })
    const view = app.view
    if (view === undefined) throw new Error("expected a repository view")
    const originalUpdate = view.update.bind(view)
    let repaints = 0
    view.update = (model, options) => {
      repaints += 1
      originalUpdate(model, options)
    }
    try {
      const refresh = app.refresh()
      await indexRequest
      const destroy = app.destroy()
      releaseIndex()
      await expect(refresh).resolves.toBeUndefined()
      await destroy
      expect(repaints).toBe(0)
    } finally {
      await app.destroy().catch(() => undefined)
      setup.renderer.destroy()
    }
  })

  test("a refresh that loads persisted geometry after destroy does not lay out the destroyed view", async () => {
    repository = await createTempRepository()
    const setup = await createTestRenderer({ width: 120, height: 40 })
    const runner = new GitRunner(repository.path)
    const run = runner.run.bind(runner)
    let releaseLoad!: () => void
    const loadGate = new Promise<void>((resolve) => {
      releaseLoad = resolve
    })
    let loadRequested!: () => void
    const loadRequest = new Promise<void>((resolve) => {
      loadRequested = resolve
    })
    let gated = false
    runner.run = async (args, options) => {
      if (!gated && args[0] === "rev-parse" && args[1] === "--git-path" && args[2] === "githunk/ui-state-v1.json") {
        gated = true
        loadRequested()
        await loadGate
      }
      return run(args, options)
    }
    const app = createApp({
      repositoryRoot: repository.path,
      runner,
      renderer: setup.renderer,
      background: { enabled: false },
      loadPullRequests: async () => []
    })
    try {
      const refresh = app.refresh()
      await loadRequest
      const destroy = app.destroy()
      setup.renderer.destroy()
      releaseLoad()
      await expect(refresh).resolves.toBeUndefined()
      await destroy
    } finally {
      await app.destroy().catch(() => undefined)
      setup.renderer.destroy()
    }
  })
})
