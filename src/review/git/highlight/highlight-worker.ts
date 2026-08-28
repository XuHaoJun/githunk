/// <reference lib="webworker" />
import { loadHighlightForPatch } from "./highlight-adapter"

type WorkerRequest = {
  id: number
  patch: string
  fileKey: string
  appearance: "dark" | "light"
}

type WorkerResponse =
  | { id: number; ok: true; payload: import("./highlight-payload").HighlightPayload | null }
  | { id: number; ok: false; message: string }

declare const self: Worker

self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const { id, patch, fileKey, appearance } = event.data
  try {
    const payload = await loadHighlightForPatch(patch, fileKey, appearance)
    const response: WorkerResponse = { id, ok: true, payload }
    ;(self as unknown as { postMessage: (msg: WorkerResponse) => void }).postMessage(response)
  } catch (e) {
    const response: WorkerResponse = { id, ok: false, message: e instanceof Error ? e.message : String(e) }
    ;(self as unknown as { postMessage: (msg: WorkerResponse) => void }).postMessage(response)
  }
}
