import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AppController } from "../../src/app/controller"
import { GitRunner, GitCommandError } from "../../src/git/runner"
import { parseDiff } from "../../src/domain/diff/parse"
import { createTempRepository, type TempRepository } from "../helpers/temp-repository"

type GitResult = { readonly exitCode: number; readonly stdout: string; readonly stderr: string }

async function git(cwd: string, args: readonly string[], stdin?: string): Promise<GitResult> {
  const processHandle = Bun.spawn(["git", ...args], {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Githunk Acceptance",
      GIT_AUTHOR_EMAIL: "githunk-acceptance@example.invalid",
      GIT_COMMITTER_NAME: "Githunk Acceptance",
      GIT_COMMITTER_EMAIL: "githunk-acceptance@example.invalid",
      GIT_TERMINAL_PROMPT: "0",
    },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  })
  if (stdin !== undefined) processHandle.stdin.write(stdin)
  processHandle.stdin.end()
  const [stdout, stderr, exitCode] = await Promise.all([
    Bun.readableStreamToText(processHandle.stdout),
    Bun.readableStreamToText(processHandle.stderr),
    processHandle.exited,
  ])
  return { exitCode, stdout, stderr }
}

async function expectGit(cwd: string, args: readonly string[]): Promise<GitResult> {
  const result = await git(cwd, args)
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`)
  return result
}

async function commit(repository: TempRepository, path: string, content: string, message: string): Promise<string> {
  await repository.write(path, content)
  await repository.git(["add", "--", path])
  const created = await repository.git(["commit", "--quiet", "-m", message])
  if (created.exitCode !== 0) throw new Error(created.stderr)
  return (await repository.git(["rev-parse", "HEAD"])).stdout.trim()
}

describe("v0.1 review workflow acceptance", () => {
  let barePath: string | undefined
  let clonePath: string | undefined
  let seed: TempRepository | undefined

  afterEach(async () => {
    await seed?.cleanup()
    if (clonePath !== undefined) await rm(clonePath, { recursive: true, force: true })
    if (barePath !== undefined) await rm(barePath, { recursive: true, force: true })
    seed = undefined
    clonePath = undefined
    barePath = undefined
  })

  test("drives the complete repository review workflow against real git state", async () => {
    barePath = await mkdtemp(join(tmpdir(), "githunk-acceptance-remote-"))
    await expectGit(barePath, ["init", "--bare", "--quiet"])
    seed = await createTempRepository()
    await expectGit(seed.path, ["branch", "-M", "main"])
    const baseOid = await commit(seed, "story.txt", "base\n", "base")
    await expectGit(seed.path, ["remote", "add", "origin", barePath])
    await expectGit(seed.path, ["push", "--quiet", "origin", "main"])
    await expectGit(seed.path, ["switch", "-c", "agent"])
    await commit(seed, "story.txt", "base\nagent one\n", "agent: first change")
    const secondAgentOid = await commit(seed, "notes.txt", "agent two\n", "agent: second change")
    await expectGit(seed.path, ["push", "--quiet", "origin", "agent"])
    await expectGit(barePath, ["symbolic-ref", "HEAD", "refs/heads/main"])

    clonePath = join(await mkdtemp(join(tmpdir(), "githunk-acceptance-clone-parent-")), "under-test")
    await expectGit(join(clonePath, ".."), ["clone", "--quiet", "--branch", "agent", barePath, clonePath])
    await expectGit(clonePath, ["config", "user.name", "Githunk Acceptance"])
    await expectGit(clonePath, ["config", "user.email", "githunk-acceptance@example.invalid"])

    const runner = new GitRunner({ cwd: clonePath })
    const controller = new AppController(runner)
    await writeFile(join(clonePath, "story.txt"), "base\nagent one\nstaged line\n")
    await expectGit(clonePath, ["add", "--", "story.txt"])
    await writeFile(join(clonePath, "story.txt"), "base\nagent one\nstaged line\nunstaged line\n")
    await writeFile(join(clonePath, "untracked.txt"), "new file\n")

    await controller.refresh()
    expect(controller.state.reviewTarget).toEqual({ kind: "working-tree", scope: "all" })
    expect(controller.state.title).toBe("Working Tree — All")
    expect(controller.state.files.map((file) => file.path)).toEqual(["story.txt", "untracked.txt"])
    const stagedPatch = controller.state.patches.find((patch) => patch.label === "STAGED")?.text ?? ""
    const unstagedPatch = controller.state.patches.find((patch) => patch.label === "UNSTAGED")?.text ?? ""
    expect(stagedPatch).toBe((await expectGit(clonePath, ["diff", "--cached", "--no-ext-diff", "--no-color", "--find-renames", "--binary", "--"])).stdout)
    const expectedUnstaged = (await expectGit(clonePath, ["diff", "--no-ext-diff", "--no-color", "--find-renames", "--binary", "--"])).stdout
    const expectedUntracked = (await git(clonePath, ["diff", "--no-index", "--no-ext-diff", "--no-color", "--binary", "--", "/dev/null", "untracked.txt"])).stdout
    expect(unstagedPatch).toBe(expectedUnstaged + expectedUntracked)

    controller.selectFile("story.txt")
    await controller.markFileReviewed("story.txt")
    expect(controller.state.reviewStatuses?.["story.txt"]).toBe("reviewed")
    await writeFile(join(clonePath, "story.txt"), "base\nagent one\nstaged line\nunstaged line\nexternal change\n")
    await controller.refresh()
    expect(controller.state.reviewStatuses?.["story.txt"]).toBe("changed-after-review")
    expect(controller.state.reviewSummary?.invalidated).toBe(1)

    const currentUnstaged = controller.state.patches.find((patch) => patch.label === "UNSTAGED")?.text ?? ""
    const document = parseDiff(currentUnstaged)
    const selectedLine = document.lines.findIndex((line) => line.raw === "+unstaged line\n")
    expect(selectedLine).toBeGreaterThanOrEqual(0)
    await controller.applySelection(document, [selectedLine], { reverse: false, wholeFile: false })
    expect((await expectGit(clonePath, ["diff", "--cached", "--", "story.txt"])).stdout).toContain("+unstaged line")
    await controller.commit("acceptance staged selection")
    expect((await expectGit(clonePath, ["log", "-1", "--format=%s"])).stdout.trim()).toBe("acceptance staged selection")
    expect((await expectGit(clonePath, ["diff", "--", "story.txt"])).stdout).toContain("+external change")

    await controller.createStash("acceptance stash", { includeUntracked: true })
    expect(controller.state.stashes?.length).toBe(1)
    const stashRef = controller.state.stashes?.[0]?.ref
    expect(stashRef).toBeDefined()
    await controller.inspectStash(stashRef!)
    expect(controller.state.reviewTarget.kind).toBe("stash")
    expect(controller.state.title).toMatch(/^Stash — /)
    expect(controller.state.patches[0]?.text).toContain("external change")
    await controller.setWorkingTreeScope("all")
    expect(controller.state.title).toBe("Working Tree — All")
    await controller.applyStash(stashRef!)
    expect(await readFile(join(clonePath, "untracked.txt"), "utf8")).toBe("new file\n")
    await controller.discardFile("story.txt")
    await controller.discardFile("untracked.txt", true)
    await controller.refresh()
    expect((await expectGit(clonePath, ["status", "--porcelain"])).stdout).toBe("")
    await controller.popStash(stashRef!)
    expect((await expectGit(clonePath, ["status", "--porcelain"])).stdout).toContain("story.txt")
    expect(await readFile(join(clonePath, "untracked.txt"), "utf8")).toBe("new file\n")
    await controller.discardFile("story.txt")
    await controller.discardFile("untracked.txt", true)
    await controller.refresh()
    await writeFile(join(clonePath, "drop-me.txt"), "drop\n")
    await controller.createStash("drop me", { includeUntracked: true })
    const dropRef = controller.state.stashes?.[0]?.ref
    expect(dropRef).toBeDefined()
    await controller.dropStash(dropRef!, { confirmed: true })
    expect(controller.state.stashes?.some((stash) => stash.ref === dropRef)).toBe(false)
    expect((await expectGit(clonePath, ["status", "--porcelain"])).stdout).toBe("")

    await controller.switchMode("branch")
    if (controller.state.basePicker !== undefined) await controller.setBranchBase("origin/main")
    const branchTarget = controller.state.reviewTarget
    expect(branchTarget.kind).toBe("branch")
    if (branchTarget.kind !== "branch") throw new Error("expected Branch Review target")
    expect(branchTarget.baseRef).toBe("refs/remotes/origin/main")
    expect(controller.state.title).toBe(`agent vs ${branchTarget.baseRef}`)
    expect(controller.state.reviewSummary?.commits).toBe(3)
    expect((controller.state.commits ?? []).length).toBe(3)
    expect(controller.state.files.map((file) => file.path)).toEqual(["notes.txt", "story.txt"])
    expect(controller.state.patches[0]?.text).toContain("agent one")
    const commitOid = (controller.state.commits ?? [])[0]?.oid
    expect(commitOid).toBeDefined()
    await controller.selectCommit(commitOid!)
    const commitTarget = controller.state.reviewTarget as { readonly kind: "commit"; readonly oid: string }
    expect(commitTarget.kind).toBe("commit")
    expect(commitTarget).toEqual({ kind: "commit", oid: commitOid! })
    expect(controller.state.title).toBe(`Commit — ${commitOid}`)
    expect(controller.state.patches[0]?.text.length).toBeGreaterThan(0)
    await controller.navigateBack()
    const branchAfterBack = controller.state.reviewTarget as { readonly kind: "branch"; readonly baseRef: string }
    expect(branchAfterBack.kind).toBe("branch")
    expect(controller.state.title).toBe(`agent vs ${branchAfterBack.baseRef}`)

    const checkout = await controller.checkoutRemoteTracking({ remote: "origin", branch: "main" })
    expect(checkout).toEqual({ kind: "created", localBranch: "main", remoteRef: "origin/main" })
    expect((await expectGit(clonePath, ["branch", "--show-current"])).stdout.trim()).toBe("main")
    await controller.setWorkingTreeScope("all")
    expect(controller.state.title).toBe("Working Tree — All")
    await controller.fetch("origin")
    await controller.pull()
    await controller.push()
    expect((await expectGit(clonePath, ["rev-parse", "HEAD"])).stdout.trim()).toBe(baseOid)
    await expect(controller.fetch("missing-remote")).rejects.toBeInstanceOf(GitCommandError)
    expect(controller.state.banner).toBeTruthy()
    const failedCommand = controller.state.commandLog.at(-1)
    expect(failedCommand?.args).toEqual(["fetch", "missing-remote"])
    expect(failedCommand?.exitCode).not.toBe(0)
    expect(secondAgentOid).toMatch(/^[0-9a-f]{40}$/)
  })
})
