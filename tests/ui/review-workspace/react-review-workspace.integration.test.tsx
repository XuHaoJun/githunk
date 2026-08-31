import { describe, expect, test } from "bun:test"
import { testRender } from "@opentui/react/test-utils"
import { act } from "react"
import { createReviewDocument, createReviewHunk } from "../../../src/review/core/document"
import type { ReviewFile } from "../../../src/review/core/types"
import { createReviewGeneration, createReviewIdentity } from "../../../src/review/core/identity"
import { reduceReviewState } from "../../../src/review/core/reducer"
import { createFileAnchor, createRangeAnchor } from "../../../src/review/core/anchors"
import { createInitialReviewState } from "../../../src/review/core/state"
import { ReviewWorkspaceApp } from "../../../src/ui/review-workspace/ReviewWorkspaceApp"
import { ReactReviewSession } from "../../../src/ui/review-workspace/react-review-session"
import type { ReviewWorkspaceController } from "../../../src/ui/review-workspace/controller"
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
function makeFile(key: string, lines: readonly string[]): ReviewFile {
  const oldCount = lines.filter((line) => line[0] !== "+").length
  const newCount = lines.filter((line) => line[0] !== "-").length
  return {
    key,
    path: key,
    kind: "modified",
    oldBlobOid: "1".repeat(40),
    newBlobOid: "2".repeat(40),
    oldMode: "100644",
    newMode: "100644",
    contentId: `content-${key}`,
    patchDigest: `patch-${key}`,
    stats: { additions: 1, deletions: 1 },
    hunks: [createReviewHunk({ index: 0, oldStart: 1, oldCount, newStart: 1, newCount, lines })],
    source: "available",
  }
}

function makeController(files: readonly ReviewFile[]): ReviewWorkspaceController {
  const identity = createReviewIdentity({ headRef: "refs/heads/feature", headOid: "a".repeat(40), baseRef: "refs/heads/main" })
  const generation = createReviewGeneration({ baseOid: "b".repeat(40), mergeBaseOid: "c".repeat(40), headOid: "a".repeat(40) })
  const state = createInitialReviewState(createReviewDocument({ identity, generation, commits: [], files }))
  return {
    state,
    error: undefined,
    subscribe: () => () => undefined,
  } as unknown as ReviewWorkspaceController
}
function makeSession(files: readonly ReviewFile[], onClose: () => void = () => undefined): ReactReviewSession {
  return new ReactReviewSession(makeController(files), onClose)
}

async function flush(setup: Awaited<ReturnType<typeof testRender>>) {
  await act(async () => {
    await setup.renderOnce()
    await Bun.sleep(0)
    await setup.renderOnce()
  })
}
function makeInteractiveSession(
  files: readonly ReviewFile[],
  feedback: NonNullable<ReviewWorkspaceController["state"]>["feedback"],
): { session: ReactReviewSession; getState: () => NonNullable<ReviewWorkspaceController["state"]> } {
  let state = { ...makeController(files).state!, feedback }
  const listeners = new Set<(next: typeof state) => void>()
  const controller = {
    get state() { return state },
    error: undefined,
    subscribe(listener: (next: typeof state) => void) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    dispatch(action: Parameters<typeof reduceReviewState>[1]) {
      state = reduceReviewState(state, action)
      for (const listener of listeners) listener(state)
    },
    getExpandedSourceByGap: () => new Map(),
    expandGap: async () => undefined,
  } as unknown as ReviewWorkspaceController
  return { session: new ReactReviewSession(controller, () => undefined), getState: () => state }
}

describe("React review workspace", () => {
  test("renders the Hunk-style header, sidebar, and continuous diff pane", async () => {
    const files = [
      makeFile("src/first.ts", ["-const old = 1", "+const next = 2"]),
      makeFile("src/second.ts", ["-const before = true", "+const after = false"]),
    ]
    const setup = await testRender(
      <ReviewWorkspaceApp session={makeSession(files)} />,
      { width: 120, height: 30 },
    )

    try {
      await flush(setup)
      expect(setup.renderer.root.findDescendantById("react-review-header")).toBeDefined()
      expect(setup.renderer.root.findDescendantById("react-review-sidebar")).toBeDefined()
      expect(setup.renderer.root.findDescendantById("review-diff-scrollbox")).toBeDefined()
      const frame = setup.captureCharFrame()
      expect(frame).toContain("src/first.ts")
      expect(frame).toContain("src/second.ts")
      expect(frame).toContain("const old = 1")
      expect(frame).toContain("const next = 2")
    } finally {
      await act(async () => setup.renderer.destroy())
    }
  })
  test("scrolls diff with j/k while stream focus starts active", async () => {
    const file = makeFile(
      "src/scroll.ts",
      Array.from({ length: 40 }, (_, index) => `+const line${index} = ${index}`),
    )
    const setup = await testRender(<ReviewWorkspaceApp session={makeSession([file])} />, { width: 120, height: 10 })

    try {
      await flush(setup)
      const scrollBox = setup.renderer.root.findDescendantById("review-diff-scrollbox") as unknown as {
        focused: boolean
        scrollTop: number
      }
      expect(scrollBox.focused).toBe(true)
      expect(scrollBox.scrollTop).toBe(0)
      await act(async () => {
        setup.mockInput.pressKey("j")
        await Bun.sleep(30)
      })
      await flush(setup)
      expect(scrollBox.scrollTop).toBe(1)
      await act(async () => {
        setup.mockInput.pressKey("k")
        await Bun.sleep(30)
      })
      await flush(setup)
      expect(scrollBox.scrollTop).toBe(0)
    } finally {
      await act(async () => setup.renderer.destroy())
    }
  })
  test("routes Escape through the React host close boundary", async () => {
    const file = makeFile("src/only.ts", ["-const old = 1", "+const next = 2"])
    let closeCalls = 0
    const session = makeSession([file], () => { closeCalls += 1 })
    const setup = await testRender(
      <ReviewWorkspaceApp session={session} />,
      { width: 120, height: 30 },
    )

    try {
      await flush(setup)
      await act(async () => {
        setup.mockInput.pressEscape()
        await Bun.sleep(30)
      })
      await flush(setup)
      expect(closeCalls).toBe(1)
    } finally {
      await act(async () => setup.renderer.destroy())
    }
  })
  test("cycles layout through the L key without consuming panel numbers", async () => {
    const file = makeFile("src/layout.ts", ["-const old = 1", "+const next = 2"])
    const setup = await testRender(
      <ReviewWorkspaceApp session={makeSession([file])} />,
      { width: 120, height: 30 },
    )

    try {
      await flush(setup)
      expect(setup.renderer.root.findDescendantById("react-review-diff")).toBeDefined()
      expect(setup.captureCharFrame()).toContain("layout(split)")
      await act(async () => {
        await setup.mockInput.typeText("l")
        await Bun.sleep(30)
      })
      await flush(setup)
      expect(setup.captureCharFrame()).toContain("layout(stack)")
      await act(async () => {
        await setup.mockInput.typeText("l")
        await Bun.sleep(30)
      })
      await flush(setup)
      expect(setup.captureCharFrame()).toContain("layout(split)")
      await act(async () => {
        await setup.mockInput.typeText("l")
        await Bun.sleep(30)
      })
      await flush(setup)
      expect(setup.captureCharFrame()).toContain("layout(stack)")
    } finally {
      await act(async () => setup.renderer.destroy())
    }
  })
  test("focuses lazygit panels with 0 and 1 and highlights active chrome", async () => {
    const files = [
      makeFile("src/first.ts", ["-old", "+new"]),
      makeFile("src/second.ts", ["-before", "+after"]),
    ]
    const setup = await testRender(
      <ReviewWorkspaceApp session={makeSession(files)} />,
      { width: 120, height: 30 },
    )

    try {
      await flush(setup)
      const sidebar = setup.renderer.root.findDescendantById("react-review-sidebar") as unknown as {
        borderColor: { intent: string; slot?: number }
        titleColor?: { intent: string; slot?: number }
        title?: string
      }
      const sidebarScroll = setup.renderer.root.findDescendantById("react-review-sidebar-scrollbox") as unknown as {
        focused: boolean
      }
      const diff = setup.renderer.root.findDescendantById("react-review-diff") as unknown as {
        borderColor: { intent: string; slot?: number }
        titleColor?: { intent: string; slot?: number }
        title?: string
      }
      const diffScroll = setup.renderer.root.findDescendantById("review-diff-scrollbox") as unknown as {
        focused: boolean
      }
      const filter = setup.renderer.root.findDescendantById("review-file-filter-input") as unknown as {
        focused: boolean
      }
      expect(diffScroll.focused).toBe(true)
      expect(sidebarScroll.focused).toBe(false)
      expect(diff.title).toContain("[0]")
      expect(sidebar.title).toContain("[1]")
      expect(diff.borderColor.intent).toBe("indexed")
      expect(diff.borderColor.slot).toBe(2)
      expect(diff.titleColor?.intent).toBe("indexed")
      expect(sidebar.borderColor.intent).toBe("default")

      await act(async () => await setup.mockInput.typeText("1"))
      await flush(setup)
      expect(sidebarScroll.focused).toBe(true)
      expect(diffScroll.focused).toBe(false)
      expect(sidebar.borderColor.intent).toBe("indexed")
      expect(sidebar.borderColor.slot).toBe(2)
      expect(sidebar.titleColor?.intent).toBe("indexed")
      expect(diff.borderColor.intent).toBe("default")

      await act(async () => await setup.mockInput.typeText("0"))
      await flush(setup)
      expect(diffScroll.focused).toBe(true)
      expect(sidebarScroll.focused).toBe(false)
      expect(diff.borderColor.intent).toBe("indexed")
      expect(diff.borderColor.slot).toBe(2)
      expect(sidebar.borderColor.intent).toBe("default")
      await act(async () => {
        setup.mockInput.pressTab()
        await Bun.sleep(30)
      })
      await flush(setup)
      expect(sidebarScroll.focused).toBe(true)
      expect(filter.focused).toBe(false)
      expect(diffScroll.focused).toBe(false)

      await act(async () => {
        setup.mockInput.pressTab()
        await Bun.sleep(30)
      })
      await flush(setup)
      expect(sidebarScroll.focused).toBe(false)
      expect(filter.focused).toBe(true)
      expect(diffScroll.focused).toBe(false)

      await act(async () => {
        setup.mockInput.pressTab()
        await Bun.sleep(30)
      })
      await flush(setup)
      expect(sidebarScroll.focused).toBe(false)
      expect(filter.focused).toBe(false)
      expect(diffScroll.focused).toBe(true)
    } finally {
      await act(async () => setup.renderer.destroy())
    }
  })
  test("focuses the clicked panel and keeps its chrome highlighted", async () => {
    const files = [
      makeFile("src/first.ts", ["-old", "+new"]),
      makeFile("src/second.ts", ["-before", "+after"]),
    ]
    const setup = await testRender(
      <ReviewWorkspaceApp session={makeSession(files)} />,
      { width: 120, height: 30, useMouse: true, enableMouseMovement: true },
    )

    try {
      await flush(setup)
      const sidebar = setup.renderer.root.findDescendantById("react-review-sidebar") as unknown as {
        x: number
        y: number
        borderColor: { intent: string; slot?: number }
      }
      const diff = setup.renderer.root.findDescendantById("react-review-diff") as unknown as {
        x: number
        y: number
        borderColor: { intent: string; slot?: number }
      }

      await act(async () => {
        await setup.mockMouse.click(sidebar.x + 2, sidebar.y + 2)
      })
      await flush(setup)
      expect(sidebar.borderColor.intent).toBe("indexed")
      expect(sidebar.borderColor.slot).toBe(2)
      expect(diff.borderColor.intent).toBe("default")

      await act(async () => {
        await setup.mockMouse.click(diff.x + 2, diff.y + 2)
      })
      await flush(setup)
      expect(diff.borderColor.intent).toBe("indexed")
      expect(diff.borderColor.slot).toBe(2)
      expect(sidebar.borderColor.intent).toBe("default")
    } finally {
      await act(async () => setup.renderer.destroy())
    }
  })
  test("resizes the sidebar by dragging the center bar", async () => {
    const files = [
      makeFile("src/first.ts", ["-old", "+new"]),
      makeFile("src/second.ts", ["-before", "+after"]),
    ]
    const setup = await testRender(
      <ReviewWorkspaceApp session={makeSession(files)} />,
      { width: 120, height: 30, useMouse: true, enableMouseMovement: true },
    )

    try {
      await flush(setup)
      const sidebar = setup.renderer.root.findDescendantById("react-review-sidebar") as unknown as {
        x: number
        width: number
      }
      const resizeBar = setup.renderer.root.findDescendantById("review-pane-resize-bar") as unknown as {
        x: number
        y: number
        width: number
        height: number
      } | undefined
      const resizeGlyphs = setup.renderer.root.findDescendantById("review-pane-resize-bar-glyphs") as unknown as {
        content: { chunks: readonly { text: string }[] }
        fg: { intent: string; slot?: number }
        selectable: boolean
      }
      const diff = setup.renderer.root.findDescendantById("react-review-diff") as unknown as {
        x: number
        width: number
      }

      expect(resizeBar).toBeDefined()
      if (!resizeBar) return
      expect(resizeBar.width).toBe(1)
      expect(resizeBar.height).toBeGreaterThan(1)
      expect(sidebar.width).toBe(30)
      const initialDiffWidth = diff.width
      expect(resizeGlyphs.selectable).toBe(false)
      expect(resizeGlyphs.content.chunks.map((chunk) => chunk.text).join("")).toContain("│")
      await act(async () => {
        await setup.mockMouse.moveTo(resizeBar.x, resizeBar.y + 2)
      })
      await flush(setup)
      expect(resizeGlyphs.content.chunks.map((chunk) => chunk.text).join("")).toContain("⇔")
      expect(resizeGlyphs.fg.intent).toBe("indexed")
      expect(resizeGlyphs.fg.slot).toBe(2)

      await act(async () => {
        await setup.mockMouse.drag(resizeBar.x, resizeBar.y + 2, resizeBar.x + 12, resizeBar.y + 2)
      })
      await flush(setup)
      expect(sidebar.width).toBe(42)
      expect(resizeBar.x).toBe(42)
      expect(diff.width).toBeLessThan(initialDiffWidth)

      await act(async () => {
        await setup.mockMouse.drag(resizeBar.x, resizeBar.y + 2, 22, resizeBar.y + 2)
      })
      await flush(setup)
      expect(sidebar.width).toBe(22)
      expect(resizeBar.x).toBe(22)
      expect(diff.width).toBeGreaterThan(initialDiffWidth)
    } finally {
      await act(async () => setup.renderer.destroy())
    }
  })
  test("uses the final release coordinate when resizing", async () => {
    const setup = await testRender(
      <ReviewWorkspaceApp session={makeSession([makeFile("src/release.ts", ["-old", "+new"])])} />,
      { width: 120, height: 30, useMouse: true, enableMouseMovement: true },
    )

    try {
      await flush(setup)
      const sidebar = setup.renderer.root.findDescendantById("react-review-sidebar") as unknown as {
        width: number
      }
      const resizeBar = setup.renderer.root.findDescendantById("review-pane-resize-bar") as unknown as {
        x: number
        y: number
      }

      await act(async () => {
        await setup.mockMouse.pressDown(resizeBar.x, resizeBar.y + 2)
        await setup.mockMouse.emitMouseEvent("drag", resizeBar.x + 8, resizeBar.y + 2)
        await setup.mockMouse.release(resizeBar.x + 18, resizeBar.y + 2)
      })
      await flush(setup)
      expect(sidebar.width).toBe(48)
    } finally {
      await act(async () => setup.renderer.destroy())
    }
  })
  test("does not select diff content when a resize ends over it", async () => {
    const files = [
      makeFile("src/first.ts", ["-old", "+new"]),
      makeFile("src/second.ts", ["-before", "+after"]),
    ]
    const { session, getState } = makeInteractiveSession(files, [])
    const setup = await testRender(
      <ReviewWorkspaceApp session={session} />,
      { width: 120, height: 30, useMouse: true, enableMouseMovement: true },
    )

    try {
      await flush(setup)
      const resizeBar = setup.renderer.root.findDescendantById("review-pane-resize-bar") as unknown as {
        x: number
        y: number
      }
      const secondSection = setup.renderer.root.findDescendantById("review-section:src/second.ts") as unknown as {
        y: number
      }
      const initialFileKey = getState().selection.fileKey
      const releaseY = secondSection.y + 1

      await act(async () => {
        await setup.mockMouse.pressDown(resizeBar.x, releaseY)
        await setup.mockMouse.emitMouseEvent("drag", resizeBar.x + 8, releaseY)
        await setup.mockMouse.release(resizeBar.x + 18, releaseY)
      })
      await flush(setup)
      expect(getState().selection.fileKey).toBe(initialFileKey)
    } finally {
      await act(async () => setup.renderer.destroy())
    }
  })
  test("clamps the center bar to usable pane widths", async () => {
    const setup = await testRender(
      <ReviewWorkspaceApp session={makeSession([makeFile("src/bounds.ts", ["-old", "+new"])])} />,
      { width: 120, height: 30, useMouse: true, enableMouseMovement: true },
    )

    try {
      await flush(setup)
      const sidebar = setup.renderer.root.findDescendantById("react-review-sidebar") as unknown as {
        x: number
        width: number
      }
      const resizeBar = setup.renderer.root.findDescendantById("review-pane-resize-bar") as unknown as {
        x: number
        y: number
      }
      const diff = setup.renderer.root.findDescendantById("react-review-diff") as unknown as {
        width: number
      }

      await act(async () => {
        await setup.mockMouse.drag(resizeBar.x, resizeBar.y + 2, 0, resizeBar.y + 2)
      })
      await flush(setup)
      expect(sidebar.width).toBe(20)
      expect(resizeBar.x).toBe(20)
      expect(diff.width).toBeGreaterThanOrEqual(42)
      expect(setup.captureCharFrame()).toContain("layout(split)")

      await act(async () => {
        await setup.mockMouse.drag(resizeBar.x, resizeBar.y + 2, 119, resizeBar.y + 2)
      })
      await flush(setup)
      expect(sidebar.width).toBe(77)
      expect(resizeBar.x).toBe(77)
      expect(diff.width).toBeGreaterThanOrEqual(42)
      expect(setup.captureCharFrame()).toContain("layout(stack)")
    } finally {
      await act(async () => setup.renderer.destroy())
    }
  })
  test("retains the dragged width across terminal resizing", async () => {
    const setup = await testRender(
      <ReviewWorkspaceApp session={makeSession([makeFile("src/resize.ts", ["-old", "+new"])])} />,
      { width: 120, height: 30, useMouse: true, enableMouseMovement: true },
    )

    try {
      await flush(setup)
      const sidebar = setup.renderer.root.findDescendantById("react-review-sidebar") as unknown as {
        x: number
        width: number
      }
      const resizeBar = setup.renderer.root.findDescendantById("review-pane-resize-bar") as unknown as {
        x: number
        y: number
      }

      await act(async () => {
        await setup.mockMouse.drag(resizeBar.x, resizeBar.y + 2, 50, resizeBar.y + 2)
      })
      await flush(setup)
      expect(sidebar.width).toBe(50)

      await act(async () => {
        setup.resize(80, 30)
        await Bun.sleep(0)
      })
      await flush(setup)
      expect(sidebar.width).toBe(37)
      expect(resizeBar.x).toBe(37)

      await act(async () => {
        setup.resize(120, 30)
        await Bun.sleep(0)
      })
      await flush(setup)
      expect(sidebar.width).toBe(50)
      expect(resizeBar.x).toBe(50)
    } finally {
      await act(async () => setup.renderer.destroy())
    }
  })
  test("clears the resize gesture when the sidebar becomes hidden", async () => {
    const setup = await testRender(
      <ReviewWorkspaceApp session={makeSession([makeFile("src/hide-resize.ts", ["-old", "+new"])])} />,
      { width: 120, height: 30, useMouse: true, enableMouseMovement: true },
    )

    try {
      await flush(setup)
      const resizeBar = setup.renderer.root.findDescendantById("review-pane-resize-bar") as unknown as {
        x: number
        y: number
      }

      await act(async () => {
        await setup.mockMouse.pressDown(resizeBar.x, resizeBar.y + 2)
        await setup.mockMouse.emitMouseEvent("drag", resizeBar.x + 10, resizeBar.y + 2)
        setup.resize(70, 30)
        await Bun.sleep(0)
      })
      await flush(setup)
      expect(setup.renderer.root.findDescendantById("review-pane-resize-bar")).toBeUndefined()

      await act(async () => {
        setup.resize(120, 30)
        await Bun.sleep(0)
      })
      await flush(setup)
      await act(async () => {
        await setup.mockMouse.moveTo(119, resizeBar.y + 2)
      })
      await flush(setup)
      const resizeGlyphs = setup.renderer.root.findDescendantById("review-pane-resize-bar-glyphs") as unknown as {
        content: { chunks: readonly { text: string }[] }
      }
      expect(resizeGlyphs.content.chunks.map((chunk) => chunk.text).join("")).not.toContain("⇔")

      await act(async () => {
        await setup.mockMouse.release(30, resizeBar.y + 2)
      })
    } finally {
      await act(async () => setup.renderer.destroy())
    }
  })
  test("documents numeric panel focus in the help dialog", async () => {
    const setup = await testRender(
      <ReviewWorkspaceApp session={makeSession([makeFile("src/help.ts", ["-old", "+new"])])} />,
      { width: 120, height: 30 },
    )

    try {
      await flush(setup)
      await act(async () => {
        await setup.mockInput.typeText("?")
        await Bun.sleep(30)
      })
      await flush(setup)
      const frame = setup.captureCharFrame()
      expect(frame).toContain("0  focus diff")
      expect(frame).toContain("1  focus files")
      expect(frame).toContain("l  cycle layout")
      expect(frame).not.toContain("0/1/2  auto / split / stack")
    } finally {
      await act(async () => setup.renderer.destroy())
    }
  })
  test("keeps the visible diff focused when the sidebar is hidden", async () => {
    const setup = await testRender(
      <ReviewWorkspaceApp session={makeSession([makeFile("src/narrow.ts", ["-old", "+new"])])} />,
      { width: 70, height: 30 },
    )

    try {
      await flush(setup)
      expect(setup.renderer.root.findDescendantById("react-review-sidebar")).toBeUndefined()
      expect(setup.renderer.root.findDescendantById("review-pane-resize-bar")).toBeUndefined()
      const diffScroll = setup.renderer.root.findDescendantById("review-diff-scrollbox") as unknown as {
        focused: boolean
      }
      expect(diffScroll.focused).toBe(true)

      await act(async () => {
        setup.mockInput.pressTab()
        await Bun.sleep(30)
      })
      await flush(setup)
      expect(diffScroll.focused).toBe(true)

      await act(async () => {
        await setup.mockInput.typeText("/")
        await Bun.sleep(30)
      })
      await flush(setup)
      expect(diffScroll.focused).toBe(true)
    } finally {
      await act(async () => setup.renderer.destroy())
    }
  })
  test("preserves shifted review commands", async () => {
    const session = makeSession([makeFile("src/shift.ts", ["-old", "+new"])])
    const setup = await testRender(<ReviewWorkspaceApp session={session} />, { width: 120, height: 30 })

    try {
      await flush(setup)
      await act(async () => {
        setup.mockInput.pressKey("r", { shift: true })
        await Bun.sleep(30)
      })
      await flush(setup)
      expect(session.finishDialog.isOpen()).toBe(true)
    } finally {
      await act(async () => setup.renderer.destroy())
    }
  })
  test("renders and dismisses the finish dialog through the React session", async () => {
    const file = makeFile("src/finish.ts", ["-const old = 1", "+const next = 2"])
    const session = makeSession([file])
    session.finishDialog.setSummary("ship it")
    session.finishDialog.open()
    session.invalidate()
    const setup = await testRender(<ReviewWorkspaceApp session={session} />, { width: 120, height: 30 })

    try {
      await flush(setup)
      expect(setup.renderer.root.findDescendantById("review-finish-dialog")).toBeDefined()
      expect(setup.captureCharFrame()).toContain("ship it")
      await act(async () => {
        await setup.mockInput.typeText("x")
        await Bun.sleep(30)
      })
      expect(session.finishDialog.getSummary()).toContain("x")
      await act(async () => {
        setup.mockInput.pressEscape()
        await Bun.sleep(30)
      })
      await flush(setup)
      expect(session.finishDialog.isOpen()).toBe(false)
      expect(setup.renderer.root.findDescendantById("review-finish-dialog")).toBeUndefined()
    } finally {
      await act(async () => setup.renderer.destroy())
    }
  })
  test("renders the pending feedback composer in the workspace", async () => {
    const file = makeFile("src/comment.ts", ["-const old = 1", "+const next = 2"])
    const session = makeSession([file])
    const controller = session.controller as unknown as { state: NonNullable<ReviewWorkspaceController["state"]> }
    controller.state = {
      ...controller.state,
      draft: {
        anchor: createFileAnchor(file),
        kind: "note",
        severity: "comment",
        body: "please rename this",
      },
    }
    const setup = await testRender(<ReviewWorkspaceApp session={session} />, { width: 120, height: 30 })

    try {
      await flush(setup)
      expect(setup.captureCharFrame()).toContain("please rename this")
      const body = setup.renderer.root.findDescendantById("review-feedback-body") as unknown as { plainText: string }
      await act(async () => {
        await setup.mockInput.typeText("rjz")
        await Bun.sleep(30)
      })
      expect(body.plainText).toContain("rjz")
    } finally {
      await act(async () => setup.renderer.destroy())
    }
  })

  test("keeps the diff stream aligned with unreviewed filtering after viewed changes", async () => {
    const files = [makeFile("src/unreviewed-a.ts", ["-old", "+new"]), makeFile("src/unreviewed-b.ts", ["-old", "+new"])]
    const session = makeSession(files)
    const controller = session.controller as unknown as { state: NonNullable<ReviewWorkspaceController["state"]> }
    controller.state = { ...controller.state, filter: { query: "", scope: "unreviewed" } }
    const setup = await testRender(<ReviewWorkspaceApp session={session} />, { width: 120, height: 30 })

    try {
      await flush(setup)
      expect(setup.renderer.root.findDescendantById("review-file-row:src/unreviewed-a.ts")).toBeDefined()
      const filter = setup.renderer.root.findDescendantById("review-file-filter-input") as unknown as { value: string }
      await act(async () => {
        setup.mockInput.pressKey("/")
        await Bun.sleep(30)
        await setup.renderOnce()
        await setup.mockInput.typeText("b")
        await Bun.sleep(30)
      })
      expect(filter.value).toContain("b")
      controller.state = {
        ...controller.state,
        viewed: {
          [files[0]!.key]: {
            fileKey: files[0]!.key,
            path: files[0]!.path,
            contentId: files[0]!.contentId,
            generationId: controller.state.document.generation.id,
            viewedAt: "2026-08-28T00:00:00.000Z",
          },
        },
      }
      await act(async () => session.invalidate())
      await flush(setup)
      expect(setup.renderer.root.findDescendantById("review-file-row:src/unreviewed-a.ts")).toBeUndefined()
      expect(setup.renderer.root.findDescendantById("review-section:src/unreviewed-a.ts")).toBeUndefined()
      expect(setup.renderer.root.findDescendantById("review-file-row:src/unreviewed-b.ts")).toBeDefined()
    } finally {
      await act(async () => setup.renderer.destroy())
    }
  })

  test("keeps feedback-scoped files visible in both panes", async () => {
    const file = makeFile("src/feedback.ts", ["-old", "+new"])
    const session = makeSession([file])
    const controller = session.controller as unknown as { state: NonNullable<ReviewWorkspaceController["state"]> }
    controller.state = { ...controller.state, filter: { query: "", scope: "feedback" } }
    const setup = await testRender(<ReviewWorkspaceApp session={session} />, { width: 120, height: 30 })

    try {
      await flush(setup)
      expect(setup.renderer.root.findDescendantById("review-file-row:src/feedback.ts")).toBeUndefined()
      controller.state = {
        ...controller.state,
        feedback: [{
          id: "feedback-filter",
          kind: "note",
          severity: "comment",
          body: "keep this visible",
          anchor: createFileAnchor(file),
          resolution: "active",
          createdAt: "2026-08-28T00:00:00.000Z",
          updatedAt: "2026-08-28T00:00:00.000Z",
        }],
      }
      await act(async () => session.invalidate())
      await flush(setup)
      expect(setup.renderer.root.findDescendantById("review-file-row:src/feedback.ts")).toBeDefined()
      expect(setup.renderer.root.findDescendantById("review-section:src/feedback.ts")).toBeDefined()
    } finally {
      await act(async () => setup.renderer.destroy())
    }
  })
  test("edits selected feedback from the React composer", async () => {
    const file = makeFile("src/edit.ts", ["-old", "+new"])
    const feedback = [{
      id: "edit-feedback",
      kind: "note" as const,
      severity: "comment" as const,
      body: "old body",
      anchor: createFileAnchor(file),
      resolution: "active" as const,
      createdAt: "2026-08-28T00:00:00.000Z",
      updatedAt: "2026-08-28T00:00:00.000Z",
    }]
    const { session, getState } = makeInteractiveSession([file], feedback)
    const setup = await testRender(<ReviewWorkspaceApp session={session} />, { width: 120, height: 30 })

    try {
      await flush(setup)
      await act(async () => {
        await setup.mockInput.typeText("}")
        await Bun.sleep(30)
      })
      await flush(setup)
      await act(async () => {
        await setup.mockInput.typeText("e")
        await Bun.sleep(30)
      })
      await flush(setup)
      const body = setup.renderer.root.findDescendantById("review-feedback-body") as unknown as { plainText: string }
      await act(async () => {
        await setup.mockInput.typeText(" revised")
        await Bun.sleep(30)
      })
      await act(async () => {
        setup.mockInput.pressKey("s", { ctrl: true })
        await Bun.sleep(30)
      })
      await flush(setup)
      expect(getState().draft).toBeNull()
      expect(getState().feedback[0]?.body).toContain("revised")
    } finally {
      await act(async () => setup.renderer.destroy())
    }
  })
  test("resolves stale feedback through keyboard delete and reanchor actions", async () => {
    const file = makeFile("src/stale.ts", ["-old", "+new"])
    const staleRange = createRangeAnchor(file, { side: "new", startLine: 1, endLine: 1 })
    const feedback = [
      {
        id: "delete-feedback",
        kind: "note" as const,
        severity: "comment" as const,
        body: "remove me",
        anchor: createFileAnchor(file),
        resolution: "stale" as const,
        createdAt: "2026-08-28T00:00:00.000Z",
        updatedAt: "2026-08-28T00:00:00.000Z",
      },
      {
        id: "reanchor-feedback",
        kind: "note" as const,
        severity: "comment" as const,
        body: "move me",
        anchor: staleRange,
        resolution: "stale" as const,
        createdAt: "2026-08-28T00:00:00.000Z",
        updatedAt: "2026-08-28T00:00:00.000Z",
      },
    ]
    const { session, getState } = makeInteractiveSession([file], feedback)
    const setup = await testRender(<ReviewWorkspaceApp session={session} />, { width: 120, height: 30 })

    try {
      await flush(setup)
      await act(async () => {
        await setup.mockInput.typeText("}")
        await Bun.sleep(30)
      })
      await flush(setup)
      await act(async () => {
        await setup.mockInput.typeText("a")
        await Bun.sleep(30)
      })
      expect(getState().feedback.find((entry) => entry.id === "reanchor-feedback")?.resolution).toBe("active")
      await act(async () => {
        await setup.mockInput.typeText("}")
        await Bun.sleep(30)
      })
      await flush(setup)
      await act(async () => {
        await setup.mockInput.typeText("dd")
        await Bun.sleep(30)
      })
      await flush(setup)
      expect(getState().feedback.map((entry) => entry.id)).toEqual(["reanchor-feedback"])
    } finally {
      await act(async () => setup.renderer.destroy())
    }
  })
})
