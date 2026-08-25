import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import {
  submoduleDepth,
  submoduleFullName,
  submoduleFullPath,
  submoduleGitDirPath,
  type SubmoduleConfig,
} from "../../src/domain/submodule"
import type { GitResult, GitRunOptions } from "../../src/git/runner"
import { listSubmodules, parseGitModules, readSubmoduleConfigs } from "../../src/git/submodules"

class FakeRunner {
  readonly calls: string[][] = []

  constructor(private readonly stdout: string) {}

  async run(args: readonly string[], _options: GitRunOptions = {}): Promise<GitResult> {
    this.calls.push([...args])
    return {
      exitCode: 0,
      stdout: this.stdout,
      stderr: "",
      record: {
        id: this.calls.length,
        cwd: "/fake",
        args: [...args],
        startedAt: new Date(0).toISOString(),
        durationMs: 0,
        exitCode: 0,
        stdout: this.stdout,
        stderr: "",
      },
    }
  }
}

describe("gitmodules parsing", () => {
  test("reads name, path and url out of each section", () => {
    const raw = [
      "[submodule \"mysubmodule\"]",
      "\tpath = blah/mysubmodule",
      "\turl = git@github.com:subbo.git",
      "[submodule \"other module\"]",
      "  path=other",
      "  url=https://example.invalid/other.git",
      "",
    ].join("\n")

    expect(parseGitModules(raw)).toEqual([
      { name: "mysubmodule", path: "blah/mysubmodule", url: "git@github.com:subbo.git" },
      { name: "other module", path: "other", url: "https://example.invalid/other.git" },
    ])
  })

  test("ignores stray lines, keeps sections without a path, and tolerates crlf", () => {
    const raw = ["# a comment", "path = orphan", "[submodule \"nameonly\"]", "\tbranch = main", ""].join("\r\n")
    expect(parseGitModules(raw)).toEqual([{ name: "nameonly", path: "" }])
  })

  test("returns nothing for an empty file", () => {
    expect(parseGitModules("")).toEqual([])
  })
})

describe("submodule identity helpers", () => {
  test("chains name, path, depth and git dir through the parent modules", () => {
    const parent: SubmoduleConfig = { name: "libs/mid", path: "libs/mid", url: "https://example.invalid/mid.git" }
    const child: SubmoduleConfig = { name: "vendor/inner", path: "vendor/inner", parentModule: parent }
    expect(submoduleFullName(parent)).toBe("libs/mid")
    expect(submoduleFullName(child)).toBe("libs/mid/vendor/inner")
    expect(submoduleFullPath(child)).toBe("libs/mid/vendor/inner")
    expect(submoduleDepth(parent)).toBe(0)
    expect(submoduleDepth(child)).toBe(1)
    expect(submoduleGitDirPath("/repo/.git", child)).toBe("/repo/.git/modules/libs/mid/modules/vendor/inner")
  })
})

describe("submodule loader", () => {
  let root: string | undefined
  afterEach(async () => {
    if (root !== undefined) await rm(root, { recursive: true, force: true })
    root = undefined
  })

  const createTree = async (files: Record<string, string>): Promise<string> => {
    root = await mkdtemp(join(tmpdir(), "githunk-submodules-"))
    for (const [relativePath, content] of Object.entries(files)) {
      const target = join(root, relativePath)
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, content, "utf8")
    }
    return root
  }

  test("treats a repository without .gitmodules as having no submodules", async () => {
    const base = await createTree({ "file.txt": "hi\n" })
    expect(await readSubmoduleConfigs(base)).toEqual([])
  })

  test("reads one submodule", async () => {
    const base = await createTree({
      ".gitmodules": "[submodule \"vendor/lib\"]\n\tpath = vendor/lib\n\turl = ../lib.git\n",
    })
    expect(await readSubmoduleConfigs(base)).toEqual([
      { name: "vendor/lib", path: "vendor/lib", url: "../lib.git" },
    ])
  })

  test("recurses into nested submodules and records the parent chain", async () => {
    const base = await createTree({
      ".gitmodules": "[submodule \"libs/mid\"]\n\tpath = libs/mid\n\turl = ../mid.git\n[submodule \"tools\"]\n\tpath = tools\n\turl = ../tools.git\n",
      "libs/mid/.gitmodules": "[submodule \"vendor/inner\"]\n\tpath = vendor/inner\n\turl = ../inner.git\n",
      "libs/mid/vendor/inner/.gitmodules": "[submodule \"deepest\"]\n\tpath = deepest\n\turl = ../deepest.git\n",
    })

    const submodules = await readSubmoduleConfigs(base)
    expect(submodules.map((submodule) => [submoduleFullName(submodule), submoduleDepth(submodule)])).toEqual([
      ["libs/mid", 0],
      ["libs/mid/vendor/inner", 1],
      ["libs/mid/vendor/inner/deepest", 2],
      ["tools", 0],
    ])

    const inner = submodules[1]!
    expect(inner.parentModule).toEqual(submodules[0]!)
    expect(inner.parentModule?.url).toBe("../mid.git")
    expect(submoduleFullPath(submodules[2]!)).toBe("libs/mid/vendor/inner/deepest")
  })

  test("does not follow a submodule that points at its own directory", async () => {
    const base = await createTree({ ".gitmodules": "[submodule \"self\"]\n\tpath = .\n\turl = ../self.git\n" })
    expect(await readSubmoduleConfigs(base)).toEqual([{ name: "self", path: ".", url: "../self.git" }])
  })

  test("resolves the worktree of the runner before reading .gitmodules", async () => {
    const base = await createTree({
      ".gitmodules": "[submodule \"vendor/lib\"]\n\tpath = vendor/lib\n\turl = ../lib.git\n",
    })
    const runner = new FakeRunner(`${base}\n`)
    expect(await listSubmodules(runner)).toEqual([{ name: "vendor/lib", path: "vendor/lib", url: "../lib.git" }])
    expect(runner.calls).toEqual([["rev-parse", "--path-format=absolute", "--show-toplevel"]])
  })
})
