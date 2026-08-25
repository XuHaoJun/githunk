import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { GitResult, GitRunOptions } from "../../src/git/runner"
import { listWorktrees, parseWorktreeList, uniqueWorktreeNames } from "../../src/git/worktrees"

type FakeResponse = {
  readonly args: readonly string[]
  readonly stdout: string
}

class FakeRunner {
  readonly calls: string[][] = []

  constructor(private readonly responses: readonly FakeResponse[]) {}

  async run(args: readonly string[], _options: GitRunOptions = {}): Promise<GitResult> {
    this.calls.push([...args])
    const response = this.responses.find((candidate) => candidate.args.join(" ") === args.join(" "))
    if (response === undefined) throw new Error(`unexpected git invocation: ${args.join(" ")}`)
    return {
      exitCode: 0,
      stdout: response.stdout,
      stderr: "",
      record: {
        id: this.calls.length,
        cwd: "/fake",
        args: [...args],
        startedAt: new Date(0).toISOString(),
        durationMs: 0,
        exitCode: 0,
        stdout: response.stdout,
        stderr: "",
      },
    }
  }
}

const revParseRepoPaths = [
  "rev-parse",
  "--path-format=absolute",
  "--show-toplevel",
  "--absolute-git-dir",
  "--git-common-dir",
  "--show-superproject-working-tree",
]

const revParseGitDir = (path: string): readonly string[] => [
  "-C",
  path,
  "rev-parse",
  "--path-format=absolute",
  "--absolute-git-dir",
]

describe("worktree porcelain parsing", () => {
  test("parses records separated by blank lines and strips the refs/heads prefix", () => {
    const raw = [
      "worktree /path/to/repo",
      "HEAD d85cc9d281fa6ae1665c68365fc70e75e82a042d",
      "branch refs/heads/feature/one",
      "",
      "worktree /path/to/detached",
      "HEAD 775955775e79b8f5b4c4b56f82fbf657e2d5e4de",
      "detached",
      "",
    ].join("\n")

    expect(parseWorktreeList(raw)).toEqual([
      { path: "/path/to/repo", head: "d85cc9d281fa6ae1665c68365fc70e75e82a042d", branch: "feature/one" },
      { path: "/path/to/detached", head: "775955775e79b8f5b4c4b56f82fbf657e2d5e4de" },
    ])
  })

  test("skips bare repositories, tolerates crlf, and ignores unknown attribute lines", () => {
    const raw = [
      "worktree /path/to/bare",
      "bare",
      "",
      "worktree /path/to/repo",
      "HEAD 775955775e79b8f5b4c4b56f82fbf657e2d5e4de",
      "branch refs/heads/master",
      "locked",
      "prunable gitdir file points to non-existent location",
      "",
    ].join("\r\n")

    expect(parseWorktreeList(raw)).toEqual([
      { path: "/path/to/repo", head: "775955775e79b8f5b4c4b56f82fbf657e2d5e4de", branch: "master" },
    ])
  })

  test("returns nothing for empty output", () => {
    expect(parseWorktreeList("")).toEqual([])
  })
})

describe("unique worktree names", () => {
  test("derives the shortest unambiguous suffix of each path", () => {
    expect(uniqueWorktreeNames([])).toEqual([])
    expect(uniqueWorktreeNames(["/my/path/feature/one"])).toEqual(["one"])
    expect(uniqueWorktreeNames(["/my/path/feature/one/"])).toEqual(["one"])
    expect(uniqueWorktreeNames(["/a/b/c/d", "/a/b/c/e", "/a/b/f/d", "/a/e/c/d"])).toEqual([
      "b/c/d",
      "e",
      "f/d",
      "e/c/d",
    ])
  })
})

describe("worktree loader", () => {
  let root: string | undefined
  afterEach(async () => {
    if (root !== undefined) await rm(root, { recursive: true, force: true })
    root = undefined
  })

  const createRoot = async (): Promise<string> => {
    root = await mkdtemp(join(tmpdir(), "githunk-worktrees-"))
    return root
  }

  test("marks the main and current worktree by git dir", async () => {
    const base = await createRoot()
    const repository = join(base, "repo")
    const linked = join(base, "linked")
    const repositoryGitDir = join(repository, ".git")
    const linkedGitDir = join(repositoryGitDir, "worktrees", "linked")
    await mkdir(linkedGitDir, { recursive: true })
    await mkdir(linked, { recursive: true })

    const runner = new FakeRunner([
      {
        args: revParseRepoPaths,
        stdout: `${repository}\n${repositoryGitDir}\n${repositoryGitDir}\n`,
      },
      {
        args: ["worktree", "list", "--porcelain"],
        stdout: [
          `worktree ${repository}`,
          "HEAD d85cc9d281fa6ae1665c68365fc70e75e82a042d",
          "branch refs/heads/master",
          "",
          `worktree ${linked}`,
          "HEAD 775955775e79b8f5b4c4b56f82fbf657e2d5e4de",
          "branch refs/heads/feature",
          "",
        ].join("\n"),
      },
      { args: revParseGitDir(repository), stdout: `${repositoryGitDir}\n` },
      { args: revParseGitDir(linked), stdout: `${linkedGitDir}\n` },
    ])

    const worktrees = await listWorktrees(runner)
    expect(worktrees).toEqual([
      {
        path: repository,
        gitDir: repositoryGitDir,
        name: "repo",
        branch: "master",
        head: "d85cc9d281fa6ae1665c68365fc70e75e82a042d",
        shortHead: "d85cc9d2",
        isMain: true,
        isCurrent: true,
        isPathMissing: false,
      },
      {
        path: linked,
        gitDir: linkedGitDir,
        name: "linked",
        branch: "feature",
        head: "775955775e79b8f5b4c4b56f82fbf657e2d5e4de",
        shortHead: "77595577",
        isMain: false,
        isCurrent: false,
        isPathMissing: false,
      },
    ])
  })

  test("moves the current worktree to the top when it is a linked worktree", async () => {
    const base = await createRoot()
    const repository = join(base, "repo")
    const linked = join(base, "linked")
    const repositoryGitDir = join(repository, ".git")
    const linkedGitDir = join(repositoryGitDir, "worktrees", "linked")
    await mkdir(linkedGitDir, { recursive: true })
    await mkdir(linked, { recursive: true })

    const runner = new FakeRunner([
      {
        args: revParseRepoPaths,
        stdout: `${linked}\n${linkedGitDir}\n${repositoryGitDir}\n`,
      },
      {
        args: ["worktree", "list", "--porcelain"],
        stdout: [
          `worktree ${repository}`,
          "HEAD d85cc9d281fa6ae1665c68365fc70e75e82a042d",
          "branch refs/heads/master",
          "",
          `worktree ${linked}`,
          "HEAD 775955775e79b8f5b4c4b56f82fbf657e2d5e4de",
          "branch refs/heads/feature",
          "",
        ].join("\n"),
      },
      { args: revParseGitDir(repository), stdout: `${repositoryGitDir}\n` },
      { args: revParseGitDir(linked), stdout: `${linkedGitDir}\n` },
    ])

    const worktrees = await listWorktrees(runner)
    expect(worktrees.map((worktree) => [worktree.name, worktree.isCurrent, worktree.isMain])).toEqual([
      ["linked", true, false],
      ["repo", false, true],
    ])
  })

  test("flags a worktree whose directory is gone without asking git about it", async () => {
    const base = await createRoot()
    const repository = join(base, "repo")
    const missing = join(base, "gone")
    const repositoryGitDir = join(repository, ".git")
    await mkdir(repositoryGitDir, { recursive: true })

    const runner = new FakeRunner([
      {
        args: revParseRepoPaths,
        stdout: `${repository}\n${repositoryGitDir}\n${repositoryGitDir}\n`,
      },
      {
        args: ["worktree", "list", "--porcelain"],
        stdout: [
          `worktree ${repository}`,
          "HEAD d85cc9d281fa6ae1665c68365fc70e75e82a042d",
          "branch refs/heads/master",
          "",
          `worktree ${missing}`,
          "HEAD 775955775e79b8f5b4c4b56f82fbf657e2d5e4de",
          "branch refs/heads/gone",
          "prunable gitdir file points to non-existent location",
          "",
        ].join("\n"),
      },
      { args: revParseGitDir(repository), stdout: `${repositoryGitDir}\n` },
    ])

    const worktrees = await listWorktrees(runner)
    expect(worktrees[1]).toEqual({
      path: missing,
      name: "gone",
      branch: "gone",
      head: "775955775e79b8f5b4c4b56f82fbf657e2d5e4de",
      shortHead: "77595577",
      isMain: false,
      isCurrent: false,
      isPathMissing: true,
    })
    expect(runner.calls.some((call) => call.includes(missing))).toBe(false)
  })

  test("keeps going when git cannot resolve a worktree git dir", async () => {
    const base = await createRoot()
    const repository = join(base, "repo")
    const repositoryGitDir = join(repository, ".git")
    await mkdir(repositoryGitDir, { recursive: true })

    const runner = new FakeRunner([
      {
        args: revParseRepoPaths,
        stdout: `${repository}\n${repositoryGitDir}\n${repositoryGitDir}\n`,
      },
      {
        args: ["worktree", "list", "--porcelain"],
        stdout: [
          `worktree ${repository}`,
          "HEAD d85cc9d281fa6ae1665c68365fc70e75e82a042d",
          "branch refs/heads/master",
          "",
        ].join("\n"),
      },
    ])

    const worktrees = await listWorktrees(runner)
    expect(worktrees[0]).toMatchObject({ name: "repo", isCurrent: true, isMain: true, isPathMissing: false })
    expect(worktrees[0]!.gitDir).toBeUndefined()
  })

  test("recovers the branch of a rebasing or bisecting worktree from its git dir", async () => {
    const base = await createRoot()
    const repository = join(base, "repo")
    const rebasing = join(base, "rebasing")
    const bisecting = join(base, "bisecting")
    const repositoryGitDir = join(repository, ".git")
    const rebasingGitDir = join(repositoryGitDir, "worktrees", "rebasing")
    const bisectingGitDir = join(repositoryGitDir, "worktrees", "bisecting")
    await mkdir(join(rebasingGitDir, "rebase-merge"), { recursive: true })
    await mkdir(bisectingGitDir, { recursive: true })
    await mkdir(rebasing, { recursive: true })
    await mkdir(bisecting, { recursive: true })
    await writeFile(join(rebasingGitDir, "rebase-merge", "head-name"), "refs/heads/wip\n", "utf8")
    await writeFile(join(bisectingGitDir, "BISECT_START"), "hunted\n", "utf8")

    const runner = new FakeRunner([
      {
        args: revParseRepoPaths,
        stdout: `${repository}\n${repositoryGitDir}\n${repositoryGitDir}\n`,
      },
      {
        args: ["worktree", "list", "--porcelain"],
        stdout: [
          `worktree ${repository}`,
          "HEAD d85cc9d281fa6ae1665c68365fc70e75e82a042d",
          "branch refs/heads/master",
          "",
          `worktree ${rebasing}`,
          "HEAD 775955775e79b8f5b4c4b56f82fbf657e2d5e4de",
          "detached",
          "",
          `worktree ${bisecting}`,
          "HEAD 775955775e79b8f5b4c4b56f82fbf657e2d5e4de",
          "detached",
          "",
        ].join("\n"),
      },
      { args: revParseGitDir(repository), stdout: `${repositoryGitDir}\n` },
      { args: revParseGitDir(rebasing), stdout: `${rebasingGitDir}\n` },
      { args: revParseGitDir(bisecting), stdout: `${bisectingGitDir}\n` },
    ])

    const worktrees = await listWorktrees(runner)
    expect(worktrees.map((worktree) => [worktree.name, worktree.branch])).toEqual([
      ["repo", "master"],
      ["rebasing", "wip"],
      ["bisecting", "hunted"],
    ])
  })
})
