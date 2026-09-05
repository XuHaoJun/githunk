import { describe, expect, test } from "bun:test"
import { GitRunner } from "../../../src/git/runner"
import { createApp } from "../../../src/app/create-app"
import { createTestRenderer } from "@opentui/core/testing"
import { createReviewDocument } from "../../../src/review/core/document"
import { createReviewIdentity, createReviewGeneration } from "../../../src/review/core/identity"
import type { CliRenderer } from "@opentui/core"

describe("review workspace lifecycle integration", () => {
  test("b mounts workspace and Escape restores focus without leaks", async () => {
    const runner = new GitRunner("/tmp/does-not-exist")
    const setup = await createTestRenderer({ width: 80, height: 24 })
    const renderer = setup.renderer
    const app = createApp({
      repositoryRoot: "/tmp/does-not-exist",
      runner,
      renderer: renderer as unknown as CliRenderer,
      // injected seam: fake loader that succeeds
      reviewLoaders: {
        loadDocument: async () => {
          const identity = createReviewIdentity({ headRef: "refs/heads/feature", headOid: "a".repeat(40), baseRef: "refs/heads/main" })
          const generation = createReviewGeneration({ baseOid: "b".repeat(40), mergeBaseOid: "c".repeat(40), headOid: "a".repeat(40) })
          return createReviewDocument({ identity, generation, commits: [], files: [] })
        },
      },
    } as unknown as Parameters<typeof createApp>[0])

    const screen = (app as unknown as { screenController: { active: { kind: string } ; openBranchReview: () => Promise<void>; closeBranchReview: () => Promise<void> } }).screenController
    expect(screen).toBeDefined()
    // initial is repository
    expect(screen.active.kind).toBe("repository")
    await screen.openBranchReview()
    expect(screen.active.kind).toBe("branch-review")
    await screen.closeBranchReview()
    expect(screen.active.kind).toBe("repository")
    app.destroy()
    setup.renderer.destroy()
  })

  test("open failure keeps repository visible with error", async () => {
    const runner = new GitRunner("/tmp/does-not-exist")
    const app = createApp({
      repositoryRoot: "/tmp/does-not-exist",
      runner,
      reviewLoaders: {
        loadDocument: async () => { throw new Error("load failed") },
      },
    } as unknown as Parameters<typeof createApp>[0])
    const screen = (app as unknown as { screenController: { active: { kind: string; controller?: unknown }; openBranchReview: (baseRef?: string) => Promise<void> } }).screenController
    await expect(screen.openBranchReview("refs/heads/main")).rejects.toThrow("load failed")
    expect(screen.active.kind).toBe("repository")
    app.destroy()
  })
})
