import { useEffect, useMemo, useState } from "react"
import type { ReviewState } from "../../../review/core/state"
import { HighlightCache } from "../../../review/git/highlight/highlight-cache"
import { loadHighlightForPatch } from "../../../review/git/highlight/highlight-adapter"
import type { HighlightPayload } from "../../../review/git/highlight/highlight-payload"
import { highlightInWorker, isWorkerAvailable } from "../../../review/git/highlight/highlight-worker-client"
import { patchForHunkReviewFile, type HunkReviewFile } from "../hunk-review-model"

export type ReviewHighlightLoader = (
  file: HunkReviewFile,
  appearance: "dark" | "light",
) => Promise<HighlightPayload | null>

export type UseReviewHighlightsOptions = Readonly<{
  files: readonly HunkReviewFile[]
  state?: ReviewState
  reviewId?: string
  generationId?: string
  selectedFileKey?: string | null
  requestedFileKeys?: readonly string[]
  appearance?: "dark" | "light"
  enabled?: boolean
  loadHighlight?: ReviewHighlightLoader
}>

export type ReviewHighlightResult = Readonly<{
  highlights: ReadonlyMap<string, HighlightPayload>
  loading: boolean
}>

const sharedCache = new HighlightCache(50)
const pendingByKey = new Map<string, Promise<HighlightPayload | null>>()

function defaultLoader(file: HunkReviewFile, appearance: "dark" | "light"): Promise<HighlightPayload | null> {
  const patch = patchForHunkReviewFile(file.reviewFile)
  if (patch.length === 0) return Promise.resolve(null)
  const changedLines = file.metadata.deletionLines.length + file.metadata.additionLines.length
  if (changedLines > 10_000) return Promise.resolve(null)
  if (changedLines > 40 && isWorkerAvailable()) {
    return highlightInWorker(patch, file.id, appearance).catch(() => null)
  }
  return loadHighlightForPatch(patch, file.id, appearance)
}

function cacheKey(
  file: HunkReviewFile,
  reviewId: string,
  generationId: string,
  appearance: "dark" | "light",
): string {
  return `${reviewId}\0${generationId}\0${sharedCache.cacheKey(file.id, file.reviewFile.contentId, generationId, appearance)}`
}

function loadShared(
  file: HunkReviewFile,
  reviewId: string,
  generationId: string,
  appearance: "dark" | "light",
  loader: ReviewHighlightLoader,
): Promise<HighlightPayload | null> {
  const key = cacheKey(file, reviewId, generationId, appearance)
  const cached = sharedCache.get(key)
  if (cached) return Promise.resolve(cached)
  const existing = pendingByKey.get(key)
  if (existing) return existing

  let pending: Promise<HighlightPayload | null>
  pending = loader(file, appearance)
    .then((payload) => {
      if (payload) sharedCache.set(key, payload)
      return payload
    })
    .finally(() => {
      if (pendingByKey.get(key) === pending) pendingByKey.delete(key)
    })
  pendingByKey.set(key, pending)
  return pending
}

function prioritizedFiles(
  files: readonly HunkReviewFile[],
  selectedFileKey: string | null | undefined,
  requestedFileKeys: readonly string[] | undefined,
): readonly HunkReviewFile[] {
  const byId = new Map(files.map((file) => [file.id, file]))
  const selectedIndex = selectedFileKey ? files.findIndex((file) => file.id === selectedFileKey) : -1
  const ids: string[] = []
  const add = (id: string | undefined) => {
    if (id && byId.has(id) && !ids.includes(id)) ids.push(id)
  }
  add(selectedFileKey ?? undefined)
  if (selectedIndex > 0) add(files[selectedIndex - 1]?.id)
  if (selectedIndex >= 0) add(files[selectedIndex + 1]?.id)
  for (const id of requestedFileKeys ?? []) add(id)
  for (const file of files) {
    if (ids.length >= 10) break
    add(file.id)
  }
  return ids.map((id) => byId.get(id)!).filter(Boolean)
}

export function useReviewHighlights(options: UseReviewHighlightsOptions): ReviewHighlightResult {
  const {
    files,
    state,
    selectedFileKey,
    requestedFileKeys,
    appearance = "dark",
    enabled = true,
    loadHighlight = defaultLoader,
  } = options
  const reviewId = options.reviewId ?? state?.document.identity.id ?? "review"
  const generationId = options.generationId ?? state?.document.generation.id ?? "generation"
  const requestedKey = useMemo(
    () => requestedFileKeys?.join("\0") ?? "",
    [requestedFileKeys],
  )
  const [highlights, setHighlights] = useState<ReadonlyMap<string, HighlightPayload>>(new Map())
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    let cancelled = false
    if (!enabled || files.length === 0) {
      setHighlights(new Map())
      setLoading(false)
      return () => {
        cancelled = true
      }
    }

    const requested = requestedKey.length > 0 ? requestedKey.split("\0") : undefined
    const selected = prioritizedFiles(files, selectedFileKey, requested)
    setHighlights(new Map())
    setLoading(selected.length > 0)
    void Promise.all(
      selected.map(async (file) => ({
        file,
        payload: await loadShared(file, reviewId, generationId, appearance, loadHighlight),
      })),
    ).then((results) => {
      if (cancelled) return
      const next = new Map<string, HighlightPayload>()
      for (const result of results) {
        if (result.payload) next.set(result.file.id, result.payload)
      }
      setHighlights(next)
      setLoading(false)
    }, () => {
      if (!cancelled) setLoading(false)
    })

    return () => {
      cancelled = true
    }
  }, [appearance, enabled, files, generationId, loadHighlight, requestedKey, reviewId, selectedFileKey])

  return { highlights, loading }
}
