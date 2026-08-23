import { describe, expect, test } from "bun:test"
import { MutationQueue } from "../../src/app/mutation-queue"

describe("MutationQueue", () => {
  test("serializes operations in submission order", async () => {
    const queue = new MutationQueue()
    const events: string[] = []
    let release!: () => void
    const first = queue.run(async () => {
      events.push("first:start")
      await new Promise<void>((resolve) => { release = resolve })
      events.push("first:end")
      return 1
    })
    const second = queue.run(async () => {
      events.push("second")
      return 2
    })
    await Promise.resolve()
    expect(events).toEqual(["first:start"])
    release()
    await expect(first).resolves.toBe(1)
    await expect(second).resolves.toBe(2)
    expect(events).toEqual(["first:start", "first:end", "second"])
  })

  test("continues after a rejected operation", async () => {
    const queue = new MutationQueue()
    await expect(queue.run(async () => { throw new Error("failed") })).rejects.toThrow("failed")
    await expect(queue.run(async () => "next")).resolves.toBe("next")
  })
})
