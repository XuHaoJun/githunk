import { describe, expect, test } from "bun:test"
import { createTempRepository } from "../../helpers/temp-repository"
import { GitRunner } from "../../../src/git/runner"
import { ReviewWorkspaceController } from "../../../src/ui/review-workspace/controller"
import { ReviewStateStore } from "../../../src/review/storage/review-state-store"

async function repositoryWithFeature() {
  const repository = await createTempRepository()
  await repository.write("file.txt", "base\n")
  await repository.git(["add", "."])
  await repository.git(["commit", "-qm", "base"])
  await repository.git(["checkout", "-qb", "feature"])
  await repository.write("file.txt", "feature\n")
  await repository.git(["commit", "-qam", "feature"])
  return repository
}

describe("review base selection", () => {
  test("does not load an arbitrary base before the user chooses", async () => {
    const repository = await repositoryWithFeature()
    const runner = new GitRunner(repository.path)
    const controller = new ReviewWorkspaceController({ runner, stateStore: new ReviewStateStore(runner) })
    try {
      await controller.open()
      expect(controller.state).toBeUndefined()
    } finally {
      await controller.destroy()
      await repository.cleanup()
    }
  })

  test("remote default remains a recommendation and a confirmed choice survives restart per HEAD", async () => {
    const repository = await repositoryWithFeature()
    const runner = new GitRunner(repository.path)
    const store = new ReviewStateStore(runner)
    const controller = new ReviewWorkspaceController({ runner, stateStore: store })
    const restarted = new ReviewWorkspaceController({ runner, stateStore: new ReviewStateStore(runner) })
    try {
      await repository.git(["remote", "add", "origin", "."])
      await repository.git(["update-ref", "refs/remotes/origin/master", "master"])
      await repository.git(["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/master"])
      await controller.open()
      expect(controller.state).toBeUndefined()
      expect(controller.baseSelection?.candidates.some(candidate => candidate.ref === "refs/remotes/origin/master")).toBe(true)
      expect(await controller.chooseBase("refs/remotes/origin/master")).toBe(true)
      const identity = controller.state!.document.identity
      expect(controller.state!.document.files.map(file => file.path)).toEqual(["file.txt"])
      await controller.destroy()
      await restarted.open()
      expect(restarted.baseSelection).toBeUndefined()
      expect(restarted.state?.document.identity).toEqual(identity)
      expect((await repository.git(["status", "--porcelain"])).stdout).toBe("")
      expect((await repository.git(["symbolic-ref", "HEAD"])).stdout.trim()).toBe("refs/heads/feature")
      await repository.git(["checkout", "-qb", "another-feature"])
      const other = new ReviewWorkspaceController({ runner, stateStore: store })
      try {
        await other.open()
        expect(other.state).toBeUndefined()
        expect(other.baseSelection?.loading).toBe(false)
      } finally { await other.destroy() }
    } finally {
      await controller.destroy()
      await restarted.destroy()
      await repository.cleanup()
    }
  })

  test("legacy and deleted remembered bases require confirmation without removing stored reviews", async () => {
    const repository = await repositoryWithFeature()
    const runner = new GitRunner(repository.path)
    const store = new ReviewStateStore(runner)
    const controller = new ReviewWorkspaceController({ runner, stateStore: store })
    try {
      await controller.open("master")
      controller.dispatch({ type: "filter/set-query", query: "file" })
      await controller.destroy()
      await store.saveSemanticChange(db => ({
        ...db,
        baseByHead: { "refs/heads/feature": { baseRef: "master" } },
      }))
      const legacy = new ReviewWorkspaceController({ runner, stateStore: store })
      try {
        await legacy.open()
        expect(legacy.state).toBeUndefined()
        expect(legacy.baseSelection?.candidates[0]?.ref).toBe("refs/heads/master")
        expect(await legacy.chooseBase("refs/heads/master")).toBe(true)
        expect(legacy.state?.filter.query).toBe("file")
      } finally { await legacy.destroy() }
      await repository.git(["branch", "-D", "master"])
      const missing = new ReviewWorkspaceController({ runner, stateStore: store })
      try {
        await missing.open()
        expect(missing.state).toBeUndefined()
        expect(missing.baseSelection?.candidates.some(candidate => candidate.ref === "refs/heads/master")).toBe(false)
        expect(Object.values((await store.load()).reviews).some(review => review.filter.query === "file")).toBe(true)
      } finally { await missing.destroy() }
    } finally {
      await controller.destroy()
      await repository.cleanup()
    }
  })

  test("switching keeps drafts isolated and a failed selection retains the current review", async () => {
    const repository = await repositoryWithFeature()
    const runner = new GitRunner(repository.path)
    const store = new ReviewStateStore(runner)
    const controller = new ReviewWorkspaceController({ runner, stateStore: store })
    try {
      await repository.git(["branch", "alternate", "master"])
      const first = await controller.open("refs/heads/master")
      const file = first.document.files[0]!
      controller.dispatch({
        type: "feedback/start-draft",
        draft: { kind: "note", severity: "comment", body: "keep this",
          anchor: { kind: "file", fileKey: file.key, contentId: file.contentId } },
      })
      await controller.requestBaseSelection()
      expect(await controller.chooseBase("refs/heads/alternate")).toBe(true)
      expect(controller.state?.draft).toBeNull()
      await controller.requestBaseSelection()
      expect(await controller.chooseBase("refs/heads/master")).toBe(true)
      expect(controller.state?.draft?.body).toBe("keep this")
      const beforeFailure = controller.state
      await controller.requestBaseSelection()
      await repository.git(["branch", "-D", "alternate"])
      expect(await controller.chooseBase("refs/heads/alternate")).toBe(false)
      expect(controller.state).toBe(beforeFailure)
      expect(controller.baseSelection?.error).toBeDefined()
      controller.cancelBaseSelection()
      expect(controller.state?.draft?.body).toBe("keep this")
      expect((await repository.git(["status", "--porcelain"])).stdout).toBe("")
    } finally {
      await controller.destroy()
      await repository.cleanup()
    }
  })

  test("cancelled candidate lookup cannot reopen the dialog", async () => {
    const repository = await repositoryWithFeature()
    const runner = new GitRunner(repository.path)
    const controller = new ReviewWorkspaceController({ runner })
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const run = runner.run.bind(runner)
    try {
      const original = await controller.open("refs/heads/master")
      runner.run = async (args, options) => {
        if (args[0] === "for-each-ref") {
          entered.resolve()
          await release.promise
        }
        return run(args, options)
      }
      const loading = controller.requestBaseSelection()
      await entered.promise
      controller.cancelBaseSelection()
      release.resolve()
      await loading
      expect(controller.baseSelection).toBeUndefined()
      expect(controller.state).toBe(original)
    } finally {
      release.resolve()
      await controller.destroy()
      await repository.cleanup()
    }
  })
})
