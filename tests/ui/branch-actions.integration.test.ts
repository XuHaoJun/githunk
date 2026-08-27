import { afterEach, describe, expect, test } from "bun:test"
import { createShellHarness, type ShellHarness } from "../helpers/shell-harness"

async function seedRemoteBranch(repository: ShellHarness["repository"], remote: ShellHarness["fetchBare"]): Promise<void> {
  if (remote === undefined) throw new Error("test remote was not created")
  await repository.write("base.txt", "base\n")
  await repository.git(["add", "base.txt"])
  await repository.git(["commit", "-m", "base"])
  await remote.git(["config", "core.bare", "true"])
  await repository.git(["remote", "add", "origin", remote.path])
  await repository.git(["push", "origin", "master:feature/foo"])
  await repository.git(["fetch", "origin"])
}

async function seedTwoRemoteBranches(repository: ShellHarness["repository"], remote: ShellHarness["fetchBare"]): Promise<void> {
  await seedRemoteBranch(repository, remote)
  await repository.git(["push", "origin", "master:feature/bar"])
  await repository.git(["fetch", "origin"])
}


async function seedTrackedRemoteBranch(repository: ShellHarness["repository"], remote: ShellHarness["fetchBare"]): Promise<void> {
  await seedRemoteBranch(repository, remote)
  await repository.git(["branch", "--track", "feature/foo", "origin/feature/foo"])
}

async function seedLinkedWorktree(repository: ShellHarness["repository"]): Promise<void> {
  await repository.write("base.txt", "base\n")
  await repository.git(["add", "base.txt"])
  await repository.git(["commit", "-m", "base"])
  await repository.git(["worktree", "add", "wt-feature", "-b", "feature"])
}

async function seedDirtyRemoteBranch(repository: ShellHarness["repository"], remote: ShellHarness["fetchBare"]): Promise<void> {
  if (remote === undefined) throw new Error("test remote was not created")
  await repository.write("base.txt", "base\n")
  await repository.git(["add", "base.txt"])
  await repository.git(["commit", "-m", "base"])
  await remote.git(["config", "core.bare", "true"])
  await repository.git(["remote", "add", "origin", remote.path])
  await repository.git(["switch", "-c", "feature"])
  await repository.write("base.txt", "remote\n")
  await repository.git(["add", "base.txt"])
  await repository.git(["commit", "-m", "remote branch"])
  await repository.git(["push", "origin", "feature"])
  await repository.git(["switch", "master"])
  await repository.git(["branch", "-D", "feature"])
  await repository.write("base.txt", "dirty\n")
  await repository.git(["fetch", "origin"])
}

async function seedDirtyLinkedWorktree(repository: ShellHarness["repository"]): Promise<void> {
  await seedLinkedWorktree(repository)
  await repository.write("wt-feature/dirty.txt", "dirty\n")
}

async function seedUntrackedOverwriteRemoteBranch(repository: ShellHarness["repository"], remote: ShellHarness["fetchBare"]): Promise<void> {
  if (remote === undefined) throw new Error("test remote was not created")
  await repository.write("base.txt", "base\n")
  await repository.git(["add", "base.txt"])
  await repository.git(["commit", "-m", "base"])
  await remote.git(["config", "core.bare", "true"])
  await repository.git(["remote", "add", "origin", remote.path])
  await repository.git(["switch", "-c", "feature"])
  await repository.write("overwritten.txt", "remote\n")
  await repository.git(["add", "overwritten.txt"])
  await repository.git(["commit", "-m", "remote branch"])
  await repository.git(["push", "origin", "feature"])
  await repository.git(["switch", "master"])
  await repository.git(["branch", "-D", "feature"])
  await repository.write("overwritten.txt", "untracked\n")
  await repository.git(["fetch", "origin"])
}
describe("branch action parity", () => {
  let harness: ShellHarness | undefined

  afterEach(async () => {
    await harness?.cleanup()
    harness = undefined
  })

  test("delete opens lazygit's local remote and both choices", async () => {
    harness = await createShellHarness()

    await harness.pressKey("3")
    await harness.pressKey("d")

    const frame = harness.frame()
    expect(frame).toContain("Delete branch 'master'?")
    expect(frame).toContain("Delete local branch")
    expect(frame).toContain("Delete remote branch")
    expect(frame).toContain("Delete local and remote branch")
  })

  test("branch checked out in another worktree offers remove and detach choices", async () => {
    harness = await createShellHarness({ setup: seedLinkedWorktree })

    await harness.pressKey("3")
    await harness.pressKey("j")
    await harness.pressKey("d")
    await harness.pressKey("c")

    expect(harness.frame()).toContain("Remove worktree and delete branch")
    expect(harness.frame()).toContain("Detach worktree and delete branch")
  })

  test("remove worktree choice removes the worktree and branch", async () => {
    harness = await createShellHarness({ setup: seedLinkedWorktree })

    await harness.pressKey("3")
    await harness.pressKey("j")
    await harness.pressKey("d")
    await harness.pressKey("c")
    await harness.pressKey("r")
    await harness.settle()

    expect((await harness.repository.git(["worktree", "list", "--porcelain"])).stdout).not.toContain("wt-feature")
    expect((await harness.repository.git(["branch", "--list", "feature"])).stdout).not.toContain("feature")
    expect(harness.app.view!.renderedListText("branches")).not.toContain("feature")
  })

  test("dirty worktree removal asks before forcing the removal", async () => {
    harness = await createShellHarness({ setup: seedDirtyLinkedWorktree })

    await harness.pressKey("3")
    await harness.pressKey("j")
    await harness.pressKey("d")
    await harness.pressKey("c")
    await harness.pressKey("r")
    // The "Remove worktree" confirmation appears after the `git worktree remove`
    // attempt fails with `worktreeRemovalRequiresForce` — an async subprocess.
    // `pressKey("r")` only flushes the renderer, so the promise may not have
    // settled yet. Wait for the mutation to finish (which opens the popup) before
    // asserting its contents, mirroring the `settle()` the test already does after
    // confirming the popup.
    await harness.settle()

    expect(harness.frame()).toContain("Remove worktree")
    expect(harness.frame()).toContain("modified or untracked")

    await harness.pressKey("RETURN")
    await harness.settle()
    expect((await harness.repository.git(["worktree", "list", "--porcelain"])).stdout).not.toContain("wt-feature")
    expect((await harness.repository.git(["branch", "--list", "feature"])).stdout).not.toContain("feature")
  })

  test("detach worktree choice frees and deletes the branch while keeping the worktree", async () => {
    harness = await createShellHarness({ setup: seedLinkedWorktree })

    await harness.pressKey("3")
    await harness.pressKey("j")
    await harness.pressKey("d")
    await harness.pressKey("c")
    await harness.pressKey("d")
    await harness.settle()

    expect((await harness.repository.git(["worktree", "list", "--porcelain"])).stdout).toContain("wt-feature")
    expect((await harness.repository.git(["branch", "--list", "feature"])).stdout).not.toContain("feature")
  })
  test("shows lazygit disabled reasons for checked-out and untracked branches", async () => {
    harness = await createShellHarness()

    await harness.pressKey("3")
    await harness.pressKey("d")

    const frame = harness.frame()
    expect(frame).toContain("unavailable: You cannot delete the checked")
    expect(frame).toContain("unavailable: The selected branch has no ups")
  })

  test("merged local deletion runs after choosing the local option", async () => {
    harness = await createShellHarness()
    await harness.repository.git(["branch", "throwaway"])
    await harness.app.refresh()

    await harness.pressKey("3")
    await harness.pressKey("j")
    await harness.pressKey("d")
    await harness.pressKey("c")
    await harness.settle()

    expect((await harness.repository.git(["branch", "--list", "throwaway"])).stdout).not.toContain("throwaway")
  })

  test("unmerged local deletion asks for force confirmation", async () => {
    harness = await createShellHarness()
    await harness.repository.git(["switch", "-c", "throwaway"])
    await harness.repository.write("throwaway.txt", "unmerged\n")
    await harness.repository.git(["add", "throwaway.txt"])
    await harness.repository.git(["commit", "-m", "unmerged branch"])
    await harness.repository.git(["switch", "master"])
    await harness.app.refresh()

    await harness.pressKey("3")
    await harness.pressKey("j")
    await harness.pressKey("d")
    await harness.pressKey("c")
    await harness.settle()
    expect(harness.frame()).toContain("Force delete branch")
    expect(harness.frame()).toContain("not fully merged")

    await harness.pressKey("d")
    await harness.settle()
    expect((await harness.repository.git(["branch", "--list", "throwaway"])).stdout).not.toContain("throwaway")
  })

  test("both choice confirms and removes the local and remote refs", async () => {
    harness = await createShellHarness({ setup: seedTrackedRemoteBranch })

    await harness.pressKey("3")
    await harness.pressKey("j")
    await harness.pressKey("d")
    await harness.pressKey("b")
    expect(harness.frame()).toContain("Delete local and remote branch")
    expect(harness.frame()).toContain("Are you sure you want to delete both")

    await harness.pressKey("d")
    await harness.settle()
    const remote = harness.fetchBare
    if (remote === undefined) throw new Error("test remote was not created")
    expect((await remote.git(["show-ref", "--verify", "--quiet", "refs/heads/feature/foo"])).exitCode).not.toBe(0)
    expect((await harness.repository.git(["branch", "--list", "feature/foo"])).stdout).not.toContain("feature/foo")
  })

  test("remote choice confirms and removes only the remote ref", async () => {
    harness = await createShellHarness({ setup: seedTrackedRemoteBranch })

    await harness.pressKey("3")
    await harness.pressKey("j")
    await harness.pressKey("d")
    expect(harness.frame()).toContain("Delete remote branch")

    await harness.pressKey("r")
    expect(harness.frame()).toContain("Are you sure you want to delete the remote branch")

    await harness.pressKey("d")
    await harness.settle()
    const remote = harness.fetchBare
    if (remote === undefined) throw new Error("test remote was not created")
    expect((await remote.git(["show-ref", "--verify", "--quiet", "refs/heads/feature/foo"])).exitCode).not.toBe(0)
    expect((await harness.repository.git(["branch", "--list", "feature/foo"])).stdout).toContain("feature/foo")
  })

  test("remote child deletion refreshes the remaining remote branches", async () => {
    harness = await createShellHarness({ setup: seedTwoRemoteBranches })

    await harness.pressKey("3")
    await harness.pressKey("]")
    await harness.pressKey("RETURN")
    await harness.settle()
    const view = harness.app.view!
    const selected = view.branchesPanel.child?.view.selectedId
    if (selected === undefined) throw new Error("remote branch was not selected")
    const remaining = selected.endsWith("feature/bar") ? "feature/foo" : "feature/bar"

    await harness.pressKey("d")
    await harness.pressKey("d")
    await harness.settle()

    expect(view.branchesPanel.child?.view.selectedId).toBe(`remote-branch:origin/${remaining}`)
    expect(view.renderedListText("branches")).toContain(remaining)
  })

  test("rename of a tracking branch asks before opening the name prompt", async () => {
    harness = await createShellHarness({ setup: seedTrackedRemoteBranch })

    await harness.pressKey("3")
    await harness.pressKey("j")
    await harness.pressKey("r")

    expect(harness.app.view!.actionMenuOpen).toBe(true)
    expect(harness.frame()).toContain("This branch is tracking a remote")

    await harness.pressKey("RETURN")
    expect(harness.app.view!.actionMenuOpen).toBe(false)
    expect(harness.frame()).toContain("Rename branch")
  })
  test("new branch from a remote branch uses its ref and short name", async () => {
    harness = await createShellHarness({ setup: seedRemoteBranch })

    await harness.pressKey("3")
    await harness.pressKey("]")
    await harness.pressKey("RETURN")
    await harness.settle()
    expect(harness.app.view!.branchesPanel.child?.value).toEqual({ kind: "remote-branches", remote: "origin" })
    expect(harness.app.view!.isMutating).toBe(false)
    expect(harness.app.view!.branchesPanel.child?.view.selectedId).toBe("remote-branch:origin/feature/foo")
    await harness.pressKey("n")

    const frame = harness.frame()
    expect(frame).toContain("New branch name (branch is off of 'origin/feature/foo')")
    expect(frame).toContain("feature/foo")
  })

  test("creating from a local branch checks out the new branch", async () => {
    harness = await createShellHarness()

    await harness.pressKey("3")
    await harness.pressKey("n")
    for (const key of ["c", "h", "i", "l", "d"]) await harness.pressKey(key)
    await harness.pressKey("RETURN", { ctrl: true })
    await harness.settle()

    expect((await harness.repository.git(["branch", "--show-current"])).stdout.trim()).toBe("child")
    expect((await harness.repository.git(["show-ref", "--verify", "--quiet", "refs/heads/child"])).exitCode).toBe(0)
    expect(harness.app.view!.branchesPanel.views.branches.selectedId).toBe("local:child")
  })

  test("creating from a remote branch keeps tracking when the suggested name is unchanged", async () => {
    harness = await createShellHarness({ setup: seedRemoteBranch })

    await harness.pressKey("3")
    await harness.pressKey("]")
    await harness.pressKey("RETURN")
    await harness.settle()
    await harness.pressKey("n")
    await harness.pressKey("RETURN", { ctrl: true })
    await harness.settle()
    expect(harness.app.view!.branchesPanel.child).toBeUndefined()
    expect(harness.app.view!.activeBranchesTab).toBe("branches")
    expect(harness.app.view!.renderedListText("branches")).toContain("feature/foo")

    expect((await harness.repository.git(["branch", "--show-current"])).stdout.trim()).toBe("feature/foo")
    expect((await harness.repository.git(["rev-parse", "--abbrev-ref", "feature/foo@{upstream}"])).stdout.trim()).toBe("origin/feature/foo")
  })

  test("editing a remote branch name sanitizes spaces and disables tracking", async () => {
    harness = await createShellHarness({ setup: seedRemoteBranch })

    await harness.pressKey("3")
    await harness.pressKey("]")
    await harness.pressKey("RETURN")
    await harness.settle()
    await harness.pressKey("n")
    for (const _ of "feature/foo") await harness.pressKey("BACKSPACE")
    for (const letter of "custom") await harness.pressKey(letter)
    await harness.pressKey(" ")
    for (const letter of "name") await harness.pressKey(letter)
    await harness.pressKey("RETURN", { ctrl: true })
    await harness.settle()

    expect((await harness.repository.git(["branch", "--show-current"])).stdout.trim()).toBe("custom-name")
    expect((await harness.repository.git(["rev-parse", "--abbrev-ref", "custom-name@{upstream}"])).exitCode).not.toBe(0)
  })

  test("offers autostash after a dirty checkout blocks branch creation", async () => {
    harness = await createShellHarness({ setup: seedDirtyRemoteBranch })

    await harness.pressKey("3")
    await harness.pressKey("]")
    await harness.pressKey("RETURN")
    await harness.settle()
    await harness.pressKey("n")
    await harness.pressKey("RETURN", { ctrl: true })
    await harness.settle()

    expect(harness.frame()).toContain("Autostash?")
    expect(harness.frame()).toContain("You must stash and pop")

    await harness.pressKey("RETURN")
    await harness.settle()
    expect((await harness.repository.git(["branch", "--show-current"])).stdout.trim()).toBe("feature")
    expect(harness.app.controller.state.branch).toBe("feature")
    expect(harness.app.controller.state.branches?.localBranches.map((branch) => branch.name)).toContain("feature")
    expect(harness.app.view!.renderedListText("branches")).toContain("feature")
    const createActions = harness.app.controller.runner?.log.lines()
      .filter((line) => line.spans.some((span) => span.style === "action"))
      .map((line) => line.spans.map((span) => span.text).join(""))
      .filter((text) => text === "Create branch")
    expect(createActions).toHaveLength(1)
  })

  test("cancelling autostash leaves no stale mutation status", async () => {
    harness = await createShellHarness({ setup: seedDirtyRemoteBranch })

    await harness.pressKey("3")
    await harness.pressKey("]")
    await harness.pressKey("RETURN")
    await harness.settle()
    await harness.pressKey("n")
    await harness.pressKey("RETURN", { ctrl: true })
    await harness.settle()
    expect(harness.frame()).toContain("Autostash?")

    await harness.pressKey("ESCAPE")
    expect(harness.app.view!.actionMenuOpen).toBe(false)
    expect(harness.app.view!.mainPane.box.bottomTitle).toBeUndefined()
  })

  test("offers autostash when an untracked file would be overwritten", async () => {
    harness = await createShellHarness({ setup: seedUntrackedOverwriteRemoteBranch })

    await harness.pressKey("3")
    await harness.pressKey("]")
    await harness.pressKey("RETURN")
    await harness.settle()
    await harness.pressKey("n")
    await harness.pressKey("RETURN", { ctrl: true })
    await harness.settle()

    expect(harness.frame()).toContain("Autostash?")
    await harness.pressKey("RETURN")
    await harness.settle()
    expect((await harness.repository.git(["branch", "--show-current"])).stdout.trim()).toBe("feature")
  })

  test("moving selection while merge check is pending cancels the original delete", async () => {
    let releaseCheck: (merged: boolean) => void = () => undefined
    const checkFinished = new Promise<boolean>((resolve) => { releaseCheck = resolve })
    harness = await createShellHarness({
      onCheckBranchMerged: async () => checkFinished,
    })
    await harness.repository.git(["branch", "throwaway"])
    await harness.app.refresh()

    await harness.pressKey("3")
    await harness.pressKey("j")
    await harness.pressKey("d")
    await harness.pressKey("c")
    await harness.pressKey("k")
    releaseCheck(true)
    await harness.settle()

    expect((await harness.repository.git(["branch", "--list", "throwaway"])).stdout).toContain("throwaway")
    expect(harness.app.view!.mainPane.box.bottomTitle).toBeUndefined()
  })

  test("cycling branch tabs while merge check is pending cancels deletion", async () => {
    let releaseCheck: (merged: boolean) => void = () => undefined
    const checkFinished = new Promise<boolean>((resolve) => { releaseCheck = resolve })
    harness = await createShellHarness({
      onCheckBranchMerged: async () => checkFinished,
    })
    await harness.repository.git(["branch", "throwaway"])
    await harness.app.refresh()

    await harness.pressKey("3")
    await harness.pressKey("j")
    await harness.pressKey("d")
    await harness.pressKey("c")
    await harness.pressKey("]")
    await harness.pressKey("[")
    releaseCheck(true)
    await harness.settle()

    expect((await harness.repository.git(["branch", "--list", "throwaway"])).stdout).toContain("throwaway")
    expect(harness.app.view!.mainPane.box.bottomTitle).toBeUndefined()
  })

  test("leaving and re-entering branches while merge check is pending cancels deletion", async () => {
    let releaseCheck: (merged: boolean) => void = () => undefined
    const checkFinished = new Promise<boolean>((resolve) => { releaseCheck = resolve })
    harness = await createShellHarness({
      onCheckBranchMerged: async () => checkFinished,
    })
    await harness.repository.git(["branch", "throwaway"])
    await harness.app.refresh()

    await harness.pressKey("3")
    await harness.pressKey("j")
    await harness.pressKey("d")
    await harness.pressKey("c")
    await harness.pressKey("0")
    await harness.pressKey("3")
    releaseCheck(true)
    await harness.settle()

    expect((await harness.repository.git(["branch", "--list", "throwaway"])).stdout).toContain("throwaway")
  })

  test("moving selection while worktree merge check is pending cancels deletion", async () => {
    let releaseCheck: (merged: boolean) => void = () => undefined
    const checkFinished = new Promise<boolean>((resolve) => { releaseCheck = resolve })
    harness = await createShellHarness({
      setup: seedLinkedWorktree,
      onCheckBranchMerged: async () => checkFinished,
    })

    await harness.pressKey("3")
    await harness.pressKey("j")
    await harness.pressKey("d")
    await harness.pressKey("c")
    await harness.pressKey("r")
    await harness.pressKey("k")
    releaseCheck(true)
    await harness.settle()

    expect((await harness.repository.git(["branch", "--list", "feature"])).stdout).toContain("feature")
    expect((await harness.repository.git(["worktree", "list", "--porcelain"])).stdout).toContain("wt-feature")
    expect(harness.app.view!.mainPane.box.bottomTitle).toBeUndefined()
  })
})
