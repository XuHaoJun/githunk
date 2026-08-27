import { describe, expect, test } from "bun:test"
import {
  BackgroundRefresher,
  DEFAULT_FETCH_INTERVAL_MS,
  DEFAULT_REFRESH_INTERVAL_MS,
  type Timers,
} from "../../src/app/background"

/** A hand-cranked clock, so the intervals under test are asserted rather than waited out. */
function fakeTimers(): Timers & { advance(ms: number): void; pending(): number } {
  type Entry = { readonly at: number; readonly callback: () => void; cancelled: boolean }
  const entries: Entry[] = []
  let now = 0
  return {
    setTimeout(callback: () => void, ms: number): unknown {
      const entry: Entry = { at: now + ms, callback, cancelled: false }
      entries.push(entry)
      return entry
    },
    clearTimeout(handle: unknown): void {
      const entry = handle as Entry | undefined
      if (entry !== undefined) entry.cancelled = true
    },
    advance(ms: number): void {
      const target = now + ms
      for (;;) {
        const next = entries.filter((entry) => !entry.cancelled && entry.at <= target).sort((a, b) => a.at - b.at)[0]
        if (next === undefined) break
        next.cancelled = true
        now = next.at
        next.callback()
      }
      now = target
    },
    pending(): number {
      return entries.filter((entry) => !entry.cancelled).length
    },
  }
}

describe("BackgroundRefresher", () => {
  test("uses lazygit's default intervals", () => {
    expect(DEFAULT_FETCH_INTERVAL_MS).toBe(60_000)
    expect(DEFAULT_REFRESH_INTERVAL_MS).toBe(10_000)
  })

  test("fetches on the fetch interval and refreshes on the refresh interval", async () => {
    const timers = fakeTimers()
    let fetches = 0
    let refreshes = 0
    const refresher = new BackgroundRefresher({
      fetch: async () => { fetches++ },
      refresh: async () => { refreshes++ },
      fetchIntervalMs: 60_000,
      refreshIntervalMs: 10_000,
      timers,
    })
    refresher.start()

    // The first tick waits out the interval, as lazygit's goEvery does.
    timers.advance(9_999)
    expect(refreshes).toBe(0)

    timers.advance(1)
    await Promise.resolve()
    expect(refreshes).toBe(1)
    expect(fetches).toBe(0)

    for (let step = 0; step < 5; step++) {
      timers.advance(10_000)
      await Promise.resolve()
    }
    expect(refreshes).toBe(6)
    expect(fetches).toBe(1)
    refresher.stop()
  })

  test("a tick while paused is skipped, and ticks resume afterwards", async () => {
    const timers = fakeTimers()
    let refreshes = 0
    const refresher = new BackgroundRefresher({
      fetch: async () => undefined,
      refresh: async () => { refreshes++ },
      refreshIntervalMs: 1_000,
      timers,
    })
    refresher.start()
    refresher.setPaused(true)
    timers.advance(3_000)
    await Promise.resolve()
    expect(refreshes).toBe(0)

    refresher.setPaused(false)
    timers.advance(1_000)
    await Promise.resolve()
    expect(refreshes).toBe(1)
    refresher.stop()
  })

  test("pausing is counted, so overlapping scopes cannot unpause each other early", () => {
    const refresher = new BackgroundRefresher({ fetch: async () => undefined, refresh: async () => undefined, timers: fakeTimers() })
    refresher.setPaused(true)
    refresher.setPaused(true)
    refresher.setPaused(false)
    expect(refresher.paused).toBe(true)
    refresher.setPaused(false)
    expect(refresher.paused).toBe(false)
    // Never negative: an unbalanced resume must not leave the count below zero.
    refresher.setPaused(false)
    refresher.setPaused(true)
    expect(refresher.paused).toBe(true)
  })

  test("whilePaused releases the pause even when the operation throws", async () => {
    const refresher = new BackgroundRefresher({ fetch: async () => undefined, refresh: async () => undefined, timers: fakeTimers() })
    await expect(refresher.whilePaused(async () => { throw new Error("boom") })).rejects.toThrow("boom")
    expect(refresher.paused).toBe(false)
  })

  test("a run slower than the interval does not queue more runs behind it", async () => {
    const timers = fakeTimers()
    let started = 0
    let release: (() => void) | undefined
    const refresher = new BackgroundRefresher({
      fetch: async () => undefined,
      refresh: async () => {
        started++
        await new Promise<void>((resolve) => { release = resolve })
      },
      refreshIntervalMs: 1_000,
      timers,
    })
    refresher.start()
    timers.advance(1_000)
    await Promise.resolve()
    expect(started).toBe(1)

    // No timer is pending while the run is in flight, so nothing can bunch up behind it.
    expect(timers.pending()).toBe(1)
    timers.advance(10_000)
    await Promise.resolve()
    expect(started).toBe(1)

    release?.()
    await Promise.resolve()
    await Promise.resolve()
    timers.advance(1_000)
    await Promise.resolve()
    expect(started).toBe(2)
    refresher.stop()
  })

  test("a failing routine is reported and keeps ticking", async () => {
    const timers = fakeTimers()
    const errors: Array<{ routine: string; message: string }> = []
    let attempts = 0
    const refresher = new BackgroundRefresher({
      fetch: async () => { attempts++; throw new Error(`no network ${attempts}`) },
      refresh: async () => undefined,
      fetchIntervalMs: 1_000,
      timers,
      onError: (error, routine) => errors.push({ routine, message: error instanceof Error ? error.message : String(error) }),
    })
    refresher.start()
    timers.advance(1_000)
    await Promise.resolve()
    await Promise.resolve()
    timers.advance(1_000)
    await Promise.resolve()
    await Promise.resolve()
    expect(attempts).toBe(2)
    expect(errors.map((entry) => entry.routine)).toEqual(["fetch", "fetch"])
    refresher.stop()
  })

  test("autoFetch off leaves only the working-tree refresh running", async () => {
    const timers = fakeTimers()
    let fetches = 0
    let refreshes = 0
    const refresher = new BackgroundRefresher({
      fetch: async () => { fetches++ },
      refresh: async () => { refreshes++ },
      autoFetch: false,
      fetchIntervalMs: 1_000,
      refreshIntervalMs: 1_000,
      timers,
    })
    refresher.start()
    timers.advance(5_000)
    await Promise.resolve()
    expect(fetches).toBe(0)
    expect(refreshes).toBeGreaterThan(0)
    refresher.stop()
  })

  test("stop cancels every pending timer, so nothing outlives the app", () => {
    const timers = fakeTimers()
    const refresher = new BackgroundRefresher({ fetch: async () => undefined, refresh: async () => undefined, timers })
    refresher.start()
    expect(timers.pending()).toBe(2)
    refresher.stop()
    expect(timers.pending()).toBe(0)
    // A stopped refresher stays stopped.
    refresher.start()
    expect(timers.pending()).toBe(0)
  })
})

describe("BackgroundRefresher isBusy", () => {
  test("a tick is skipped while the caller reports itself busy", async () => {
    const timers = fakeTimers()
    let refreshes = 0
    let busy = true
    const refresher = new BackgroundRefresher({
      fetch: async () => undefined,
      refresh: async () => { refreshes++ },
      refreshIntervalMs: 1_000,
      isBusy: () => busy,
      timers,
    })
    refresher.start()
    timers.advance(3_000)
    await Promise.resolve()
    expect(refreshes).toBe(0)
    busy = false
    timers.advance(1_000)
    await Promise.resolve()
    expect(refreshes).toBe(1)
    refresher.stop()
  })
})
