import type { HighlightPayload } from "./highlight-payload"

type WorkerRequest = {
  id: number
  patch: string
  fileKey: string
  appearance: "dark" | "light"
}

type WorkerResponse =
  | { id: number; ok: true; payload: HighlightPayload | null }
  | { id: number; ok: false; message: string }

type Pending = {
  id: number
  resolve: (v: HighlightPayload | null) => void
  reject: (e: Error) => void
}

let worker: Worker | null = null
let nextId = 1
let active: Pending | null = null
const queue: Pending[] = []
const pendingById = new Map<number, Pending>()

function getWorker(): Worker | null {
  if (worker) return worker
  try {
    worker = new Worker(new URL("./highlight-worker.ts", import.meta.url))
    worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const data = event.data
      const pending = pendingById.get(data.id)
      if (!pending) return
      pendingById.delete(data.id)
      if (active && active.id === data.id) {
        active = null
      } else {
        // Remove from queue if it was queued (not active)
        const idx = queue.findIndex((p) => p.id === data.id)
        if (idx >= 0) queue.splice(idx, 1)
      }
      if (data.ok) pending.resolve(data.payload)
      else pending.reject(new Error(data.message))
      runNext()
    }
    worker.onerror = (event) => {
      const err = new Error((event as unknown as { message?: string }).message || "highlight worker error")
      // Fail all pending
      if (active) {
        active.reject(err)
        active = null
      }
      for (const p of queue) p.reject(err)
      queue.length = 0
      pendingById.clear()
      try {
        worker?.terminate()
      } catch {}
      worker = null
    }
    return worker
  } catch {
    return null
  }
}

function runNext(): void {
  if (active) return
  const next = queue.shift()
  if (!next) return
  active = next
  const w = getWorker()
  if (!w) {
    next.reject(new Error("worker unavailable"))
    active = null
    runNext()
    return
  }
  // Find request data for this pending - we need to store patch etc. alongside pending
  // To avoid extra map, we attach request to pending via closure? Instead we store pending with request.
  // For simplicity, we will keep request data in a separate map
  const req = requestById.get(next.id)
  if (!req) {
    next.reject(new Error("missing request"))
    active = null
    runNext()
    return
  }
  w.postMessage(req)
}

const requestById = new Map<number, WorkerRequest>()

export function highlightInWorker(patch: string, fileKey: string, appearance: "dark" | "light"): Promise<HighlightPayload | null> {
  const w = getWorker()
  if (!w) return Promise.reject(new Error("worker unavailable"))
  const id = nextId++
  const req: WorkerRequest = { id, patch, fileKey, appearance }
  const { promise, resolve, reject } = Promise.withResolvers<HighlightPayload | null>()
  const pending: Pending = { id, resolve, reject }
  pendingById.set(id, pending)
  requestById.set(id, req)
  queue.push(pending)
  // Clean up request after settle
  const origResolve = pending.resolve
  const origReject = pending.reject
  pending.resolve = (v) => {
    requestById.delete(id)
    origResolve(v)
  }
  pending.reject = (e) => {
    requestById.delete(id)
    origReject(e)
  }
  if (!active) runNext()
  return promise
}

export function disposeHighlightWorker(): void {
  try {
    worker?.terminate()
  } catch {}
  worker = null
  if (active) {
    active.reject(new Error("disposed"))
    active = null
  }
  for (const p of queue) p.reject(new Error("disposed"))
  queue.length = 0
  pendingById.clear()
  requestById.clear()
}

export function isWorkerAvailable(): boolean {
  return getWorker() !== null
}
