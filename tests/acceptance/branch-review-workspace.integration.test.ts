import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, mkdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createTempRepository } from "../helpers/temp-repository"
import type { TempRepository } from "../helpers/temp-repository"
import { createShellHarness } from "../helpers/shell-harness"
import type { ShellHarness } from "../helpers/shell-harness"
import type { ReviewWorkspaceController } from "../../src/ui/review-workspace/controller"
import { coverageForFile } from "../../src/review/core/selectors"
import { loadSinceLastReviewProjection } from "../../src/review/git/load-review-projection"
import { GitRunner } from "../../src/git/runner"
async function createBranchFixture(repository: TempRepository): Promise<void> {
  await repository.write("README.md", "# base\n")
  await repository.git(["add", "README.md"])
  await repository.git(["commit", "-m", "base commit"])
  await repository.git(["branch", "-M", "main"])
  const barePath = await mkdtemp(join(tmpdir(), "githunk-bare-coverage-"))
  const initBare = Bun.spawn(["git", "init", "--bare", "--quiet", barePath], { stdout: "pipe", stderr: "pipe" })
  await initBare.exited
  await repository.git(["remote", "add", "origin", barePath])
  await repository.git(["push", "-u", "origin", "main", "--quiet"])
  await repository.git(["remote", "set-head", "origin", "--auto"])
  await repository.git(["checkout", "-b", "feature/payment", "--quiet"])
  await repository.write("src/payment.ts", "export const pay = 1\nline2\nline3\n")
  await repository.git(["add", "src/payment.ts"])
  await repository.git(["commit", "-m", "add payment"])
  await repository.write("src/validation.ts", "export const valid = true\n")
  await repository.git(["add", "src/validation.ts"])
  await repository.git(["commit", "-m", "add validation"])
  await repository.write("src/types.ts", "export type T = string\n")
  await repository.git(["add", "src/types.ts"])
  await repository.git(["commit", "-m", "add types"])
}

async function seedBase(repository: TempRepository, headRef: string, baseRef: string): Promise<void> {
  const gitDir = (await repository.git(["rev-parse", "--git-dir"])).stdout.trim()
  const absoluteGitDir = gitDir.startsWith("/") ? gitDir : join(repository.path, gitDir)
  const targetDir = join(absoluteGitDir, "githunk")
  await mkdir(targetDir, { recursive: true })
  const targetFile = join(targetDir, "review-state-v2.json")
  const payload = JSON.stringify({ version: 2, baseByHead: { [headRef]: { baseRef } }, reviews: {} })
  await writeFile(targetFile, payload, "utf8")
  try { await Bun.file(targetFile).text() } catch {}
}

describe("branch review workspace – coverage and reconciliation acceptance", () => {
  let repository: TempRepository | undefined
  let harness: ShellHarness | undefined

  afterEach(async () => {
    await harness?.cleanup()
    harness = undefined
    await repository?.cleanup()
    repository = undefined
  })

  test("real repository: b opens workspace, viewed persists, one-file invalidation, since-last, no mutations", async () => {
    repository = await createTempRepository()
    await createBranchFixture(repository)
    await seedBase(repository, "refs/heads/feature/payment", "refs/heads/main")

    harness = await createShellHarness({ repository, width: 120, height: 40 })
    const app = harness.app
    const screen = app.screenController as unknown as {
      active: { kind: string }
      openBranchReview: () => Promise<void>
      closeBranchReview: () => Promise<void>
    }

    const logBefore = app.controller.state.commandLog.length

    expect(screen.active.kind).toBe("repository")
    await harness.pressKey("b")
    // Real git open is async – polling with wall-clock delay is required for this integration test
    for (let i = 0; i < 50; i++) {
      if (screen.active.kind === "branch-review") break
      await new Promise<void>((resolve) => setTimeout(resolve, 20))
      await harness.flush()
    }
    expect(screen.active.kind).toBe("branch-review")
    const branchScreen = (screen.active as unknown as { controller: ReviewWorkspaceController }).controller
    const frameAfterOpen = harness.frame()
    expect(frameAfterOpen).toContain("→")
    expect(frameAfterOpen).toContain("main")
    expect(frameAfterOpen).toContain("[Aggregate]")
    const stateAfterOpen = branchScreen.state!
    expect(stateAfterOpen.document.files.length).toBeGreaterThanOrEqual(3)
    expect(stateAfterOpen.document.identity.baseRef).toContain("main")
    const fileKeys = stateAfterOpen.document.files.map((f) => f.path)
    expect(fileKeys).toEqual(expect.arrayContaining(["src/payment.ts", "src/validation.ts", "src/types.ts"]))

    const paymentFile = stateAfterOpen.document.files.find((f) => f.path === "src/payment.ts")!
    const validationFile = stateAfterOpen.document.files.find((f) => f.path === "src/validation.ts")!
    const typesFile = stateAfterOpen.document.files.find((f) => f.path === "src/types.ts")!
    branchScreen.dispatchIntent({ type: "viewed/mark", fileKey: paymentFile.key, viewedAt: new Date().toISOString() })
    branchScreen.dispatchIntent({ type: "viewed/mark", fileKey: validationFile.key, viewedAt: new Date().toISOString() })
    // Viewed persistence uses serialized write queue – short wall-clock delay needed for integration test
    await new Promise<void>((resolve) => setTimeout(resolve, 200))
    await branchScreen.flushDrafts?.()
    const afterViewed = branchScreen.state!
    expect(coverageForFile(paymentFile, afterViewed.viewed, null)).toBe("viewed")
    expect(coverageForFile(validationFile, afterViewed.viewed, null)).toBe("viewed")
    expect(coverageForFile(typesFile, afterViewed.viewed, null)).toBe("not-viewed")

    await screen.closeBranchReview()
    expect(screen.active.kind).toBe("repository")
    expect(harness.frame()).not.toContain("Branch Review")
    await harness.pressKey("b")
    for (let i = 0; i < 50; i++) {
      if (screen.active.kind === "branch-review") break
      await new Promise<void>((resolve) => setTimeout(resolve, 20))
      await harness.flush()
    }
    expect(screen.active.kind).toBe("branch-review")
    const reopened = (screen.active as unknown as { controller: ReviewWorkspaceController }).controller
    const reopenedState = reopened.state!
    expect(coverageForFile(paymentFile, reopenedState.viewed, null)).toBe("viewed")
    expect(coverageForFile(validationFile, reopenedState.viewed, null)).toBe("viewed")
    expect(coverageForFile(typesFile, reopenedState.viewed, null)).toBe("not-viewed")
    expect(reopenedState.document.files.length).toBe(3)

    const finishResultBefore = await reopened.finishReview({ decision: "approve", summary: "initial approve for since-last" })
    expect(finishResultBefore.lastSubmission).toBeDefined()
    const lastSubmissionHead = finishResultBefore.lastSubmission!.headOid

    await repository.write("src/payment.ts", "export const pay = 2 // changed\nline2\nline3\n")
    await repository.git(["add", "src/payment.ts"])
    await repository.git(["commit", "-m", "update payment"])
    await repository.write("src/types.ts", "export type T = number // changed\n")
    await repository.git(["add", "src/types.ts"])
    await repository.git(["commit", "-m", "update types"])
    await repository.write("src/untracked.tmp", "working tree only\n")

    const beforeRefreshGenerationId = reopened.generationId
    await reopened.refreshGeneration()
    await new Promise<void>((resolve) => setTimeout(resolve, 100))
    const afterRefresh = reopened.state!
    expect(afterRefresh.document.generation.id).not.toBe(beforeRefreshGenerationId)
    const newPayment = afterRefresh.document.files.find((f) => f.path === "src/payment.ts")!
    const newTypes = afterRefresh.document.files.find((f) => f.path === "src/types.ts")!
    const newValidation = afterRefresh.document.files.find((f) => f.path === "src/validation.ts")!
    expect(coverageForFile(newPayment, afterRefresh.viewed, null)).toBe("changed-after-review")
    expect(coverageForFile(newValidation, afterRefresh.viewed, null)).toBe("viewed")
    expect(coverageForFile(newTypes, afterRefresh.viewed, null)).toBe("not-viewed")
    const hasUntracked = afterRefresh.document.files.some((f) => f.path.includes("untracked"))
    expect(hasUntracked).toBe(false)
    reopened.dispatch({ type: "projection/set", projection: { kind: "since-last-review", fromHeadOid: lastSubmissionHead } })
    const projectedState = reopened.state!
    expect(projectedState.projection.kind).toBe("since-last-review")
    const projectionResult = await loadSinceLastReviewProjection(new GitRunner(repository.path), projectedState.document, lastSubmissionHead)
    const projectionDoc = projectionResult.kind === "ok" ? projectionResult.document : projectedState.document
    const projFiles = projectionDoc.files.map((f) => f.path)
    expect(projFiles).toEqual(expect.arrayContaining(["src/payment.ts", "src/types.ts"]))
    expect(projFiles).not.toContain("src/validation.ts")

    const logAfter = app.controller.state.commandLog
    const newLines = logAfter.slice(logBefore)
    const newText = newLines.map((l) => l.spans.map((s) => s.text).join("")).join("\n")
    expect(newText).not.toMatch(/git (add|commit|checkout|push|pull|fetch|branch|stash)/)
    expect(projFiles).not.toContain("src/untracked.tmp")
  }, 30000)
})
