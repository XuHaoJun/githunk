/// <reference lib="webworker" />
import { loadHighlightForPatch } from "./highlight-adapter"

type WorkerRequest = {
  version: 1
  id: number
  patch: string
  fileKey: string
  appearance: "dark" | "light"
}

type WorkerResponse =
  | { version: 1; id: number; ok: true; payload: import("./highlight-payload").HighlightPayload | null }
  | { version: 1; id: number; ok: false; message: string }

declare const self: Worker

self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const { id, patch, fileKey, appearance, version } = event.data
  try {
    if (version !== 1) throw new Error(`unsupported highlight worker protocol: ${String(version)}`)
    const payload = await loadHighlightForPatch(patch, fileKey, appearance)
    const response: WorkerResponse = { version: 1, id, ok: true, payload }
    self.postMessage(response)
  } catch (error) {
    const response: WorkerResponse = { version: 1, id, ok: false, message: error instanceof Error ? error.message : String(error) }
    self.postMessage(response)
  }
}
