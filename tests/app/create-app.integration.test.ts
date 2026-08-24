import { afterEach, describe, expect, test } from "bun:test"
import { createTempRepository, type TempRepository } from "../helpers/temp-repository"
import { GitRunner } from "../../src/git/runner"
import { createApp } from "../../src/app/create-app"

describe("createApp real wiring", () => {
  let repository: TempRepository | undefined
  afterEach(async () => { await repository?.cleanup() })

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
})
