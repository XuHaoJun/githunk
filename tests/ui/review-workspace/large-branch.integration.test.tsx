import { describe, expect, test } from "bun:test"
import { testRender } from "@opentui/react/test-utils"
import { act } from "react"
import { loadReviewDocument } from "../../../src/review/git/load-review-document"
import { GitRunner } from "../../../src/git/runner"
import { createInitialReviewState } from "../../../src/review/core/state"
import type { ReviewWorkspaceController } from "../../../src/ui/review-workspace/controller"
import { ReviewWorkspaceApp } from "../../../src/ui/review-workspace/ReviewWorkspaceApp"
import { ReactReviewSession } from "../../../src/ui/review-workspace/react-review-session"
import { disposeHighlightWorker } from "../../../src/review/git/highlight/highlight-worker-client"
import { createTempRepository } from "../../helpers/temp-repository"
type SurfaceController = ReviewWorkspaceController & {
  state: NonNullable<ReviewWorkspaceController["state"]>
}

function controllerForState(state: SurfaceController["state"]): SurfaceController {
  return {
    state,
    error: undefined,
    subscribe: () => () => undefined,
    dispatch: () => undefined,
    expandGap: async () => undefined,
    getExpandedSourceByGap: () => new Map(),
  } as unknown as SurfaceController
}

async function flush(setup: Awaited<ReturnType<typeof testRender>>): Promise<void> {
  await act(async () => {
    await setup.renderOnce()
    await Bun.sleep(0)
    await setup.renderOnce()
  })
}
type SurfaceNode = Readonly<{
  id?: string
  getChildren: () => readonly SurfaceNode[]
}>

function countMountedDiffRows(node: SurfaceNode): number {
  const own = node.id?.includes(":split:") || node.id?.includes(":stack:") ? 1 : 0
  return own + node.getChildren().reduce((count, child) => count + countMountedDiffRows(child), 0)
}

describe("React review surface on the current large branch", () => {
  test("paints a large changeset before highlight completion and stays windowed", async () => {
    const repository = await createTempRepository()
    const runGit = async (args: readonly string[]): Promise<void> => {
      const result = await repository.git(args)
      if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`)
    }
    try {
      await runGit(["branch", "-M", "main"])
      const fileCount = 120
      const featureLineCount = 100
      for (let index = 0; index < fileCount; index++) {
        await repository.write(`src/large/file-${index}.txt`, `baseline-${index}\n`)
      }
      await runGit(["add", "--all"])
      await runGit(["commit", "-m", "large branch baseline"])
      await runGit(["switch", "-c", "feature/large"])
      for (let index = 0; index < fileCount; index++) {
        const content = Array.from({ length: featureLineCount }, (_, line) => `feature-${index}-${line}`).join("\n") + "\n"
        await repository.write(`src/large/file-${index}.txt`, content)
      }
      await runGit(["add", "--all"])
      await runGit(["commit", "-m", "large branch changes"])

      const document = await loadReviewDocument(new GitRunner(repository.path), "main")
      const changedLines = document.files.reduce((total, file) => total + file.hunks.reduce((count, hunk) => count + hunk.lines.length, 0), 0)
      expect(document.files.length).toBeGreaterThan(100)
      expect(changedLines).toBeGreaterThan(10_000)

      const session = new ReactReviewSession(controllerForState(createInitialReviewState(document)), () => undefined)
      const setup = await testRender(<ReviewWorkspaceApp session={session} />, { width: 100, height: 30, useMouse: true, enableMouseMovement: true })

      try {
        await flush(setup)
        expect(setup.renderer.root.findDescendantById("react-review-header")).toBeDefined()
        expect(setup.renderer.root.findDescendantById("review-diff-scrollbox")).toBeDefined()
        expect(setup.captureCharFrame()).toContain(document.files[0]?.path ?? "")

        await act(async () => {
          await setup.mockInput.typeText("l")
          await Bun.sleep(30)
        })
        await flush(setup)
        expect(setup.captureCharFrame()).toContain("Diff — stack")

        const scrollBox = setup.renderer.root.findDescendantById("review-diff-scrollbox")
        expect(scrollBox).toBeDefined()
        const mountedRows = countMountedDiffRows(setup.renderer.root as unknown as SurfaceNode)
        expect(mountedRows).toBeLessThan(500)
      } finally {
        disposeHighlightWorker()
        await act(async () => setup.renderer.destroy())
      }
    } finally {
      await repository.cleanup()
    }
  }, 40_000)
})
