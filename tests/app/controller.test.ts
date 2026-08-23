import { describe, expect, test } from "bun:test"
import { AppController } from "../../src/app/controller"
import { GitCommandError, GitRunner } from "../../src/git/runner"
import type { WorkingTreeSnapshot } from "../../src/domain/repository"

function snapshot(scope: "all" | "staged" | "unstaged", marker: string): WorkingTreeSnapshot {
  return {
    repositoryRoot: "/tmp/repo",
    branch: "main",
    upstream: "origin/main",
    reviewTarget: { kind: "working-tree", scope },
    files: [],
    patches: [{ label: "UNSTAGED", text: marker }],
  }
}

describe("AppController", () => {
  test("switches working tree scope and title", async () => {
    const controller = new AppController({
      repositoryRoot: "/tmp/repo",
      load: async (target) => snapshot(target.scope, target.scope),
    })
    await controller.refresh()
    await controller.setWorkingTreeScope("staged")

    expect(controller.state.reviewTarget).toEqual({ kind: "working-tree", scope: "staged" })
    expect(controller.state.title).toBe("Working Tree — Staged")
    expect(controller.state.loading).toBe(false)
  })

  test("does not let an older refresh overwrite a newer generation", async () => {
    let resolveFirst: ((value: WorkingTreeSnapshot) => void) | undefined
    let count = 0
    const controller = new AppController({
      repositoryRoot: "/tmp/repo",
      load: async (target) => {
        count += 1
        if (count === 1) return new Promise((resolve) => { resolveFirst = resolve })
        return snapshot(target.scope, "new")
      },
    })
    const first = controller.refresh()
    const second = controller.setWorkingTreeScope("staged")
    await second
    resolveFirst?.(snapshot("all", "old"))
    await first

    expect(controller.state.reviewTarget).toEqual({ kind: "working-tree", scope: "staged" })
    expect(controller.state.patches[0]?.text).toBe("new")
  })
 
  test("keeps the last successful snapshot when refresh fails", async () => {
    let calls = 0
    const controller = new AppController({
      repositoryRoot: "/tmp/repo",
      load: async (target) => {
        calls += 1
        if (calls === 1) return snapshot(target.scope, "last good")
        throw new GitCommandError({
          id: 9,
          cwd: "/tmp/repo",
          args: ["status"],
          startedAt: "2026-01-01T00:00:00.000Z",
          durationMs: 1,
          exitCode: 128,
          stdout: "",
          stderr: "repository unavailable",
        })
      },
    })

    await controller.refresh()
    await controller.refresh()

    expect(controller.state.loading).toBe(false)
    expect(controller.state.patches[0]?.text).toBe("last good")
    expect(controller.state.banner).toBe("repository unavailable")
  })
  test("preserves the prior target and view when a scope refresh fails", async () => {
    let calls = 0
    const runner = new GitRunner({ cwd: "/tmp/repo" })
    const error = new GitCommandError({
      id: 12,
      cwd: "/tmp/repo",
      args: ["status"],
      startedAt: "2026-01-01T00:00:00.000Z",
      durationMs: 1,
      exitCode: 128,
      stdout: "",
      stderr: "scope unavailable",
    })
    runner.log.append(error.record)
    const controller = new AppController({
      runner,
      load: async (target) => {
        calls += 1
        if (calls === 1) {
          return {
            ...snapshot(target.scope, "old patch"),
            files: [{
              path: "old.ts",
              indexStatus: "M",
              worktreeStatus: ".",
              untracked: false,
              conflicted: false,
              additions: 1,
              deletions: 0,
            }],
          }
        }
        throw error
      },
    })

    await controller.refresh()
    await controller.setWorkingTreeScope("staged")

    expect(controller.state.reviewTarget).toEqual({ kind: "working-tree", scope: "all" })
    expect(controller.state.title).toBe("Working Tree — All")
    expect(controller.state.files.map((file) => file.path)).toEqual(["old.ts"])
    expect(controller.state.patches[0]?.text).toBe("old patch")
    expect(controller.state.banner).toBe("scope unavailable")
    expect(controller.state.commandLog.at(-1)?.stderr).toBe("scope unavailable")
  })

})
