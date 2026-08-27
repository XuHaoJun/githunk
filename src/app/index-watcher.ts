import { watch, statSync, type FSWatcher } from "node:fs"
import { basename, dirname } from "node:path"

export type IndexWatcherOptions = {
  readonly indexPath: string
  readonly onExternalChange: () => Promise<void>
  readonly isBusy?: () => boolean
  readonly debounceMs?: number
}

export const DEFAULT_INDEX_EVENT_DEBOUNCE_MS = 50
const BUSY_RETRY_MS = 50

type IndexFingerprint = string | undefined

function fingerprint(path: string): IndexFingerprint {
  try {
    const info = statSync(path)
    return `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`
  } catch {
    return undefined
  }
}

function eventFileName(filename: string | Buffer | null): string | undefined {
  if (filename === null) return undefined
  return typeof filename === "string" ? filename : filename.toString()
}

/**
 * Refreshes working-tree state when Git changes the index.
 *
 * Git writes `.git/index.lock` and atomically renames it over `.git/index`, so the parent directory
 * is watched rather than the index file itself. The stat fingerprint filters duplicate fs events,
 * and busy mutations defer the refresh until the repository is stable.
 */
export class IndexWatcher {
  private readonly indexName: string
  private readonly lockName: string
  private readonly debounceMs: number
  private watcher: FSWatcher | undefined
  private timer: ReturnType<typeof setTimeout> | undefined
  private baseline: IndexFingerprint
  private pending = false
  private running = false
  private stopped = true

  constructor(private readonly options: IndexWatcherOptions) {
    this.indexName = basename(options.indexPath)
    this.lockName = `${this.indexName}.lock`
    this.debounceMs = options.debounceMs ?? DEFAULT_INDEX_EVENT_DEBOUNCE_MS
    this.baseline = undefined
  }

  start(): void {
    if (!this.stopped) return
    this.stopped = false
    this.baseline = fingerprint(this.options.indexPath)
    try {
      const watcher = watch(dirname(this.options.indexPath), { persistent: false }, (_eventType, filename) => {
        if (this.stopped) return
        const name = eventFileName(filename)
        if (name !== undefined && name !== this.indexName && name !== this.lockName) return
        this.pending = true
        this.schedule(this.debounceMs)
      })
      this.watcher = watcher
      watcher.on("error", () => this.stop())
    } catch {
      this.stopped = true
    }
  }

  stop(): void {
    this.stopped = true
    this.pending = false
    if (this.timer !== undefined) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
    this.watcher?.close()
    this.watcher = undefined
  }

  private schedule(delayMs: number): void {
    if (this.stopped) return
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.flush().catch(() => undefined)
    }, delayMs)
  }

  private async flush(): Promise<void> {
    if (this.stopped || !this.pending || this.running) return
    if (this.options.isBusy?.() === true) {
      this.schedule(BUSY_RETRY_MS)
      return
    }
    const current = fingerprint(this.options.indexPath)
    if (current === this.baseline) {
      this.pending = false
      return
    }
    this.baseline = current
    this.pending = false
    this.running = true
    try {
      await this.options.onExternalChange()
    } finally {
      this.running = false
      if (this.pending) this.schedule(this.debounceMs)
    }
  }
}
