import { describe, expect, test } from "bun:test"
import { testRender } from "@opentui/react/test-utils"
import type { TestRendererSetup } from "@opentui/core/testing"
import { act } from "react"
import { createTempRepository } from "../../helpers/temp-repository"
import { GitRunner } from "../../../src/git/runner"
import { loadReviewDocument } from "../../../src/review/git/load-review-document"
import { ReviewWorkspaceController } from "../../../src/ui/review-workspace/controller"
import { ReactReviewSession } from "../../../src/ui/review-workspace/react-review-session"
import { ReviewWorkspaceApp } from "../../../src/ui/review-workspace/ReviewWorkspaceApp"
import { ReviewBasePicker } from "../../../src/ui/review-workspace/components/ReviewBasePicker"

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true


async function flush(setup: TestRendererSetup): Promise<void> {
  await act(async () => {
    await setup.renderOnce()
    await Bun.sleep(0)
    await setup.renderOnce()
  })
}

async function settle(setup: TestRendererSetup, ready: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100 && !ready(); attempt += 1) {
    await act(async () => { await Bun.sleep(10) })
    await flush(setup)
  }
  expect(ready()).toBe(true)
}

function element(setup: TestRendererSetup, id: string) {
  const found = setup.renderer.root.findDescendantById(id)
  if (!found) throw new Error(`missing ${id}`)
  return found
}

async function repositoryWithBases(extraBranches = 0) {
  const repository = await createTempRepository()
  await repository.git(["branch", "-m", "main"])
  await repository.write("file.txt", "base\n")
  await repository.git(["add", "."])
  await repository.git(["commit", "-qm", "base"])
  await repository.git(["branch", "aaa-main-copy"])
  await repository.git(["branch", "release"])
  for (let index = 0; index < extraBranches; index += 1) {
    await repository.git(["branch", `candidate-${String(index).padStart(2, "0")}`])
  }
  await repository.git(["checkout", "-qb", "feature"])
  await repository.write("file.txt", "feature\n")
  await repository.git(["commit", "-qam", "feature"])
  return repository
}

describe("review base picker interactions", () => {
  test("filters ranked bases before the first review and switches only from the base header target", async () => {
    const repository = await repositoryWithBases()
    const controller = new ReviewWorkspaceController({ runner: new GitRunner(repository.path) })
    await controller.open()
    let closes = 0
    const setup = await testRender(<ReviewWorkspaceApp session={new ReactReviewSession(controller, () => { closes += 1 })} />, { width: 100, height: 24, useMouse: true, kittyKeyboard: true })
    try {
      await flush(setup)
      expect(controller.state).toBeUndefined()
      await act(async () => { await setup.mockInput.typeText("main") })
      await flush(setup)
      const recommended = element(setup, "review-base-row:refs/heads/main")
      const alternate = element(setup, "review-base-row:refs/heads/aaa-main-copy")
      expect(recommended.y).toBeLessThan(alternate.y)
      await act(async () => { setup.mockInput.pressEnter() })
      await settle(setup, () => controller.state !== undefined && controller.baseSelection === undefined)
      expect(controller.state?.document.identity.baseRef).toBe("refs/heads/main")
      const header = element(setup, "react-review-header")
      await act(async () => { await setup.mockMouse.click(header.x, header.y) })
      await flush(setup)
      expect(controller.baseSelection).toBeUndefined()
      const base = element(setup, "review-base-selector")
      await act(async () => { await setup.mockMouse.click(base.x, base.y) })
      await settle(setup, () => controller.baseSelection?.loading === false)
      await act(async () => { await setup.mockInput.typeText("release") })
      await flush(setup)
      expect(controller.state?.filter.query).toBe("")
      const release = element(setup, "review-base-row:refs/heads/release")
      await act(async () => { await setup.mockMouse.click(release.x + 1, release.y) })
      await settle(setup, () => controller.baseSelection === undefined)
      expect(controller.state?.document.identity.baseRef).toBe("refs/heads/release")
      await act(async () => { setup.mockInput.pressKey("B", { shift: true }) })
      await settle(setup, () => controller.baseSelection?.loading === false)
      await act(async () => { setup.mockInput.pressEscape() })
      await flush(setup)
      expect(controller.baseSelection).toBeUndefined()
      expect(controller.state?.document.identity.baseRef).toBe("refs/heads/release")
      expect(closes).toBe(0)
      await act(async () => { setup.mockInput.pressKey("?") })
      await flush(setup)
      expect(setup.captureCharFrame()).toContain("B Change base branch")
    } finally {
      await act(async () => setup.renderer.destroy())
      await controller.destroy()
      await repository.cleanup()
    }
  })

  test("keeps keyboard selection visible in a short terminal and makes the visible row clickable", async () => {
    const repository = await repositoryWithBases(20)
    const controller = new ReviewWorkspaceController({ runner: new GitRunner(repository.path) })
    await controller.open()
    const setup = await testRender(<ReviewWorkspaceApp session={new ReactReviewSession(controller, () => undefined)} />, { width: 50, height: 12, useMouse: true, kittyKeyboard: true })
    try {
      await flush(setup)
      await act(async () => { await setup.mockInput.typeText("candidate-") })
      await flush(setup)
      for (let index = 0; index < 15; index += 1) {
        await act(async () => { setup.mockInput.pressArrow("down") })
        await flush(setup)
      }
      const selected = element(setup, "review-base-row:refs/heads/candidate-15")
      const picker = element(setup, "review-base-picker")
      expect(selected.y).toBeGreaterThan(picker.y)
      expect(selected.y).toBeLessThan(picker.y + picker.height - 1)
      expect(picker.x + picker.width).toBeLessThanOrEqual(50)
      expect(picker.y + picker.height).toBeLessThanOrEqual(12)
      expect(setup.captureCharFrame()).toContain("candidate-15")
      await act(async () => { await setup.mockMouse.click(selected.x + 1, selected.y) })
      await settle(setup, () => controller.baseSelection === undefined)
      expect(controller.state?.document.identity.baseRef).toBe("refs/heads/candidate-15")
    } finally {
      await act(async () => setup.renderer.destroy())
      await controller.destroy()
      await repository.cleanup()
    }
  })

  test("owns pending input, keeps failed selection retryable, and closes initial selection with Escape", async () => {
    const repository = await repositoryWithBases()
    const runner = new GitRunner(repository.path)
    let releaseLoad!: () => void
    const pendingLoad = new Promise<void>((resolve) => { releaseLoad = resolve })
    let fail = true
    const controller = new ReviewWorkspaceController({ runner, loadDocument: async (ref) => {
      await pendingLoad
      if (fail) throw new Error("base became unavailable")
      return loadReviewDocument(runner, ref)
    } })
    await controller.open()
    let closes = 0
    const setup = await testRender(<ReviewWorkspaceApp session={new ReactReviewSession(controller, () => { closes += 1 })} />, { width: 100, height: 24, useMouse: true, kittyKeyboard: true })
    try {
      await flush(setup)
      await act(async () => { setup.mockInput.pressEnter() })
      await settle(setup, () => controller.baseSelection?.selecting === true)
      await act(async () => {
        await setup.mockInput.typeText("/rRc")
        setup.mockInput.pressEscape()
      })
      await flush(setup)
      expect(controller.state).toBeUndefined()
      expect(closes).toBe(0)
      releaseLoad()
      await settle(setup, () => controller.baseSelection?.error !== undefined)
      expect(setup.captureCharFrame()).toContain("base became unavailable")
      fail = false
      const retry = element(setup, "review-base-retry")
      await act(async () => { await setup.mockMouse.click(retry.x, retry.y) })
      await settle(setup, () => controller.baseSelection?.loading === false && controller.baseSelection.error === undefined)
      await act(async () => { setup.mockInput.pressEscape() })
      await flush(setup)
      expect(closes).toBe(1)
      expect(controller.state).toBeUndefined()
    } finally {
      releaseLoad()
      await act(async () => setup.renderer.destroy())
      await controller.destroy()
      await repository.cleanup()
    }
  })
  test("surfaces selection errors on short terminals without the detail row", async () => {
    const setup = await testRender(<ReviewBasePicker selection={{ candidates: [], loading: false, selecting: false, error: "base became unavailable" }} width={60} height={8} active={true} onChoose={() => {}} onCancel={() => {}} onRetry={() => {}} />, { width: 60, height: 8, useMouse: true, kittyKeyboard: true })
    try {
      await flush(setup)
      expect(setup.captureCharFrame()).toContain("base became unavailable")
    } finally {
      await act(async () => setup.renderer.destroy())
    }
  })
})
