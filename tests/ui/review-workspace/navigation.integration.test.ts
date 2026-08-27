import { describe, expect, test } from "bun:test"
import { ReviewWorkspaceController } from "../../../src/ui/review-workspace/controller"
import { ReviewWorkspace } from "../../../src/ui/review-workspace/review-workspace"
import { createReviewDocument } from "../../../src/review/core/document"
import { createReviewGeneration, createReviewIdentity } from "../../../src/review/core/identity"
import { createReviewHunk } from "../../../src/review/core/document"
import { createTestRenderer } from "@opentui/core/testing"
import type { CliRenderer } from "@opentui/core"
import type { GitRunner } from "../../../src/git/runner"

function makeDoc() {
  const identity = createReviewIdentity({ headRef: "refs/heads/feature", headOid: "a".repeat(40), baseRef: "refs/heads/main" })
  const generation = createReviewGeneration({ baseOid: "b".repeat(40), mergeBaseOid: "c".repeat(40), headOid: "a".repeat(40) })
  return createReviewDocument({
    identity,
    generation,
    commits: [{ oid: "a".repeat(40), parents: [], author: "A", timestamp: 0, subject: "s", body: "" }],
    files: [
      { key: "src/a.ts", path: "src/a.ts", kind: "modified", oldBlobOid: "o1", newBlobOid: "n1", oldMode: "100644", newMode: "100644", contentId: "c-a", patchDigest: "p1", stats: { additions: 1, deletions: 1 }, hunks: [createReviewHunk({ index: 0, oldStart: 1, oldCount: 1, newStart: 1, newCount: 1, lines: ["-old", "+new"] })], source: "available" },
      { key: "src/b.ts", path: "src/b.ts", kind: "modified", oldBlobOid: "o2", newBlobOid: "n2", oldMode: "100644", newMode: "100644", contentId: "c-b", patchDigest: "p2", stats: { additions: 2, deletions: 2 }, hunks: [createReviewHunk({ index: 0, oldStart: 1, oldCount: 1, newStart: 1, newCount: 1, lines: ["-a", "+b"] })], source: "available" },
      { key: "src/c.ts", path: "src/c.ts", kind: "modified", oldBlobOid: "o3", newBlobOid: "n3", oldMode: "100644", newMode: "100644", contentId: "c-c", patchDigest: "p3", stats: { additions: 3, deletions: 3 }, hunks: [createReviewHunk({ index: 0, oldStart: 1, oldCount: 1, newStart: 1, newCount: 1, lines: ["-x", "+y"] })], source: "available" },
    ],
  })
}

function fakeRunner(): GitRunner {
  return { run: async () => ({ stdout: "", stderr: "", exitCode: 0 }) } as unknown as GitRunner
}

describe("navigation integration — keyboard/mouse routing", () => {
  test("sidebar click dispatches selection/select-file", async () => {
    const controller = new ReviewWorkspaceController({ runner: fakeRunner(), loadDocument: async () => makeDoc() })
    await controller.open("refs/heads/main")
    const dispatches: unknown[] = []
    const orig = controller.dispatch.bind(controller)
    controller.dispatch = ((a: unknown) => {
      dispatches.push(a)
      return orig(a as never)
    }) as typeof controller.dispatch
    const setup = await createTestRenderer({ width: 80, height: 24 })
    const ws = new ReviewWorkspace(setup.renderer as unknown as CliRenderer, controller, { onClose: () => {} })
    const ok = ws.handleSidebarClick("src/b.ts")
    expect(ok).toBe(true)
    expect(dispatches.some((a) => (a as { type: string }).type === "selection/select-file")).toBe(true)
    ws.destroy()
    setup.renderer.destroy()
  })

  test("r dispatches markViewed only when projection permits", async () => {
    const runner = fakeRunner()
    const controllerAgg = new ReviewWorkspaceController({ runner, loadDocument: async () => makeDoc() })
    await controllerAgg.open("refs/heads/main")
    const setup1 = await createTestRenderer({ width: 80, height: 24 })
    const wsAgg = new ReviewWorkspace(setup1.renderer as unknown as CliRenderer, controllerAgg)
    const aggDispatches: unknown[] = []
    const origAgg = controllerAgg.dispatch.bind(controllerAgg)
    controllerAgg.dispatch = ((a: unknown) => {
      aggDispatches.push(a)
      return origAgg(a as never)
    }) as typeof controllerAgg.dispatch
    wsAgg.handleKeyPress("r")
    expect(aggDispatches.some((a) => (a as { type: string }).type === "viewed/mark")).toBe(true)
    wsAgg.destroy()
    setup1.renderer.destroy()

    const controllerCommit = new ReviewWorkspaceController({ runner, loadDocument: async () => makeDoc() })
    await controllerCommit.open("refs/heads/main")
    controllerCommit.dispatch({ type: "projection/set", projection: { kind: "commit", oid: "abc".repeat(13) } })
    const setup2 = await createTestRenderer({ width: 80, height: 24 })
    const wsCommit = new ReviewWorkspace(setup2.renderer as unknown as CliRenderer, controllerCommit)
    const commitDispatches: unknown[] = []
    const origCommit = controllerCommit.dispatch.bind(controllerCommit)
    controllerCommit.dispatch = ((a: unknown) => {
      commitDispatches.push(a)
      return origCommit(a as never)
    }) as typeof controllerCommit.dispatch
    wsCommit.handleKeyPress("r")
    expect(commitDispatches.filter((a) => (a as { type: string }).type === "viewed/mark")).toHaveLength(0)
    // also verify planReviewIntent would throw for commit
    const { planReviewIntent } = await import("../../../src/review/core/intents")
    let threw = false
    try {
      planReviewIntent(controllerCommit.state!, { type: "viewed/mark", fileKey: "src/a.ts", viewedAt: new Date().toISOString() })
    } catch {
      threw = true
    }
    expect(threw).toBe(true)
    wsCommit.destroy()
    setup2.renderer.destroy()
  })

  test("/ focuses filter and tab changes focus", async () => {
    const controller = new ReviewWorkspaceController({ runner: fakeRunner(), loadDocument: async () => makeDoc() })
    await controller.open("refs/heads/main")
    const setup = await createTestRenderer({ width: 80, height: 24 })
    const ws = new ReviewWorkspace(setup.renderer as unknown as CliRenderer, controller)
    expect(ws.getFocus()).toBe("stream")
    ws.handleKeyPress("/")
    expect(ws.getFocus()).toBe("filter")
    ws.handleKeyPress("tab")
    expect(ws.getFocus()).not.toBe("filter")
    ws.destroy()
    setup.renderer.destroy()
  })

  test("Escape follows overlay/composer/range/workspace priority", async () => {
    const controller = new ReviewWorkspaceController({ runner: fakeRunner(), loadDocument: async () => makeDoc() })
    await controller.open("refs/heads/main")
    let closed = false
    const setup = await createTestRenderer({ width: 80, height: 24 })
    const ws = new ReviewWorkspace(setup.renderer as unknown as CliRenderer, controller, { onClose: () => { closed = true } })
    ws.setRangeActive(true)
    ws.handleKeyPress("escape")
    expect(closed).toBe(false)
    expect(ws.isRangeActive()).toBe(false)
    ws.handleKeyPress("escape")
    expect(closed).toBe(true)
    ws.destroy()
    setup.renderer.destroy()
  })

  test("file/hunk keys dispatch core intents", async () => {
    const controller = new ReviewWorkspaceController({ runner: fakeRunner(), loadDocument: async () => makeDoc() })
    await controller.open("refs/heads/main")
    const before = controller.state!.selection.fileKey
    const setup = await createTestRenderer({ width: 80, height: 24 })
    const ws = new ReviewWorkspace(setup.renderer as unknown as CliRenderer, controller)
    ws.handleKeyPress(".")
    expect(controller.state!.selection.fileKey).not.toBe(before)
    ws.destroy()
    setup.renderer.destroy()
  })
})
