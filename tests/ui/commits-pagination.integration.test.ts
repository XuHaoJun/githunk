import { afterEach, describe, expect, test } from "bun:test"
import { createShellHarness, type ShellHarness } from "../helpers/shell-harness"
import type { CommitSummary } from "../../src/domain/commit"

function syntheticCommits(total: number): readonly CommitSummary[] {
  return Array.from({ length: total }, (_, i) => ({
    oid: `oid-${String(i).padStart(5, "0")}`,
    shortOid: `s${i}`,
    parentOids: [],
    authorName: "Author",
    authoredAt: "2026-01-01T00:00:00Z",
    subject: `synthetic commit ${i}`,
    body: "",
  }))
}

async function waitFor(condition: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (condition()) return
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`timed out waiting for ${label}`)
}

describe("commits pagination", () => {
  let harness: ShellHarness | undefined
  afterEach(async () => {
    await harness?.cleanup()
    harness = undefined
  })

  test("moving past row 200 loads the full history and keeps the selection", async () => {
    const all = syntheticCommits(1000)
    harness = await createShellHarness({
      loadCommits: (async (_range: string, _filter?: string, options?: { readonly limit?: boolean }) =>
        (options?.limit ?? true ? all.slice(0, 300) : all)) as never,
    })
    const view = harness.app.view as unknown as { selectedListId(pane: string): string | undefined }
    await harness.pressKey("4")
    expect(harness.app.controller.state.commits?.length).toBe(300)
    for (let step = 0; step < 205; step += 1) await harness.pressKey("j")
    await waitFor(() => harness?.app.controller.state.commits?.length === 1000, "commit expansion")
    await harness.flush()
    // Selection survives the reload by stable id (oid-00205 is the 206th commit).
    expect(view.selectedListId("commits")).toBe("oid-00205")
  })

  test("End expands first, then lands on the oldest commit", async () => {
    const all = syntheticCommits(1000)
    harness = await createShellHarness({
      loadCommits: (async (_range: string, _filter?: string, options?: { readonly limit?: boolean }) =>
        (options?.limit ?? true ? all.slice(0, 300) : all)) as never,
    })
    const view = harness.app.view as unknown as {
      selectedListId(pane: string): string | undefined
      renderedListText(pane: string): string
    }
    await harness.pressKey("4")
    await harness.pressKey("END")
    await waitFor(() => view.selectedListId("commits") === "oid-00999", "End landing on oldest commit")
    expect(harness.app.controller.state.commits?.length).toBe(1000)
    expect(view.renderedListText("commits")).toContain("synthetic commit 999")
  })

  test("Home returns to the newest commit", async () => {
    const all = syntheticCommits(1000)
    harness = await createShellHarness({
      loadCommits: (async (_range: string, _filter?: string, options?: { readonly limit?: boolean }) =>
        (options?.limit ?? true ? all.slice(0, 300) : all)) as never,
    })
    const view = harness.app.view as unknown as { selectedListId(pane: string): string | undefined }
    await harness.pressKey("4")
    await harness.pressKey("END")
    await waitFor(() => view.selectedListId("commits") === "oid-00999", "End landing on oldest commit")
    await harness.pressKey("HOME")
    await harness.flush()
    expect(view.selectedListId("commits")).toBe("oid-00000")
  })
})
