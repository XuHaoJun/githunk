import type { HighlightPayload } from "./highlight-payload"

type WorkerRequest = {
  version: 1
  id: number
  patch: string
  fileKey: string
  appearance: "dark" | "light"
}

type WorkerResponse =
  | { version: 1; id: number; ok: true; payload: HighlightPayload | null }
  | { version: 1; id: number; ok: false; message: string }

type Pending = {
  id: number
  request: WorkerRequest
  resolve: (value: HighlightPayload | null) => void
  reject: (error: Error) => void
  timer?: ReturnType<typeof setTimeout>
  timeoutMs?: number
}

export const HIGHLIGHT_WORKER_TIMEOUT_MS = 2_000

let worker: Worker | null = null
let workerFactory: (() => Worker) | undefined
let nextId = 1
let active: Pending | null = null
const queue: Pending[] = []

function unrefWorker(nextWorker: Worker): void {
  ;(nextWorker as Worker & { unref?: () => void }).unref?.()
}
function unrefTimer(timer: ReturnType<typeof setTimeout>): void {
  ;(timer as ReturnType<typeof setTimeout> & { unref?: () => void }).unref?.()
}

function terminateWorker(): void {
  const current = worker
  worker = null
  if (!current) return
  try {
    current.onmessage = null
    current.onerror = null
  } catch {}
  try {
    void current.terminate()
  } catch {}
}

function resetWorker(error: Error): void {
  const pending = [active, ...queue].filter((request): request is Pending => request !== null)
  active = null
  queue.length = 0
  for (const request of pending) {
    if (request.timer !== undefined) clearTimeout(request.timer)
    request.reject(error)
  }
  terminateWorker()
}

function handleWorkerError(event: ErrorEvent | Error): void {
  const message = event instanceof Error ? event.message : event.message
  resetWorker(new Error(message || "highlight worker error"))
}

function handleWorkerMessage(event: MessageEvent<WorkerResponse>): void {
  const response = event.data
  const request = active
  if (!request || response.version !== 1 || response.id !== request.id) return
  active = null
  if (request.timer !== undefined) clearTimeout(request.timer)
  if (response.ok) request.resolve(response.payload)
  else request.reject(new Error(response.message))
  runNext()
}

function createWorker(): Worker {
  const factory = workerFactory ?? (() => new Worker(new URL("./highlight-worker.ts", import.meta.url)))
  const nextWorker = factory()
  unrefWorker(nextWorker)
  nextWorker.onmessage = handleWorkerMessage
  nextWorker.onerror = handleWorkerError
  worker = nextWorker
  return nextWorker
}

function runNext(): void {
  if (active || queue.length === 0) return
  const request = queue.shift()!
  active = request
  let currentWorker: Worker
  try {
    currentWorker = worker ?? createWorker()
    currentWorker.postMessage(request.request)
  } catch (error) {
    resetWorker(error instanceof Error ? error : new Error(String(error)))
    return
  }
  const timeoutMs = request.timeoutMs ?? HIGHLIGHT_WORKER_TIMEOUT_MS
  request.timer = setTimeout(() => {
    if (active?.id !== request.id) return
    resetWorker(new Error(`highlight worker timed out after ${timeoutMs} ms`))
  }, timeoutMs)
  unrefTimer(request.timer)
}

export function registerHighlightWorker(nextWorker: Worker): Worker {
  if (worker && worker !== nextWorker) resetWorker(new Error("highlight worker was replaced"))
  unrefWorker(nextWorker)
  nextWorker.onmessage = handleWorkerMessage
  nextWorker.onerror = handleWorkerError
  worker = nextWorker
  return nextWorker
}

export function highlightInWorker(
  patch: string,
  fileKey: string,
  appearance: "dark" | "light",
  timeoutMs = HIGHLIGHT_WORKER_TIMEOUT_MS,
): Promise<HighlightPayload | null> {
  if (typeof Worker === "undefined" && worker === null && workerFactory === undefined) {
    return Promise.reject(new Error("worker unavailable"))
  }
  const id = nextId++
  const request: WorkerRequest = { version: 1, id, patch, fileKey, appearance }
  return new Promise<HighlightPayload | null>((resolve, reject) => {
    queue.push({ id, request, resolve, reject, timeoutMs })
    runNext()
  })
}

export function disposeHighlightWorker(): void {
  resetWorker(new Error("highlight worker disposed"))
}

export function isWorkerAvailable(): boolean {
  return worker !== null || typeof Worker !== "undefined"
}

export function setHighlightWorkerFactoryForTests(factory: (() => Worker) | undefined): void {
  resetWorker(new Error("highlight worker factory changed"))
  workerFactory = factory
}
