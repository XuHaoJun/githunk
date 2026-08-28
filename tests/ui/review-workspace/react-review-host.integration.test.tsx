import { describe, expect, test } from "bun:test"
import { createTestRenderer } from "@opentui/core/testing"
import { act } from "react"
import type { CliRenderer } from "@opentui/core"
import { ReactReviewHost } from "../../../src/ui/review-workspace/react-review-host"
import { ReviewWorkspaceController } from "../../../src/ui/review-workspace/controller"
import { highlightInWorker, registerHighlightWorker } from "../../../src/review/git/highlight/highlight-worker-client"
import { createReviewDocument, createReviewHunk } from "../../../src/review/core/document"
import { createReviewGeneration, createReviewIdentity } from "../../../src/review/core/identity"
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
type SilentWorker = Worker & { terminated: boolean }

function silentWorker(): SilentWorker {
  const worker = {
    terminated: false,
    postMessage() {},
    terminate() {
      worker.terminated = true
      return Promise.resolve(0)
    },
    unref() {},
    onmessage: null,
    onerror: null,
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() { return false },
  } as unknown as SilentWorker
  return worker
}
function controllerWithReviewState(): ReviewWorkspaceController {
  const file = {
    key: "src/leak.ts",
    path: "src/leak.ts",
    kind: "modified" as const,
    oldBlobOid: "1".repeat(40),
    newBlobOid: "2".repeat(40),
    oldMode: "100644",
    newMode: "100644",
    contentId: "content-leak",
    patchDigest: "patch-leak",
    stats: { additions: 1, deletions: 1 },
    hunks: [createReviewHunk({ index: 0, oldStart: 1, oldCount: 1, newStart: 1, newCount: 1, lines: ["-old", "+new"] })],
    source: "available" as const,
  }
  const identity = createReviewIdentity({ headRef: "refs/heads/feature", headOid: "a".repeat(40), baseRef: "refs/heads/main" })
  const generation = createReviewGeneration({ baseOid: "b".repeat(40), mergeBaseOid: "c".repeat(40), headOid: "a".repeat(40) })
  const document = createReviewDocument({ identity, generation, commits: [], files: [file] })
  return new ReviewWorkspaceController({
    runner: {} as never,
    loadDocument: async () => document,
  })
}

describe("React review host lifecycle", () => {
  test("unmounts its OpenTUI tree before the renderer owns shutdown", async () => {
    const setup = await createTestRenderer({ width: 100, height: 30 })
    const controller = {
      state: undefined,
      error: undefined,
      subscribe: () => () => undefined,
      getExpandedSourceByGap: () => new Map(),
    } as unknown as ReviewWorkspaceController
    let host!: ReactReviewHost

    try {
      await act(async () => {
        host = new ReactReviewHost(setup.renderer as unknown as CliRenderer, controller, () => undefined)
        await setup.renderOnce()
        await Bun.sleep(0)
        await setup.renderOnce()
      })
      expect(setup.renderer.root.findDescendantById("react-review-workspace")).toBeDefined()

      await act(async () => host.destroy())
      await act(async () => {
        await setup.renderOnce()
        await Bun.sleep(0)
        await setup.renderOnce()
      })
      expect(setup.renderer.root.findDescendantById("react-review-workspace")).toBeUndefined()

      expect(() => host.destroy()).not.toThrow()
    } finally {
      await act(async () => setup.renderer.destroy())
    }
  })
  test("disposes highlight work when the React tree unmounts", async () => {
    const setup = await createTestRenderer({ width: 100, height: 30 })
    const controller = {
      state: undefined,
      error: undefined,
      subscribe: () => () => undefined,
      getExpandedSourceByGap: () => new Map(),
    } as unknown as ReviewWorkspaceController
    const worker = silentWorker()
    registerHighlightWorker(worker)
    const request = highlightInWorker("diff --git a/a.ts b/a.ts\n", "a.ts", "dark")
    const rejection = request.catch((error: unknown) => error)
    let host!: ReactReviewHost
    try {
      await act(async () => {
        host = new ReactReviewHost(setup.renderer as unknown as CliRenderer, controller, () => undefined)
        host.destroy()
      })
      const error = await rejection
      expect(error).toBeInstanceOf(Error)
      expect((error as Error).message).toContain("disposed")
      expect(worker.terminated).toBe(true)
    } finally {
      await act(async () => setup.renderer.destroy())
    }
  })
  test("repeated mount and unmount does not leak renderer listeners", async () => {
    const setup = await createTestRenderer({ width: 100, height: 20, useMouse: true })
    const controller = controllerWithReviewState()
    await controller.open("main")
    const renderer = setup.renderer as unknown as {
      listenerCount: (event: string) => number
      keyInput: { listenerCount: (event: string) => number }
    }

    try {
      await act(async () => {
        const firstHost = new ReactReviewHost(setup.renderer as unknown as CliRenderer, controller, () => undefined)
        firstHost.destroy()
      })
      const afterFirst = {
        selection: renderer.listenerCount("selection"),
        resize: renderer.listenerCount("resize"),
        destroy: renderer.listenerCount("destroy"),
        keypress: renderer.keyInput.listenerCount("keypress"),
      }
      for (let index = 0; index < 11; index += 1) {
        await act(async () => {
          const host = new ReactReviewHost(setup.renderer as unknown as CliRenderer, controller, () => undefined)
          host.destroy()
        })
      }
      expect(renderer.listenerCount("selection")).toBe(afterFirst.selection)
      expect(renderer.listenerCount("resize")).toBe(afterFirst.resize)
      expect(renderer.listenerCount("destroy")).toBe(afterFirst.destroy)
      expect(renderer.keyInput.listenerCount("keypress")).toBe(afterFirst.keypress)
    } finally {
      controller.destroy()
      await act(async () => setup.renderer.destroy())
    }
  })
})
