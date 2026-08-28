import { describe, expect, test } from "bun:test"
import {
  disposeHighlightWorker,
  highlightInWorker,
  registerHighlightWorker,
} from "../../../src/review/git/highlight/highlight-worker-client"

type WorkerHarness = Worker & { terminated: boolean }

function silentWorker(): WorkerHarness {
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
  } as unknown as WorkerHarness
  return worker
}

describe("review highlight worker lifecycle", () => {
  test("disposing the shared worker settles an active request", async () => {
    const worker = silentWorker()
    registerHighlightWorker(worker)
    const request = highlightInWorker("diff --git a/a.ts b/a.ts\n", "a.ts", "dark")

    disposeHighlightWorker()

    await expect(request).rejects.toThrow("disposed")
    expect(worker.terminated).toBe(true)
  })
  test("times out an unresponsive worker instead of leaving a pending promise", async () => {
    const worker = silentWorker()
    registerHighlightWorker(worker)
    const request = highlightInWorker("diff --git a/a.ts b/a.ts\n", "a.ts", "dark", 10)

    await expect(request).rejects.toThrow("timed out")
    expect(worker.terminated).toBe(true)
    disposeHighlightWorker()
  })
})
