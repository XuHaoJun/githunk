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

function patchFromShow(raw: string): string {
  const match = /(?:^|\n)(diff --(?:git|cc) )/.exec(raw)
  if (match === null || match.index === undefined) return ""
  return raw.slice(match.index + (match[0].startsWith("\n") ? 1 : 0))
}

async function trackedDiff(cwd: string, cached: boolean): Promise<string> {
  return (await expectGit(cwd, [
    "diff",
    ...(cached ? ["--cached"] : []),
    "--no-ext-diff",
    "--no-color",
    "--find-renames",
    "--binary",
    "--",
  ])).stdout
}

async function untrackedDiff(cwd: string, path: string): Promise<string> {
  return (await git(cwd, ["diff", "--no-index", "--no-ext-diff", "--no-color", "--binary", "--", "/dev/null", path])).stdout
}

describe("v0.1 review workflow acceptance", () => {
  let barePath: string | undefined
  let cloneParentPath: string | undefined
  let clonePath: string | undefined
  let seed: TempRepository | undefined
  afterEach(async () => {
    await seed?.cleanup()
    if (cloneParentPath !== undefined) await rm(cloneParentPath, { recursive: true, force: true })
    if (barePath !== undefined) await rm(barePath, { recursive: true, force: true })
    seed = undefined
    cloneParentPath = undefined
    clonePath = undefined
    barePath = undefined
  })

  test("drives the complete repository review workflow against real git state", async () => {
    barePath = await mkdtemp(join(tmpdir(), "githunk-acceptance-remote-"))
    await expectGit(barePath, ["init", "--bare", "--quiet"])
    seed = await createTempRepository()
    await expectGit(seed.path, ["branch", "-M", "main"])
    await commit(seed, "story.txt", "base\n", "base")
    await expectGit(seed.path, ["remote", "add", "origin", barePath])
    await expectGit(seed.path, ["push", "--quiet", "origin", "main"])
    await expectGit(seed.path, ["switch", "-c", "agent"])
    await commit(seed, "story.txt", "base\nagent one\n", "agent: first change")
    const secondAgentOid = await commit(seed, "notes.txt", "agent two\n", "agent: second change")
    await expectGit(seed.path, ["push", "--quiet", "origin", "agent"])
    await expectGit(barePath, ["symbolic-ref", "HEAD", "refs/heads/main"])

    cloneParentPath = await mkdtemp(join(tmpdir(), "githunk-acceptance-clone-parent-"))
    clonePath = join(cloneParentPath, "under-test")
    await expectGit(cloneParentPath, ["clone", "--quiet", "--branch", "agent", barePath, clonePath])
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
    const stagedPatch = controller.state.patches.find((patch) => patch.label === "STAGED")?.text ?? ""
    const unstagedPatch = controller.state.patches.find((patch) => patch.label === "UNSTAGED")?.text ?? ""
    expect(stagedPatch).toBe(await trackedDiff(clonePath, true))
    expect(unstagedPatch).toBe((await trackedDiff(clonePath, false)) + (await untrackedDiff(clonePath, "untracked.txt")))

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
    expect(controller.state.patches.find((patch) => patch.label === "STAGED")?.text).toBe(await trackedDiff(clonePath, true))
    expect(controller.state.patches.find((patch) => patch.label === "UNSTAGED")?.text).toBe((await trackedDiff(clonePath, false)) + (await untrackedDiff(clonePath, "untracked.txt")))

    const stagedAfterSelect = parseDiff(controller.state.patches.find((patch) => patch.label === "STAGED")?.text ?? "")
    const reverseLine = stagedAfterSelect.lines.findIndex((line) => line.raw === "+unstaged line\n")
    expect(reverseLine).toBeGreaterThanOrEqual(0)
    await controller.applySelection(stagedAfterSelect, [reverseLine], { reverse: true, wholeFile: false })
    expect(controller.state.patches.find((patch) => patch.label === "STAGED")?.text).toBe(await trackedDiff(clonePath, true))
    expect(controller.state.patches.find((patch) => patch.label === "UNSTAGED")?.text).toBe((await trackedDiff(clonePath, false)) + (await untrackedDiff(clonePath, "untracked.txt")))
    const restageDocument = parseDiff(controller.state.patches.find((patch) => patch.label === "UNSTAGED")?.text ?? "")
    const restageLine = restageDocument.lines.findIndex((line) => line.raw === "+unstaged line\n")
    expect(restageLine).toBeGreaterThanOrEqual(0)
    await controller.applySelection(restageDocument, [restageLine], { reverse: false, wholeFile: false })
    expect(controller.state.patches.find((patch) => patch.label === "STAGED")?.text).toBe(await trackedDiff(clonePath, true))
    expect(controller.state.patches.find((patch) => patch.label === "UNSTAGED")?.text).toBe((await trackedDiff(clonePath, false)) + (await untrackedDiff(clonePath, "untracked.txt")))

    await controller.commit("acceptance staged selection")
    const committedOid = (await expectGit(clonePath, ["rev-parse", "HEAD"])).stdout.trim()
    expect((await expectGit(clonePath, ["log", "-1", "--format=%s"])).stdout.trim()).toBe("acceptance staged selection")
    expect((await expectGit(clonePath, ["diff", "--", "story.txt"])).stdout).toContain("+external change")
    await controller.amend("acceptance amended selection")
    const amendedOid = (await expectGit(clonePath, ["rev-parse", "HEAD"])).stdout.trim()
    expect(amendedOid).toMatch(/^[0-9a-f]{40}$/)
    expect(amendedOid).not.toBe(committedOid)
    expect((await expectGit(clonePath, ["log", "-1", "--format=%s"])).stdout.trim()).toBe("acceptance amended selection")

    await controller.createStash("acceptance stash", { includeUntracked: true })
    const stashEntriesAfterFirst = controller.state.stashes ?? []
    expect(stashEntriesAfterFirst.length).toBe(1)
    const stashRef = stashEntriesAfterFirst[0]?.ref
    const stashOid = stashEntriesAfterFirst[0]?.oid
    expect(stashRef).toBeDefined()
    expect(stashOid).toMatch(/^[0-9a-f]{40}$/)
    await writeFile(join(clonePath, "drop-me.txt"), "drop\n")
    await controller.createStash("drop me", { includeUntracked: true })
    const dropRef = controller.state.stashes?.[0]?.ref
    expect(dropRef).toBeDefined()
    expect(controller.state.stashes?.length).toBe(2)
    await controller.inspectStash(stashOid!)
    const stashTarget = controller.state.reviewTarget as { readonly kind: "stash"; readonly ref: string }
    expect(stashTarget).toEqual({ kind: "stash", ref: stashOid! })
    expect(controller.state.title).toBe(`Stash — ${stashOid}`)
    expect(controller.state.patches[0]?.text).toBe((await expectGit(clonePath, ["stash", "show", "--patch", "--no-color", "--binary", "--include-untracked", stashOid!])).stdout)
    await controller.dropStash(dropRef!, { confirmed: true })
    const targetAfterUnrelatedDrop = controller.state.reviewTarget as { readonly kind: "stash"; readonly ref: string }
    expect(targetAfterUnrelatedDrop).toEqual(stashTarget)
    expect(controller.state.stashes?.map((stash) => stash.oid ?? "") ?? []).toEqual([stashOid!])
    await controller.setWorkingTreeScope("all")
    expect(controller.state.title).toBe("Working Tree — All")
    await controller.applyStash(stashRef!)
    expect(controller.state.stashes?.map((stash) => stash.oid ?? "") ?? []).toEqual([stashOid!])
    expect((await expectGit(clonePath, ["status", "--porcelain"])).stdout).toBe(" M story.txt\n?? untracked.txt\n")
    expect(await readFile(join(clonePath, "untracked.txt"), "utf8")).toBe("new file\n")
    await controller.discardFile("story.txt")
    await controller.discardFile("untracked.txt", true)
    await controller.refresh()
    expect((await expectGit(clonePath, ["status", "--porcelain"])).stdout).toBe("")
    await controller.popStash(stashRef!)
    expect(controller.state.stashes?.length).toBe(0)
    expect((await expectGit(clonePath, ["status", "--porcelain"])).stdout).toBe(" M story.txt\n?? untracked.txt\n")
    expect(await readFile(join(clonePath, "untracked.txt"), "utf8")).toBe("new file\n")
    await controller.discardFile("story.txt")
    await controller.discardFile("untracked.txt", true)
    await controller.refresh()
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
    const aggregatePatch = (await expectGit(clonePath, ["diff", "--no-ext-diff", "--no-color", "--find-renames", "--binary", `${branchTarget.baseRef}...HEAD`, "--"])).stdout
    expect(controller.state.patches[0]?.text).toBe(aggregatePatch)
    const aggregateFiles = controller.state.files
    const commitOid = (controller.state.commits ?? [])[0]?.oid
    expect(commitOid).toBeDefined()
    const details = await controller.loadCommitInspection(commitOid!)
    expect(details.oid).toBe(commitOid!)
    expect(controller.state.reviewTarget.kind).not.toBe("commit")
    expect(controller.state.files).toEqual(aggregateFiles)
    expect(controller.state.patches[0]?.text).toBe(aggregatePatch)


    const checkout = await controller.checkoutRemoteTracking({ remote: "origin", branch: "main" })
    expect(checkout).toEqual({ kind: "created", localBranch: "main", remoteRef: "origin/main" })
    expect((await expectGit(clonePath, ["branch", "--show-current"])).stdout.trim()).toBe("main")
    expect((await expectGit(clonePath, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"])).stdout.trim()).toBe("origin/main")
    await controller.setWorkingTreeScope("all")
    expect(controller.state.title).toBe("Working Tree — All")

    await expectGit(seed.path, ["switch", "main"])
    const remoteAheadOid = await commit(seed, "remote.txt", "remote ahead\n", "remote ahead")
    await expectGit(seed.path, ["push", "--quiet", "origin", "main"])
    await controller.fetch("origin")
    expect((await expectGit(clonePath, ["rev-parse", "refs/remotes/origin/main"])).stdout.trim()).toBe(remoteAheadOid)
    expect(controller.state.commandLog.findLast((record) => record.args.join(" ") === "fetch origin" && record.exitCode === 0)).toBeDefined()
    await controller.pull()
    expect((await expectGit(clonePath, ["rev-parse", "HEAD"])).stdout.trim()).toBe(remoteAheadOid)
    expect(controller.state.commandLog.findLast((record) => record.args.join(" ") === "pull" && record.exitCode === 0)).toBeDefined()

    await writeFile(join(clonePath, "sync-local.txt"), "local push\n")
    await controller.refresh()
    await controller.stageFile("sync-local.txt")
    await controller.commit("local push")
    const localPushOid = (await expectGit(clonePath, ["rev-parse", "HEAD"])).stdout.trim()
    await controller.push()
    expect((await expectGit(barePath, ["rev-parse", "refs/heads/main"])).stdout.trim()).toBe(localPushOid)
    expect(controller.state.commandLog.findLast((record) => record.args.join(" ") === "push" && record.exitCode === 0)).toBeDefined()

    const viewBeforeFailure = {
      title: controller.state.title,
      reviewTarget: controller.state.reviewTarget,
      files: controller.state.files,
      patches: controller.state.patches,
      commandLogLength: controller.state.commandLog.length,
    }
    await expect(controller.fetch("missing-remote")).rejects.toBeInstanceOf(GitCommandError)
    expect(controller.state.title).toBe(viewBeforeFailure.title)
    expect(controller.state.reviewTarget).toEqual(viewBeforeFailure.reviewTarget)
    expect(controller.state.files).toEqual(viewBeforeFailure.files)
    expect(controller.state.patches).toEqual(viewBeforeFailure.patches)
    expect(controller.state.commandLog.length).toBeGreaterThan(viewBeforeFailure.commandLogLength)
    expect(controller.state.banner).toBeTruthy()
    const failedCommand = controller.state.commandLog.at(-1)
    expect(failedCommand?.args).toEqual(["fetch", "missing-remote"])
    expect(failedCommand?.exitCode).not.toBe(0)
    expect(secondAgentOid).toMatch(/^[0-9a-f]{40}$/)
  })
})
