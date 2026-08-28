import type { HighlightPayload } from "./highlight-payload"

export class HighlightCache {
  private readonly map = new Map<string, HighlightPayload>()
  constructor(private readonly maxSize: number = 50) {}

  cacheKey(fileKey: string, contentId: string, generationId: string, theme: string): string {
    return `${fileKey}\0${contentId}\0${generationId}\0${theme}`
  }

  get(key: string): HighlightPayload | undefined {
    const value = this.map.get(key)
    if (value === undefined) return undefined
    // LRU: move to end
    this.map.delete(key)
    this.map.set(key, value)
    return value
  }

  set(key: string, payload: HighlightPayload): void {
    if (this.map.has(key)) this.map.delete(key)
    this.map.set(key, payload)
    while (this.map.size > this.maxSize) {
      const first = this.map.keys().next().value as string | undefined
      if (first === undefined) break
      this.map.delete(first)
    }
  }

  invalidateGeneration(generationId: string): void {
    const needle = `\0${generationId}\0`
    for (const key of [...this.map.keys()]) {
      if (key.includes(needle)) this.map.delete(key)
    }
  }

  clear(): void {
    this.map.clear()
  }

  size(): number {
    return this.map.size
  }
}
