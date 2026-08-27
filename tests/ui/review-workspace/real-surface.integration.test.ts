import { describe, expect, test } from "bun:test"
import { BoxRenderable, TextRenderable, type CliRenderer } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import { createApp } from "../../../src/app/create-app"
import { GitRunner } from "../../../src/git/runner"
import { createReviewDocument, createReviewHunk } from "../../../src/review/core/document"
import { createReviewGeneration, createReviewIdentity, sha256Tuple } from "../../../src/review/core/identity"
import type { ReviewDocument, ReviewFile } from "../../../src/review/core/types"
import type { ReviewWorkspace } from "../../../src/ui/review-workspace/review-workspace"

function reviewFile(path: string, lines: readonly string[]): ReviewFile {
  const hunk = createReviewHunk({
    index: 0,
    oldStart: 1,
    oldCount: 1,
    newStart: 1,
    newCount: lines.length,
    lines,
  })
  return {
    key: path,
    path,
    kind: "modified",
    oldBlobOid: "1".repeat(40),
    newBlobOid: sha256Tuple([path]),
    oldMode: "100644",
    newMode: "100644",
    contentId: sha256Tuple([path, ...lines]),
    patchDigest: sha256Tuple(lines),
    stats: { additions: lines.filter((line) => line.startsWith("+")).length, deletions: 0 },
    hunks: [hunk],
    source: "available",
  }
}

function documentForSurface(): ReviewDocument {
  const identity = createReviewIdentity({
    headRef: "refs/heads/feature",
    headOid: "a".repeat(40),
    baseRef: "refs/heads/main",
  })
  const generation = createReviewGeneration({
    baseOid: "b".repeat(40),
    mergeBaseOid: "c".repeat(40),
    headOid: "a".repeat(40),
  })
  const longFirstFile = Array.from({ length: 60 }, (_, index) => `+export const line${index + 1} = ${index + 1}`)
  return createReviewDocument({
    identity,
    generation,
    commits: [],
    files: [
      reviewFile("src/first.ts", longFirstFile),
      reviewFile("src/second.ts", ["+export const second = true"]),
      reviewFile("src/third.ts", ["+export const third = true"]),
    ],
  })
}

describe("review workspace real surface", () => {
  test("renders file rows and a full-height diff surface", async () => {
    const setup = await createTestRenderer({ width: 100, height: 30 })
    const app = createApp({
      repositoryRoot: "/tmp/does-not-exist",
      runner: new GitRunner("/tmp/does-not-exist"),
      renderer: setup.renderer as unknown as CliRenderer,
      reviewLoaders: { loadDocument: async () => documentForSurface() },
    } as unknown as Parameters<typeof createApp>[0])

    try {
      const screen = app.screenController!
      await screen.openBranchReview()
      await setup.flush()
      expect(screen.active.kind).toBe("branch-review")
      if (screen.active.kind !== "branch-review") throw new Error("expected Branch Review screen")
      const workspace = screen.active.view
      const sidebar = workspace.root.findDescendantById("review-sidebar-text") as TextRenderable | undefined
      const stream = workspace.root.findDescendantById("review-stream-text") as TextRenderable | undefined

      expect(sidebar, "the Files box must own actual file-row content").toBeDefined()
      expect(sidebar!.plainText).toContain("src/first.ts")
      expect(sidebar!.plainText).toContain("src/second.ts")
      expect(sidebar!.plainText).toContain("src/third.ts")
      expect(stream).toBeDefined()
      expect(stream!.plainText.split("\n").length).toBeGreaterThanOrEqual(20)
      expect(setup.captureCharFrame()).toContain("src/second.ts")
    } finally {
      app.destroy()
      setup.renderer.destroy()
    }
  })

  test("sidebar keyboard navigation selects and reveals the next file", async () => {
    const setup = await createTestRenderer({ width: 100, height: 30 })
    const app = createApp({
      repositoryRoot: "/tmp/does-not-exist",
      runner: new GitRunner("/tmp/does-not-exist"),
      renderer: setup.renderer as unknown as CliRenderer,
      reviewLoaders: { loadDocument: async () => documentForSurface() },
    } as unknown as Parameters<typeof createApp>[0])

    try {
      const screen = app.screenController!
      await screen.openBranchReview()
      await setup.flush()
      if (screen.active.kind !== "branch-review") throw new Error("expected Branch Review screen")
      const workspace = screen.active.view
      const sidebar = workspace.root.findDescendantById("review-sidebar-text") as TextRenderable
      const stream = workspace.root.findDescendantById("review-stream-text") as TextRenderable

      expect(workspace.handleKeyPress("tab")).toBe(true)
      expect(workspace.getFocus()).toBe("sidebar")
      expect(workspace.handleKeyPress("j")).toBe(true)
      await setup.flush()
      expect(screen.active.controller.state?.selection.fileKey).toBe("src/second.ts")
      expect(sidebar.plainText).toContain("> ◐ src/second.ts")
      expect(stream.plainText).toContain("src/second.ts")
    } finally {
      app.destroy()
      setup.renderer.destroy()
    }
  })

  test("mouse click on a visible sidebar row selects and reveals that file", async () => {
    const setup = await createTestRenderer({ width: 100, height: 30 })
    const app = createApp({
      repositoryRoot: "/tmp/does-not-exist",
      runner: new GitRunner("/tmp/does-not-exist"),
      renderer: setup.renderer as unknown as CliRenderer,
      reviewLoaders: { loadDocument: async () => documentForSurface() },
    } as unknown as Parameters<typeof createApp>[0])

    try {
      const screen = app.screenController!
      await screen.openBranchReview()
      await setup.flush()
      if (screen.active.kind !== "branch-review") throw new Error("expected Branch Review screen")
      const workspace = screen.active.view
      const sidebar = workspace.root.findDescendantById("review-sidebar-text") as TextRenderable
      const sidebarBox = workspace.root.findDescendantById("review-sidebar") as BoxRenderable
      const stream = workspace.root.findDescendantById("review-stream-text") as TextRenderable
      await setup.mockMouse.click(sidebarBox.x + 2, sidebarBox.y + 3)
      await setup.flush()
      expect(screen.active.controller.state?.selection.fileKey).toBe("src/third.ts")
      expect(sidebar.plainText).toContain("> ◐ src/third.ts")
      expect(stream.plainText).toContain("src/third.ts")
    } finally {
      app.destroy()
      setup.renderer.destroy()
    }
  })

  test("mouse wheel over the diff scrolls the windowed stream", async () => {
    const setup = await createTestRenderer({ width: 100, height: 30 })
    const app = createApp({
      repositoryRoot: "/tmp/does-not-exist",
      runner: new GitRunner("/tmp/does-not-exist"),
      renderer: setup.renderer as unknown as CliRenderer,
      reviewLoaders: { loadDocument: async () => documentForSurface() },
    } as unknown as Parameters<typeof createApp>[0])

    try {
      const screen = app.screenController!
      await screen.openBranchReview()
      await setup.flush()
      if (screen.active.kind !== "branch-review") throw new Error("expected Branch Review screen")
      const workspace = screen.active.view
      const streamBox = workspace.root.findDescendantById("review-stream") as BoxRenderable
      const streamText = workspace.root.findDescendantById("review-stream-text") as TextRenderable

      expect(streamBox.x, "review-stream box must be laid out").toBeGreaterThan(0)
      expect(streamText, "review-stream-text must exist under review-stream").toBeDefined()
      expect(streamText.width, "review-stream-text must occupy the box").toBeGreaterThanOrEqual(10)
      expect(workspace.getStreamPane().getViewportStart()).toBe(0)
      await setup.mockMouse.scroll(streamBox.x + 2, streamBox.y + 2, "down")
      await setup.flush()
      expect(workspace.getStreamPane().getViewportStart()).toBeGreaterThan(0)
    } finally {
      app.destroy()
      setup.renderer.destroy()
    }
  })
})
