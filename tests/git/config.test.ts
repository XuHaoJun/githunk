import { afterEach, describe, expect, test } from "bun:test"
import { GitRunner } from "../../src/git/runner"
import { REPO_CONFIG_KEY_PATTERN, loadRepoConfig, parseRepoConfig } from "../../src/git/config"
import { createTempRepository, type TempRepository } from "../helpers/temp-repository"

describe("parseRepoConfig", () => {
  test("splits git's NUL-framed key/value records into remotes and branch upstreams", () => {
    const raw = [
      "remote.origin.url\nhttps://example.com/repo.git",
      "remote.origin.pushurl\nssh://git@example.com/repo.git",
      "remote.fork.url\nhttps://example.com/fork.git",
      "branch.main.remote\norigin",
      "branch.main.merge\nrefs/heads/main",
      "branch.feature/nested.remote\nfork",
      "branch.feature/nested.merge\nrefs/heads/feature/nested",
    ].map((record) => `${record}\u0000`).join("")

    const config = parseRepoConfig(raw)

    expect(config.remotes.get("origin")).toEqual({ fetchUrl: "https://example.com/repo.git", pushUrl: "ssh://git@example.com/repo.git" })
    expect(config.remotes.get("fork")).toEqual({ fetchUrl: "https://example.com/fork.git" })
    expect(config.branchUpstreams.get("main")).toEqual({ remote: "origin", merge: "refs/heads/main" })
    expect(config.branchUpstreams.get("feature/nested")).toEqual({ remote: "fork", merge: "refs/heads/feature/nested" })
  })

  test("a valueless key and an unrelated key are both ignored", () => {
    const config = parseRepoConfig("remote.origin.url\u0000core.bare\nfalse\u0000")
    expect(config.remotes.size).toBe(0)
    expect(config.branchUpstreams.size).toBe(0)
  })

  test("empty output yields empty maps rather than throwing", () => {
    const config = parseRepoConfig("")
    expect(config.remotes.size).toBe(0)
    expect(config.branchUpstreams.size).toBe(0)
  })
})

describe("loadRepoConfig", () => {
  let repository: TempRepository | undefined
  afterEach(async () => {
    await repository?.cleanup()
    repository = undefined
  })

  test("reads every remote URL and branch upstream in one git process", async () => {
    repository = await createTempRepository()
    await repository.write("a.txt", "a\n")
    await repository.git(["add", "a.txt"])
    await repository.git(["commit", "-m", "base"])
    await repository.git(["remote", "add", "origin", "https://example.com/repo.git"])
    await repository.git(["remote", "set-url", "--push", "origin", "ssh://git@example.com/repo.git"])
    await repository.git(["config", "branch.master.remote", "origin"])
    await repository.git(["config", "branch.master.merge", "refs/heads/master"])
    const runner = new GitRunner(repository.path)
    const before = runner.log.lines().length

    const config = await loadRepoConfig(runner)

    expect(runner.log.lines().length - before).toBe(1)
    expect(config.remotes.get("origin")).toEqual({
      fetchUrl: "https://example.com/repo.git",
      pushUrl: "ssh://git@example.com/repo.git",
    })
    expect(config.branchUpstreams.get("master")).toEqual({ remote: "origin", merge: "refs/heads/master" })
  })

  test("a repo with no remotes and no upstreams reads as empty, not as an error", async () => {
    repository = await createTempRepository()
    const runner = new GitRunner(repository.path)
    const config = await loadRepoConfig(runner)
    expect(config.remotes.size).toBe(0)
    expect(config.branchUpstreams.size).toBe(0)
  })

  test("the key pattern matches exactly the keys the panels need", () => {
    const matches = (key: string): boolean => new RegExp(REPO_CONFIG_KEY_PATTERN).test(key)
    expect(matches("remote.origin.url")).toBe(true)
    expect(matches("remote.origin.pushurl")).toBe(true)
    expect(matches("branch.main.remote")).toBe(true)
    expect(matches("branch.feature/x.merge")).toBe(true)
    expect(matches("remote.origin.fetch")).toBe(false)
    expect(matches("core.bare")).toBe(false)
    expect(matches("branch.main.rebase")).toBe(false)
  })
})
