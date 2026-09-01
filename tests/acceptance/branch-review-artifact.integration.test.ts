import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, mkdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createTempRepository } from "../helpers/temp-repository"
import type { TempRepository } from "../helpers/temp-repository"
import { createShellHarness } from "../helpers/shell-harness"
import type { ShellHarness } from "../helpers/shell-harness"
import { GitRunner } from "../../src/git/runner"
import type { ReviewWorkspaceController } from "../../src/ui/review-workspace/controller"
import { renderReviewArtifactMarkdown } from "../../src/review/core/artifact"
import { ReviewArtifactStore } from "../../src/review/storage/review-artifact-store"
import type { ReviewStateStore } from "../../src/review/storage/review-state-store"
import type { ReviewDatabaseV2 } from "../../src/review/storage/schemas"

async function createArtifactFixture(repository: TempRepository): Promise<void> {
  await repository.write("README.md", "# base\n")
  await repository.git(["add", "README.md"])
  await repository.git(["commit", "-m", "base"])
  await repository.git(["branch", "-M", "main"])
  const barePath = await mkdtemp(join(tmpdir(), "githunk-bare-artifact-"))
  const initBare = Bun.spawn(["git", "init", "--bare", "--quiet", barePath], { stdout: "pipe", stderr: "pipe" })
  await initBare.exited
  await repository.git(["remote", "add", "origin", barePath])
  await repository.git(["push", "-u", "origin", "main", "--quiet"])
  await repository.git(["remote", "set-head", "origin", "--auto"])
  await repository.git(["checkout", "-b", "feature/docs", "--quiet"])
  await repository.write("src/app.ts", "export const a = 1\nline2\nline3\nline4\n")
  await repository.git(["add", "src/app.ts"])
  await repository.git(["commit", "-m", "add app"])
  await repository.write("src/util.ts", "export const b = 2\n")
  await repository.git(["add", "src/util.ts"])
  await repository.git(["commit", "-m", "add util"])
}

async function seedBase(repository: TempRepository, headRef: string, baseRef: string): Promise<void> {
  const gitDir = (await repository.git(["rev-parse", "--git-dir"])).stdout.trim()
  const absoluteGitDir = gitDir.startsWith("/") ? gitDir : join(repository.path, gitDir)
  const targetDir = join(absoluteGitDir, "githunk")
  await mkdir(targetDir, { recursive: true })
  const targetFile = join(targetDir, "review-state-v2.json")
  const payload = JSON.stringify({ version: 2, baseByHead: { [headRef]: { baseRef } }, reviews: {} })
  await writeFile(targetFile, payload, "utf8")
}

describe("branch review workspace – feedback and artifact acceptance", () => {
  let repository: TempRepository | undefined
  let harness: ShellHarness | undefined

  afterEach(async () => {
    await harness?.cleanup()
    harness = undefined
    await repository?.cleanup()
    repository = undefined
  })

  test("keyboard/mouse feedback, request changes artifact, markdown, restart, transaction recovery reuses id", async () => {
    repository = await createTempRepository()
    await createArtifactFixture(repository)
    await seedBase(repository, "refs/heads/feature/docs", "refs/heads/main")

    harness = await createShellHarness({ repository, width: 120, height: 40 })
    const app = harness.app
    const screen = app.screenController as unknown as {
      active: { kind: string }
      closeBranchReview: () => Promise<void>
    }

    await harness.pressKey("b")
    for (let i = 0; i < 50; i++) {
      if (screen.active.kind === "branch-review") break
      await new Promise<void>((resolve) => setTimeout(resolve, 20))
      await harness.flush()
    }
    expect(screen.active.kind).toBe("branch-review")
    const branchScreen = screen.active as unknown as {
      kind: "branch-review"
      controller: ReviewWorkspaceController
      view: { root: { findDescendantById: (id: string) => unknown } }
    }
    const branchController = branchScreen.controller
    const root = branchScreen.view.root
    const clickNode = async (id: string): Promise<void> => {
      const node = root.findDescendantById(id) as { screenX?: number; screenY?: number; width?: number; height?: number } | undefined
      if (!node || node.screenX === undefined || node.screenY === undefined) throw new Error(`missing OpenTUI node ${id}`)
      await harness!.mockMouse.click(node.screenX + Math.floor((node.width ?? 1) / 2), node.screenY + Math.floor((node.height ?? 1) / 2))
      await harness!.flush()
    }

    expect(harness.frame()).toContain("→")
    expect(harness.frame()).toContain("main")
    expect(harness.frame()).toContain("[Aggregate]")
    const doc = branchController.state!.document
    const appFile = doc.files.find((f) => f.path === "src/app.ts")!
    expect(appFile).toBeDefined()

    const sourceRowId = `${appFile.key}:split:0:change:0:0`
    await clickNode(sourceRowId)
    await clickNode(sourceRowId)
    await harness.pressKey("c")
    expect(harness.frame()).toContain("Feedback composer")
    await clickNode("review-feedback-kind-suggestion")
    await clickNode("review-feedback-severity-blocking")
    await clickNode("review-feedback-body")
    await harness.typeText("first line")
    await harness.pressKey("ENTER")
    await harness.typeText("second line")
    await harness.pressKey("ENTER")
    await harness.typeText("third line")
    await clickNode("review-feedback-replacement")
    await harness.typeText("replacement line1")
    await harness.pressKey("ENTER")
    await harness.typeText("replacement line2")
    await clickNode("review-feedback-save")

    await clickNode(sourceRowId)
    await harness.pressKey("c")
    await clickNode("review-feedback-body")
    await harness.typeText("looks good, but consider naming")
    await clickNode("review-feedback-save")

    const afterFeedback = branchController.state!
    expect(afterFeedback.feedback).toHaveLength(2)
    expect(afterFeedback.feedback.some((fb) => fb.severity === "blocking" && fb.kind === "suggestion")).toBe(true)
    expect(afterFeedback.feedback.some((fb) => fb.severity === "comment" && fb.kind === "note")).toBe(true)

    expect(harness.frame()).toContain("[Aggregate]")
    await harness.pressKey("R")
    expect(harness.frame()).toContain("Finish review")
    await clickNode("review-finish-request-changes")
    await clickNode("review-finish-summary")
    await harness.typeText("needs revision")
    expect(harness.frame()).toContain("needs revision")
    await clickNode("review-finish-submit")
    for (let i = 0; i < 50 && branchController.state?.lastSubmission === undefined; i++) {
      await harness.flush()
      await new Promise<void>((resolve) => setTimeout(resolve, 20))
    }
    const finishResult = branchController.state!
    expect(finishResult.lastSubmission).toBeDefined()
    const artifactId = finishResult.lastSubmission!.artifactId

    const artifactStore = new ReviewArtifactStore(new GitRunner(repository.path))
    const artifact = await artifactStore.load(doc.identity.id, artifactId)
    expect(artifact).toBeDefined()
    expect(artifact!.version).toBe(1)
    expect(artifact!.decision).toBe("request-changes")
    expect(artifact!.summary).toBe("needs revision")
    expect(artifact!.feedback).toHaveLength(2)
    expect(artifact!.feedback.some((fb) => fb.severity === "blocking")).toBe(true)
    expect(artifact!.feedback.some((fb) => fb.severity === "comment")).toBe(true)

    // Compare deterministic Markdown clipboard text derived from stored artifact
    const markdownA = renderReviewArtifactMarkdown(artifact!)
    const markdownB = renderReviewArtifactMarkdown(artifact!)
    expect(markdownA).toBe(markdownB)
    expect(markdownA).toContain("request-changes")
    expect(markdownA).toContain("needs revision")
    expect(markdownA).toContain("first line")
    expect(markdownA).toContain("replacement line1")
    expect(markdownA).toContain("src/app.ts")
    // Markdown groups blocking feedback before comment (spec §11 order)
    const blockingIndex = markdownA.indexOf("first line")
    const commentIndex = markdownA.indexOf("looks good")
    expect(blockingIndex).toBeGreaterThan(-1)
    expect(commentIndex).toBeGreaterThan(-1)
    expect(blockingIndex).toBeLessThan(commentIndex)

    const repoPath = repository.path
    await harness.cleanup()
    harness = undefined
    const restartedRepo: TempRepository = {
      path: repoPath,
      git: repository.git,
      write: repository.write,
      cleanup: async () => {},
    }
    harness = await createShellHarness({ repository: restartedRepo, width: 120, height: 40 })
    const restartedScreen = harness.app.screenController as unknown as { active: { kind: string } }
    await harness.pressKey("b")
    for (let i = 0; i < 50; i++) {
      if (restartedScreen.active.kind === "branch-review") break
      await new Promise<void>((resolve) => setTimeout(resolve, 20))
      await harness.flush()
    }
    expect(restartedScreen.active.kind).toBe("branch-review")
    const restartedController = (restartedScreen.active as unknown as { controller: ReviewWorkspaceController }).controller
    const restartedState = restartedController.state!
    expect(restartedState.lastSubmission?.artifactId).toBe(artifactId)
    expect(restartedState.feedback).toHaveLength(0)

    const restartedDoc = restartedState.document
    const restartedFile = restartedDoc.files.find((f) => f.path === "src/app.ts")!
    const restartedActive = restartedScreen.active as unknown as {
      view: { root: { findDescendantById: (id: string) => unknown } }
    }
    const restartedRoot = restartedActive.view.root
    const clickRestartNode = async (id: string): Promise<void> => {
      const node = restartedRoot.findDescendantById(id) as { screenX?: number; screenY?: number; width?: number; height?: number } | undefined
      if (!node || node.screenX === undefined || node.screenY === undefined) throw new Error(`missing restarted OpenTUI node ${id}`)
      await harness!.mockMouse.click(node.screenX + Math.floor((node.width ?? 1) / 2), node.screenY + Math.floor((node.height ?? 1) / 2))
      await harness!.flush()
    }
    const restartedSourceRowId = `${restartedFile.key}:split:0:change:0:0`
    await clickRestartNode(restartedSourceRowId)
    await clickRestartNode(restartedSourceRowId)
    await harness.pressKey("c")
    await clickRestartNode("review-feedback-kind-suggestion")
    await clickRestartNode("review-feedback-severity-blocking")
    await clickRestartNode("review-feedback-body")
    await harness.typeText("another blocking")
    await clickRestartNode("review-feedback-replacement")
    await harness.typeText("fix")
    await clickRestartNode("review-feedback-save")
    expect(restartedController.state!.feedback).toHaveLength(1)

    const stateStore = (restartedController as unknown as { stateStore: ReviewStateStore }).stateStore
    const originalSave = stateStore.saveSemanticChange.bind(stateStore)
    let callCount = 0
    stateStore.saveSemanticChange = async (updater: (db: ReviewDatabaseV2) => ReviewDatabaseV2) => {
      callCount++
      if (callCount === 2) throw new Error("injected step-4 failure")
      return originalSave(updater as never) as never
    }

    const summaryForRetry = "needs revision after retry"
    await expect(restartedController.finishReview({ decision: "request-changes", summary: summaryForRetry })).rejects.toThrow("injected step-4 failure")

    const dbAfterFail = await stateStore.load()
    const persistedAfterFail = dbAfterFail.reviews[restartedDoc.identity.id]!
    expect(persistedAfterFail.submissionInProgress).toBeDefined()
    const failedArtifactId = persistedAfterFail.submissionInProgress!.artifactId
    expect(persistedAfterFail.feedback).toHaveLength(1)
    const artifactAfterFail = await artifactStore.load(restartedDoc.identity.id, failedArtifactId)
    expect(artifactAfterFail).toBeDefined()
    expect(artifactAfterFail!.summary).toBe(summaryForRetry)

    stateStore.saveSemanticChange = originalSave
    const retryResult = await restartedController.finishReview({ decision: "request-changes", summary: summaryForRetry })
    expect(retryResult.lastSubmission!.artifactId).toBe(failedArtifactId)
    const dbAfterRetry = await stateStore.load()
    expect(dbAfterRetry.reviews[restartedDoc.identity.id]!.submissionInProgress).toBeNull()
    expect(dbAfterRetry.reviews[restartedDoc.identity.id]!.feedback).toHaveLength(0)
    const reloaded = await artifactStore.load(restartedDoc.identity.id, failedArtifactId)
    expect(reloaded!.id).toBe(failedArtifactId)
    const firstArtifact = await artifactStore.load(doc.identity.id, artifactId)
    expect(firstArtifact!.id).toBe(artifactId)
    expect(failedArtifactId).not.toBe(artifactId)
  }, 40000)
})
