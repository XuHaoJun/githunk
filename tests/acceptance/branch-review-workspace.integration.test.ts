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
import { coverageForFile } from "../../src/review/core/selectors"
import { renderReviewArtifactMarkdown } from "../../src/review/core/artifact"
import { ReviewArtifactStore } from "../../src/review/storage/review-artifact-store"
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
  await repository.write("src/validation.ts", "export const valid = true\nexport const lower = 1\nexport const upper = 2\n")
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
  const payload = JSON.stringify({ version: 2, baseByHead: { [headRef]: { baseRef, confirmed: true } }, reviews: {} })
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

  test("real repository: b opens aggregate workspace, viewed persists, one-file invalidation, no mutations", async () => {
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
    const activeController = reopened as unknown as { loadProjection?: unknown }
    expect(activeController.loadProjection).toBeUndefined()
    expect(reopened.state?.projection).toEqual({ kind: "aggregate" })
    const activeFrame = harness.frame()
    expect(activeFrame).toContain("[Aggregate]")
    expect(activeFrame).not.toContain("Since Last")
    expect(activeFrame).not.toContain("Commit")
    expect(activeFrame).not.toContain("src/untracked.tmp")

    const logAfter = app.controller.state.commandLog
    const newLines = logAfter.slice(logBefore)
    const newText = newLines.map((l) => l.spans.map((s) => s.text).join("")).join("\n")
    expect(newText).not.toMatch(/git (add|commit|checkout|push|pull|fetch|branch|stash)/)
  }, 30000)
  test("real OpenTUI scenario covers semantic feedback, stale resolution, finish, restart, and no mutation", async () => {
    repository = await createTempRepository()
    await createBranchFixture(repository)
    await seedBase(repository, "refs/heads/feature/payment", "refs/heads/main")
    harness = await createShellHarness({ repository, width: 120, height: 40 })

    const app = harness.app
    const initialLogStart = app.controller.state.commandLog.length
    const screen = harness.app.screenController
    const openWithB = async (): Promise<void> => {
      const currentScreen = harness!.app.screenController
      const activeKind = (): string => currentScreen.active.kind
      await harness!.pressKey("b")
      // Opening runs the real repository loader asynchronously; settle on the observable screen
      // transition rather than invoking the controller method that the `b` binding should call.
      for (let attempt = 0; attempt < 50 && activeKind() !== "branch-review"; attempt += 1) {
        await harness!.flush()
        if (activeKind() !== "branch-review") await new Promise((resolve) => setTimeout(resolve, 20))
      }
      await harness!.flush()
      expect(activeKind()).toBe("branch-review")
    }
    await openWithB()
    const branch = screen.active as Extract<typeof screen.active, { kind: "branch-review" }>
    const controller = branch.controller
    const root = branch.view.root
    const focusState = (): { readonly diff: boolean; readonly sidebar: boolean; readonly filter: boolean } => ({
      diff: Boolean((root.findDescendantById("review-diff-scrollbox") as { focused?: boolean } | undefined)?.focused),
      sidebar: Boolean((root.findDescendantById("react-review-sidebar-scrollbox") as { focused?: boolean } | undefined)?.focused),
      filter: Boolean((root.findDescendantById("review-file-filter-input") as { focused?: boolean } | undefined)?.focused),
    })
    const clickNode = async (id: string): Promise<void> => {
      const node = root.findDescendantById(id) as { screenX?: number; screenY?: number; width?: number; height?: number } | undefined
      if (!node || node.screenX === undefined || node.screenY === undefined) throw new Error(`missing OpenTUI node ${id}`)
      await harness!.mockMouse.click(
        node.screenX + Math.floor(Math.max(1, node.width ?? 1) / 2),
        node.screenY + Math.floor(Math.max(1, node.height ?? 1) / 2),
      )
      await harness!.flush()
    }
    const fileRow = (path: string): string => `review-file-row:${path}`
    const diffRow = (fileKey: string, line: number): string => `${fileKey}:split:0:change:${line}:${line}`
    const state = () => controller.state!
    const payment = () => state().document.files.find((file) => file.path === "src/payment.ts")!
    const validation = () => state().document.files.find((file) => file.path === "src/validation.ts")!

    expect(harness.frame()).toContain("[Aggregate]")
    expect(focusState().diff).toBe(true)
    await harness.pressKey("1")
    await Bun.sleep(30)
    await harness.flush()
    expect(focusState()).toEqual({ diff: false, sidebar: true, filter: false })
    await harness.pressTab()
    await Bun.sleep(30)
    await harness.flush()
    expect(focusState()).toEqual({ diff: false, sidebar: false, filter: true })
    await harness.typeText("0")
    await Bun.sleep(30)
    await harness.flush()
    expect(focusState()).toEqual({ diff: true, sidebar: false, filter: false })

    // Keyboard selects a changed line, then the mouse selects a different changed line.
    await clickNode(fileRow(payment().path))
    await clickNode(diffRow(payment().key, 0))
    const clickedPaymentLine = state().lineSelection
    expect(clickedPaymentLine).not.toBeNull()
    await harness.pressKey("j")
    const movedPaymentLine = state().lineSelection
    expect(movedPaymentLine?.fileKey).toBe(payment().key)
    expect(movedPaymentLine?.side).toBe("new")
    expect(movedPaymentLine?.line).not.toBe(clickedPaymentLine?.line)
    expect(movedPaymentLine?.contentId).toBe(clickedPaymentLine?.contentId)
    expect(movedPaymentLine?.contextDigest).toBeTypeOf("string")
    await clickNode(fileRow(validation().path))
    await clickNode(diffRow(validation().key, 0))
    await clickNode(fileRow(payment().path))
    await clickNode(diffRow(payment().key, 0))
    await harness.pressKey("c")
    await clickNode("review-feedback-body")
    await harness.typeText("payment note")
    await clickNode("review-feedback-save")
    expect(state().feedback).toHaveLength(1)
    const paymentNoteId = state().feedback[0]!.id
    await harness.typeText("}")
    await harness.pressKey("e")
    await clickNode("review-feedback-body")
    await harness.typeText(" edited")
    await clickNode("review-feedback-save")
    expect(state().feedback.find((feedback) => feedback.id === paymentNoteId)?.body).toContain("edited")
    expect(state().feedback.find((feedback) => feedback.id === paymentNoteId)?.body).toContain("payment note")

    // Create a temporary second item and delete it with the two-step confirmation.
    await clickNode(fileRow("src/types.ts"))
    await clickNode(diffRow("src/types.ts", 0))
    await harness.pressKey("c")
    await clickNode("review-feedback-body")
    await harness.typeText("delete me")
    await clickNode("review-feedback-save")
    const deletedId = state().feedback.find((feedback) => feedback.body === "delete me")!.id
    await harness.pressKey("}")
    await harness.pressKey("}")
    await harness.pressKey("d")
    await harness.pressKey("d")
    expect(state().feedback.find((feedback) => feedback.id === deletedId)).toBeUndefined()
    expect(state().feedback.find((feedback) => feedback.id === paymentNoteId)?.body).toContain("edited")

    // Select a two-line new-side range and save a blocking suggestion with real replacement text.
    await clickNode(fileRow(validation().path))
    await clickNode(diffRow(validation().key, 0))
    await clickNode(diffRow(validation().key, 1))
    await harness.pressKey("c")
    await clickNode("review-feedback-kind-suggestion")
    await clickNode("review-feedback-severity-blocking")
    await clickNode("review-feedback-body")
    await harness.typeText("replace validation")
    await clickNode("review-feedback-replacement")
    await harness.typeText("export const valid = false")
    await clickNode("review-feedback-save")
    const suggestion = state().feedback.find((feedback) => feedback.kind === "suggestion")!
    expect(suggestion.severity).toBe("blocking")
    expect(suggestion.anchor).toMatchObject({ kind: "range", side: "new", startLine: 1, endLine: 2 })
    expect(suggestion.replacement).toBe("export const valid = false")
    await controller.flushDrafts()

    // A real repository commit changes the reviewed payment file; refresh and reopen to reconcile it.
    const oldGenerationId = controller.generationId
    await repository.write("src/payment.ts", "export const pay = 2 // changed after review\nline2\nline3\n")
    await repository.git(["add", "src/payment.ts"])
    await repository.git(["commit", "-m", "change reviewed payment"])
    await controller.refreshGeneration()
    expect(controller.generationId).not.toBe(oldGenerationId)
    expect(controller.state?.feedback.find((feedback) => feedback.id === paymentNoteId)?.resolution).toBe("stale")
    await screen.closeBranchReview()
    await openWithB()
    const reopenedScreen = screen.active as Extract<typeof screen.active, { kind: "branch-review" }>
    const reopened = reopenedScreen.controller
    const reopenedRoot = reopenedScreen.view.root
    expect(reopened.state?.feedback.find((feedback) => feedback.id === paymentNoteId)?.resolution).toBe("stale")
    expect(reopened.state?.feedback.find((feedback) => feedback.kind === "suggestion")?.resolution).toBe("active")

    // Finish is visibly blocked until the stale item is re-anchored.
    await harness.pressKey("R")
    expect(harness.frame()).toContain("Finish blocked: some feedback is stale or orphaned")
    await harness.pressKey("ESCAPE")
    const currentPayment = reopened.state!.document.files.find((file) => file.path === "src/payment.ts")!
    const currentPaymentRow = `${currentPayment.key}:split:0:change:0:0`
    const clickReopenedNode = async (id: string): Promise<void> => {
      const node = reopenedRoot.findDescendantById(id) as { screenX?: number; screenY?: number; width?: number; height?: number } | undefined
      if (!node || node.screenX === undefined || node.screenY === undefined) throw new Error(`missing reopened OpenTUI node ${id}`)
      await harness!.mockMouse.click(node.screenX + Math.floor(Math.max(1, node.width ?? 1) / 2), node.screenY + Math.floor(Math.max(1, node.height ?? 1) / 2))
      await harness!.flush()
    }
    await clickReopenedNode(fileRow(currentPayment.path))
    await harness.pressKey("0")
    await clickReopenedNode(currentPaymentRow)
    expect(reopened.state?.lineSelection).not.toBeNull()
    await clickReopenedNode(`${currentPayment.key}:split:feedback:${paymentNoteId}`)
    await clickReopenedNode(currentPaymentRow)
    await harness.typeText("a")
    expect(reopened.state?.feedback.find((feedback) => feedback.id === paymentNoteId)?.resolution).toBe("active")

    await harness.pressKey("R")
    expect(harness.frame()).toContain("Finish review")
    await clickReopenedNode("review-finish-request-changes")
    await clickReopenedNode("review-finish-summary")
    await harness.typeText("please apply the validation replacement")
    await clickReopenedNode("review-finish-submit")
    await reopened.flushDrafts()
    expect(reopened.state?.lastSubmission).toBeDefined()
    expect(reopened.state?.feedback).toEqual([])
    const artifactId = reopened.state!.lastSubmission!.artifactId
    const artifactStore = new ReviewArtifactStore(new GitRunner(repository.path))
    const raw = await artifactStore.readRaw(reopened.state!.document.identity.id, artifactId)
    expect(raw).toBeDefined()
    const json = JSON.parse(raw!) as { decision: string; projection: { kind: string }; feedback: readonly { kind: string; replacement?: string }[] }
    expect(json.decision).toBe("request-changes")
    expect(json.projection).toEqual({ kind: "aggregate" })
    expect(json.feedback.some((feedback) => feedback.kind === "suggestion" && feedback.replacement === "export const valid = false")).toBe(true)
    const artifact = await artifactStore.load(reopened.state!.document.identity.id, artifactId)
    expect(artifact).toBeDefined()
    const markdownA = renderReviewArtifactMarkdown(artifact!)
    const markdownB = renderReviewArtifactMarkdown(artifact!)
    expect(markdownA).toBe(markdownB)
    expect(markdownA).toContain("request-changes")
    expect(markdownA).toContain("export const valid = false")
    const firstAppLog = app.controller.state.commandLog.slice(initialLogStart).map((line) => line.spans.map((span) => span.text).join(""))
    const restartRepository = repository
    await harness.cleanup()
    harness = await createShellHarness({ repository: restartRepository, width: 120, height: 40 })
    const restartLogStart = harness.app.controller.state.commandLog.length
    await openWithB()
    const restarted = (harness.app.screenController.active as Extract<typeof harness.app.screenController.active, { kind: "branch-review" }>).controller
    expect(restarted.state?.lastSubmission?.artifactId).toBe(artifactId)
    expect(restarted.state?.projection).toEqual({ kind: "aggregate" })
    expect(restarted.state?.feedback).toEqual([])
    expect(restarted.state?.draft).toBeNull()
    const restartAppLog = harness.app.controller.state.commandLog.slice(restartLogStart).map((line) => line.spans.map((span) => span.text).join(""))
    const allAppLog = [...firstAppLog, ...restartAppLog]
    const readOnlyGitVerb = /^(?:rev-parse|status|diff|numstat|show|log|merge-base|ls-files|ls-tree|cat-file|for-each-ref|symbolic-ref|name-rev|describe|check-ignore|check-attr)(?:\s|$)/u
    for (const commandRecord of allAppLog) {
      const command = commandRecord.trim()
      if (command.length > 0) expect(command).toMatch(/^git /u)
      if (command.startsWith("git ")) expect(command.slice(4)).toMatch(readOnlyGitVerb)
    }
  }, 40000)

  test("returning from branch review refreshes repository working-tree files", async () => {
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
    await screen.openBranchReview()
    expect(screen.active.kind).toBe("branch-review")

    await repository.write("src/payment.ts", "export const pay = 99 // changed while reviewing\nline2\nline3\n")
    await screen.closeBranchReview()
    await harness.flush()
    expect(screen.active.kind).toBe("repository")
    expect(app.controller.state.files.find((file) => file.path === "src/payment.ts")?.worktreeStatus).toBe("M")
    const patchText = app.controller.state.patches.map((section) => section.text).join("\n")
    expect(patchText).toContain("+export const pay = 99 // changed while reviewing")
    expect(harness.app.view?.renderedListText("files")).toContain("M payment.ts")
  }, 30000)
  test("repository bindings stay inactive while the React review screen is mounted", async () => {
    repository = await createTempRepository()
    await createBranchFixture(repository)
    await seedBase(repository, "refs/heads/feature/payment", "refs/heads/main")
    harness = await createShellHarness({ repository, width: 120, height: 40 })

    await harness.pressKey("b")
    for (let i = 0; i < 50 && harness.app.screenController.active.kind !== "branch-review"; i++) {
      await new Promise<void>((resolve) => setTimeout(resolve, 20))
      await harness.flush()
    }
    expect(harness.app.screenController.active.kind).toBe("branch-review")
    const repositoryView = harness.app.view!
    const focusBefore = repositoryView.focusManager.active

    await harness.pressKey("2")
    expect(repositoryView.focusManager.active).toBe(focusBefore)

    await harness.pressKey("q")
    expect(harness.app.screenController.active.kind).toBe("branch-review")

    await harness.pressKey("b")
    // Closing the React host performs an intentional next-tick unmount and repository refresh; this
    // end-to-end key-path check therefore waits on the observable screen transition.
    for (let i = 0; i < 50 && harness.app.screenController.active.kind !== "repository"; i++) {
      await new Promise<void>((resolve) => setTimeout(resolve, 20))
      await harness.flush()
    }
    expect(harness.app.screenController.active.kind).toBe("repository")
    expect(harness.frame()).not.toContain("Branch Review")
  }, 30000)
})
