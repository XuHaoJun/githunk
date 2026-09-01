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
      },
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
        loadPullRequests: async () => [{
          number: 42,
          title: "merged",
          state: "MERGED",
          checksState: "",
          url: "",
          headRefName: "feature",
          headRepositoryOwner: "tmp",
        }],
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
})
