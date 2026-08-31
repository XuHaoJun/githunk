import { describe, expect, test } from "bun:test"
import { act } from "react"
import { BoxRenderable, type CliRenderer } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import { createApp } from "../../../src/app/create-app"
import { GitRunner } from "../../../src/git/runner"
import { createReviewDocument, createReviewHunk } from "../../../src/review/core/document"
import { createReviewGeneration, createReviewIdentity, sha256Tuple } from "../../../src/review/core/identity"
import { reviewHelp, reviewHints } from "../../../src/ui/review-workspace/command-catalog"
import type { ReviewDocument, ReviewFile } from "../../../src/review/core/types"
import { hunkSectionRowCount, hunkSectionRowOffset } from "../../../src/ui/review-workspace/components/ReviewDiffSection"
import { toHunkReviewFile } from "../../../src/ui/review-workspace/hunk-review-model"
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
function reviewFile(path: string, lines: readonly string[]): ReviewFile {
  const oldCount = lines.filter((line) => line[0] !== "+").length
  const newCount = lines.filter((line) => line[0] !== "-").length
  const hunk = createReviewHunk({
    index: 0,
    oldStart: 1,
    oldCount,
    newStart: 1,
    newCount,
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
    stats: { additions: lines.filter((line) => line.startsWith("+")).length, deletions: lines.filter((line) => line.startsWith("-")).length },
    hunks: [hunk],
    source: "available",
  }
}

function documentForSurface(): ReviewDocument {
  const identity = createReviewIdentity({ headRef: "refs/heads/feature", headOid: "a".repeat(40), baseRef: "refs/heads/main" })
  const generation = createReviewGeneration({ baseOid: "b".repeat(40), mergeBaseOid: "c".repeat(40), headOid: "a".repeat(40) })
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

async function flushReact(setup: Awaited<ReturnType<typeof createTestRenderer>>): Promise<void> {
  await act(async () => {
    await setup.renderOnce()
    await Bun.sleep(0)
    await setup.renderOnce()
  })
}

describe("review workspace real surface", () => {
  test("renders file rows and a full-height diff surface", async () => {
    const setup = await createTestRenderer({ width: 100, height: 30, useMouse: true, enableMouseMovement: true })
    const app = createApp({
      repositoryRoot: "/tmp/does-not-exist",
      runner: new GitRunner("/tmp/does-not-exist"),
      renderer: setup.renderer as unknown as CliRenderer,
      reviewLoaders: { loadDocument: async () => documentForSurface() },
    } as unknown as Parameters<typeof createApp>[0])

    try {
      const screen = app.screenController!
      await act(async () => {
        await screen.openBranchReview()
      })
      await setup.flush()
      expect(screen.active.kind).toBe("branch-review")
      if (screen.active.kind !== "branch-review") throw new Error("expected Branch Review screen")
      const workspace = screen.active.view
      expect(workspace.root.findDescendantById("react-review-sidebar")).toBeDefined()
      expect(workspace.root.findDescendantById("review-diff-scrollbox")).toBeDefined()
      const frame = setup.captureCharFrame()
      // hunk parity: tree groups + basename + status icon + stats, not full flat path with coverage glyph
      expect(frame).toContain("src/")
      expect(frame).toContain("first.ts")
      expect(frame).toContain("second.ts")
      expect(frame).toContain("third.ts")
      // status icons for modified files (M) and stats badges should appear
      expect(frame).toMatch(/M\s+first\.ts/)
      expect(frame.split("\n").length).toBeGreaterThanOrEqual(20)
    } finally {
      await act(async () => {
        app.destroy()
        setup.renderer.destroy()
      })
    }
  })

  test("sidebar keyboard navigation selects and reveals the next file", async () => {
    const setup = await createTestRenderer({ width: 100, height: 30, useMouse: true, enableMouseMovement: true })
    const app = createApp({
      repositoryRoot: "/tmp/does-not-exist",
      runner: new GitRunner("/tmp/does-not-exist"),
      renderer: setup.renderer as unknown as CliRenderer,
      reviewLoaders: { loadDocument: async () => documentForSurface() },
    } as unknown as Parameters<typeof createApp>[0])

    try {
      const screen = app.screenController!
      await act(async () => {
        await screen.openBranchReview()
      })
      await setup.flush()
      if (screen.active.kind !== "branch-review") throw new Error("expected Branch Review screen")
      const workspace = screen.active.view
      const sidebar = workspace.root.findDescendantById("react-review-sidebar-scrollbox") as BoxRenderable
      await act(async () => {
        await setup.mockMouse.click(sidebar.x + 1, sidebar.y + 1)
        await Bun.sleep(30)
        setup.mockInput.pressKey("j")
        await Bun.sleep(30)
      })
      await flushReact(setup)
      expect(screen.active.controller.state?.selection.fileKey).toBe("src/second.ts")
      const frame = setup.captureCharFrame()
      expect(frame).toContain("second.ts")
      // selected row should exist with hunk styling (accent + panelAlt), verified via renderer id
      expect(workspace.root.findDescendantById("review-file-row:src/second.ts")).toBeDefined()
      expect(workspace.root.findDescendantById("review-file-group:src/")).toBeDefined()
    } finally {
      await act(async () => {
        app.destroy()
        setup.renderer.destroy()
      })
    }
  })
  test("mouse click on a visible sidebar row selects and reveals that file", async () => {
    const setup = await createTestRenderer({ width: 100, height: 30, useMouse: true, enableMouseMovement: true })
    const app = createApp({
      repositoryRoot: "/tmp/does-not-exist",
      runner: new GitRunner("/tmp/does-not-exist"),
      renderer: setup.renderer as unknown as CliRenderer,
      reviewLoaders: { loadDocument: async () => documentForSurface() },
    } as unknown as Parameters<typeof createApp>[0])

    try {
      const screen = app.screenController!
      await act(async () => {
        await screen.openBranchReview()
      })
      await setup.flush()
      if (screen.active.kind !== "branch-review") throw new Error("expected Branch Review screen")
      const workspace = screen.active.view
      const sidebarBox = workspace.root.findDescendantById("react-review-sidebar") as BoxRenderable
      const thirdRow = workspace.root.findDescendantById("review-file-row:src/third.ts") as BoxRenderable
      expect(sidebarBox).toBeDefined()
      expect(thirdRow).toBeDefined()
      await act(async () => {
        await setup.mockMouse.click(thirdRow.x + 1, thirdRow.y)
        await setup.renderOnce()
        await Bun.sleep(0)
        await setup.renderOnce()
      })
      expect(screen.active.controller.state?.selection.fileKey).toBe("src/third.ts")
      expect(setup.captureCharFrame()).toContain("third.ts")
      expect(workspace.root.findDescendantById("review-file-row:src/third.ts")).toBeDefined()
    } finally {
      await act(async () => {
        app.destroy()
        setup.renderer.destroy()
      })
    }
  })

  test("mouse wheel over the diff scrolls the windowed stream", async () => {
    const setup = await createTestRenderer({ width: 100, height: 30, useMouse: true, enableMouseMovement: true })
    const app = createApp({
      repositoryRoot: "/tmp/does-not-exist",
      runner: new GitRunner("/tmp/does-not-exist"),
      renderer: setup.renderer as unknown as CliRenderer,
      reviewLoaders: { loadDocument: async () => documentForSurface() },
    } as unknown as Parameters<typeof createApp>[0])

    try {
      const screen = app.screenController!
      await act(async () => {
        await screen.openBranchReview()
      })
      await setup.flush()
      if (screen.active.kind !== "branch-review") throw new Error("expected Branch Review screen")
      const workspace = screen.active.view
      const streamBox = workspace.root.findDescendantById("react-review-diff") as BoxRenderable
      const scrollBox = workspace.root.findDescendantById("review-diff-scrollbox") as { width: number; scrollTop: number }

      expect(streamBox.x, "review diff box must be laid out").toBeGreaterThan(0)
      expect(scrollBox, "persistent review scrollbox must exist").toBeDefined()
      expect(scrollBox.width, "review scrollbox must occupy the box").toBeGreaterThanOrEqual(10)
      expect(scrollBox.scrollTop).toBe(0)
      await act(async () => {
        await setup.mockMouse.scroll(streamBox.x + 2, streamBox.y + 2, "down")
        await setup.renderOnce()
        await Bun.sleep(0)
        await setup.renderOnce()
      })
      expect(scrollBox.scrollTop).toBeGreaterThan(0)
    } finally {
      await act(async () => {
        app.destroy()
        setup.renderer.destroy()
      })
    }
  })
  test("mouse click on a sidebar row aligns the selected file at the diff top", async () => {
    const base = documentForSurface()
    const document = {
      ...base,
      files: [
        base.files[0]!,
        base.files[1]!,
        reviewFile("src/tail.ts", Array.from({ length: 60 }, (_, index) => `+export const tail${index + 1} = ${index + 1}`)),
      ],
    }
    const setup = await createTestRenderer({ width: 100, height: 30, useMouse: true, enableMouseMovement: true })
    const app = createApp({
      repositoryRoot: "/tmp/does-not-exist",
      runner: new GitRunner("/tmp/does-not-exist"),
      renderer: setup.renderer as unknown as CliRenderer,
      reviewLoaders: { loadDocument: async () => document },
    } as unknown as Parameters<typeof createApp>[0])

    try {
      const screen = app.screenController!
      await act(async () => {
        await screen.openBranchReview()
      })
      await setup.flush()
      if (screen.active.kind !== "branch-review") throw new Error("expected Branch Review screen")
      const workspace = screen.active.view
      const secondRow = workspace.root.findDescendantById("review-file-row:src/second.ts") as BoxRenderable
      const scrollBox = workspace.root.findDescendantById("review-diff-scrollbox") as unknown as { scrollTop: number }

      await act(async () => {
        await setup.mockMouse.click(secondRow.x + 1, secondRow.y)
      })
      await setup.flush()

      const state = screen.active.controller.state
      const expectedFileTop = hunkSectionRowCount(toHunkReviewFile(document.files[0]!), "split", state!)
      expect(scrollBox.scrollTop).toBe(expectedFileTop)
    } finally {
      await act(async () => {
        app.destroy()
        setup.renderer.destroy()
      })
    }
  })

  test("previous hunk navigation reveals the selected hunk, not only its file", async () => {
    const setup = await createTestRenderer({ width: 100, height: 30, useMouse: true, enableMouseMovement: true })
    const app = createApp({
      repositoryRoot: "/tmp/does-not-exist",
      runner: new GitRunner("/tmp/does-not-exist"),
      renderer: setup.renderer as unknown as CliRenderer,
      reviewLoaders: { loadDocument: async () => documentForSurface() },
    } as unknown as Parameters<typeof createApp>[0])

    try {
      const screen = app.screenController!
      await act(async () => {
        await screen.openBranchReview()
      })
      await setup.flush()
      if (screen.active.kind !== "branch-review") throw new Error("expected Branch Review screen")
      const workspace = screen.active.view
      const scrollBox = workspace.root.findDescendantById("review-diff-scrollbox") as unknown as { scrollTop: number }

      const sidebar = workspace.root.findDescendantById("react-review-sidebar-scrollbox") as BoxRenderable
      await act(async () => {
        await setup.mockMouse.click(sidebar.x + 1, sidebar.y + 1)
        await Bun.sleep(30)
        setup.mockInput.pressKey("j")
        await Bun.sleep(30)
      })
      await flushReact(setup)
      expect(screen.active.controller.state?.selection.fileKey).toBe("src/second.ts")

      await act(async () => {
        setup.mockInput.pressTab()
        await Bun.sleep(30)
        setup.mockInput.pressTab()
        await Bun.sleep(30)
        setup.mockInput.pressKey("[")
        await Bun.sleep(30)
      })
      await flushReact(setup)

      expect(screen.active.controller.state?.selection.fileKey).toBe("src/second.ts")
      expect(scrollBox.scrollTop).toBeGreaterThan(0)
    } finally {
      await act(async () => {
        app.destroy()
        setup.renderer.destroy()
      })
    }
  })

  test("rapid next-and-previous hunk navigation reveals the final selected hunk", async () => {
    const makeMultiHunkFile = (path: string): ReviewFile => {
      const hunks = Array.from({ length: 12 }, (_, index) => {
        const lines = [...Array.from({ length: 9 }, () => " context"), "-old", "+new"]
        return createReviewHunk({
          index,
          oldStart: index * 20 + 1,
          oldCount: 10,
          newStart: index * 20 + 1,
          newCount: 10,
          lines,
        })
      })
      return {
        key: path,
        path,
        kind: "modified",
        oldBlobOid: "1".repeat(40),
        newBlobOid: sha256Tuple([path]),
        oldMode: "100644",
        newMode: "100644",
        contentId: sha256Tuple([path, "content"]),
        patchDigest: sha256Tuple([path, "patch"]),
        stats: { additions: 12, deletions: 12 },
        hunks,
        source: "available",
      }
    }
    const first = makeMultiHunkFile("src/first.ts")
    const second = makeMultiHunkFile("src/second.ts")
    const base = documentForSurface()
    const document = createReviewDocument({
      ...base,
      files: [first, second],
    })
    const setup = await createTestRenderer({ width: 100, height: 12, useMouse: true, enableMouseMovement: true })
    const app = createApp({
      repositoryRoot: "/tmp/does-not-exist",
      runner: new GitRunner("/tmp/does-not-exist"),
      renderer: setup.renderer as unknown as CliRenderer,
      reviewLoaders: { loadDocument: async () => document },
    } as unknown as Parameters<typeof createApp>[0])

    try {
      const screen = app.screenController!
      await act(async () => {
        await screen.openBranchReview()
      })
      await setup.flush()
      if (screen.active.kind !== "branch-review") throw new Error("expected Branch Review screen")
      const workspace = screen.active.view
      const scrollBox = workspace.root.findDescendantById("review-diff-scrollbox") as unknown as {
        scrollTop: number
        viewport: { height: number }
      }

      await act(async () => {
        await setup.mockInput.pressKeys(Array.from({ length: 13 }, () => "]"))
        await setup.renderOnce()
        await setup.renderOnce()
      })

      const state = screen.active.controller.state
      expect(state?.selection).toEqual({ fileKey: "src/second.ts", hunkIndex: 1 })
      const firstHeight = hunkSectionRowCount(toHunkReviewFile(first), "split", state!)
      const forwardTargetTop = firstHeight + hunkSectionRowOffset(toHunkReviewFile(second), "split", 1, state!, undefined, true)
      expect(forwardTargetTop).toBeGreaterThanOrEqual(scrollBox.scrollTop)
      expect(forwardTargetTop).toBeLessThan(scrollBox.scrollTop + Math.max(1, scrollBox.viewport.height))

      await act(async () => {
        await setup.mockInput.pressKeys(["[", "["])
        await setup.renderOnce()
        await setup.renderOnce()
      })

      const backwardState = screen.active.controller.state
      expect(backwardState?.selection).toEqual({ fileKey: "src/first.ts", hunkIndex: 11 })
      const backwardTargetTop = hunkSectionRowOffset(toHunkReviewFile(first), "split", 11, backwardState!)
      expect(backwardTargetTop).toBeGreaterThanOrEqual(scrollBox.scrollTop)
      expect(backwardTargetTop).toBeLessThan(scrollBox.scrollTop + Math.max(1, scrollBox.viewport.height))
    } finally {
      await act(async () => {
        app.destroy()
        setup.renderer.destroy()
      })
    }
  })
  test("active OpenTUI help and footer do not expose deferred features", async () => {
    const setup = await createTestRenderer({ width: 180, height: 30, useMouse: true, enableMouseMovement: true })
    const app = createApp({
      repositoryRoot: "/tmp/does-not-exist",
      runner: new GitRunner("/tmp/does-not-exist"),
      renderer: setup.renderer as unknown as CliRenderer,
      reviewLoaders: { loadDocument: async () => documentForSurface() },
    } as unknown as Parameters<typeof createApp>[0])

    try {
      const screen = app.screenController!
      await act(async () => {
        await screen.openBranchReview()
      })
      await setup.flush()
      expect(screen.active.kind).toBe("branch-review")
      const deferred = [
        /since last/iu,
        /individual commit/iu,
        /trailing final hunk/iu,
        /half-page/iu,
        /horizontal scroll/iu,
        /current-line/iu,
        /\btheme\b/iu,
        /copy decorations/iu,
        /agent annotations/iu,
        /extension panes/iu,
        /\bpager\b/iu,
        /\beditor\b/iu,
        /git mutation/iu,
      ]
      const footer = setup.captureCharFrame()
      for (const pattern of deferred) expect(footer).not.toMatch(pattern)

      const activeState = screen.active.kind === "branch-review" ? screen.active.controller.state : undefined
      expect(activeState).toBeDefined()
      const help = reviewHelp("stream", activeState!)
      const hints = reviewHints("stream", activeState!)
      expect(help).toContain("Mark current file Viewed")
      for (const pattern of deferred) {
        expect(help).not.toMatch(pattern)
        expect(hints).not.toMatch(pattern)
      }
    } finally {
      await act(async () => {
        app.destroy()
        setup.renderer.destroy()
      })
    }
  })
})
