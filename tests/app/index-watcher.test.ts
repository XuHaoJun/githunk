import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { IndexWatcher } from "../../src/app/index-watcher"

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

describe("IndexWatcher", () => {
  let directory: string | undefined
  let watcher: IndexWatcher | undefined

  afterEach(async () => {
    watcher?.stop()
    watcher = undefined
    if (directory !== undefined) await rm(directory, { recursive: true, force: true })
    directory = undefined
  })

  async function createIndex(): Promise<string> {
    directory = await mkdtemp(join(tmpdir(), "githunk-index-watcher-"))
    const indexPath = join(directory, "index")
    await writeFile(indexPath, "before")
    return indexPath
  }

  test("debounces index and lock events into one external refresh", async () => {
    const indexPath = await createIndex()
    let refreshes = 0
    watcher = new IndexWatcher({ indexPath, onExternalChange: async () => { refreshes++ }, debounceMs: 25 })
    watcher.start()

    await writeFile(join(directory!, "index.lock"), "after")
    await rename(join(directory!, "index.lock"), indexPath)
    await waitFor(() => refreshes === 1)
    await new Promise((resolve) => setTimeout(resolve, 75))
    expect(refreshes).toBe(1)
  })


  test("retries an index event after a busy mutation settles", async () => {
    const indexPath = await createIndex()
    let busy = true
    let refreshes = 0
    watcher = new IndexWatcher({ indexPath, onExternalChange: async () => { refreshes++ }, isBusy: () => busy, debounceMs: 25 })
    watcher.start()

    await writeFile(indexPath, "external")
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(refreshes).toBe(0)
    busy = false
    await waitFor(() => refreshes === 1)
    expect(refreshes).toBe(1)
  })

  test("stop prevents later index events from refreshing", async () => {
    const indexPath = await createIndex()
    let refreshes = 0
    watcher = new IndexWatcher({ indexPath, onExternalChange: async () => { refreshes++ }, debounceMs: 25 })
    watcher.start()
    watcher.stop()

    await mkdir(join(directory!, "unused"))
    await writeFile(indexPath, "after-stop")
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(refreshes).toBe(0)
  })
})
