import { describe, expect, test } from "bun:test"
import { testRender } from "@opentui/react/test-utils"
import { act } from "react"
import { createReviewDocument, createReviewHunk } from "../../../src/review/core/document"
import { createReviewGeneration, createReviewIdentity } from "../../../src/review/core/identity"
import { createInitialReviewState } from "../../../src/review/core/state"
import { toHunkReviewFile } from "../../../src/ui/review-workspace/hunk-review-model"
import { ReviewDiffPane } from "../../../src/ui/review-workspace/components/ReviewDiffPane"
import type { ReviewFile } from "../../../src/review/core/types"

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

function makeState(files: readonly ReviewFile[]) {
  const identity = createReviewIdentity({ headRef: "refs/heads/feature", headOid: "a".repeat(40), baseRef: "refs/heads/main" })
  const generation = createReviewGeneration({ baseOid: "b".repeat(40), mergeBaseOid: "c".repeat(40), headOid: "a".repeat(40) })
  return createInitialReviewState(createReviewDocument({ identity, generation, commits: [], files }))
}

async function flush(setup: Awaited<ReturnType<typeof testRender>>) {
  await act(async () => {
    await setup.renderOnce()
    await Bun.sleep(0)
    await setup.renderOnce()
  })
}
type TestNode = Readonly<{
  id?: string
  getChildren: () => readonly TestNode[]
}>

function countDescendants(node: TestNode, predicate: (id: string | undefined) => boolean): number {
  let count = predicate(node.id) ? 1 : 0
  for (const child of node.getChildren()) {
    count += countDescendants(child, predicate)
  }
  return count
}

describe("React review diff pane", () => {
  test("renders a persistent split scrollbox with paired left and right cells", async () => {
    const file = makeFile("src/example.ts", ["-const old = 1", "+const next = 2"])
    const state = makeState([file])
    const setup = await testRender(
      <ReviewDiffPane
        files={[toHunkReviewFile(file)]}
        state={state}
        layout="split"
        width={120}
        height={20}
        selectedFileKey={file.key}
        selectedHunkIndex={0}
      />,
      { width: 120, height: 20, useMouse: true, enableMouseMovement: true },
    )

    try {
      await flush(setup)
      const scrollBox = setup.renderer.root.findDescendantById("review-diff-scrollbox")
      expect(scrollBox).toBeDefined()
      const frame = setup.captureCharFrame()
      expect(frame).toContain("const old = 1")
      expect(frame).toContain("const next = 2")
    } finally {
      await act(async () => setup.renderer.destroy())
    }
  })

  test("keeps a large review windowed instead of mounting every diff row", async () => {
    const files = Array.from({ length: 120 }, (_, index) => makeFile(`src/file-${index}.ts`, ["-const old = 1", "+const next = 2"]))
    const state = makeState(files)
    const setup = await testRender(
      <ReviewDiffPane
        files={files.map((file) => toHunkReviewFile(file))}
        state={state}
        layout="stack"
        width={120}
        height={20}
        selectedFileKey={files[0]!.key}
        selectedHunkIndex={0}
      />,
      { width: 120, height: 20, useMouse: true, enableMouseMovement: true },
    )

    try {
      await flush(setup)
      const mountedRows = setup.renderer.root.getChildren().length
      expect(mountedRows).toBeLessThan(files.length)
    } finally {
      await act(async () => setup.renderer.destroy())
    }
  })
  test("bounds mounted rows inside one very large file", async () => {
    const file = makeFile("src/large.ts", Array.from({ length: 1_000 }, (_, index) => `+const line${index} = ${index}`))
    const state = makeState([file])
    const setup = await testRender(
      <ReviewDiffPane
        files={[toHunkReviewFile(file)]}
        state={state}
        layout="stack"
        width={120}
        height={10}
        selectedFileKey={file.key}
        selectedHunkIndex={0}
      />,
      { width: 120, height: 10, useMouse: true, enableMouseMovement: true },
    )

    try {
      const mountedRows = countDescendants(setup.renderer.root as unknown as TestNode, (id) => id?.includes(":stack:") === true)
      expect(mountedRows).toBeLessThan(100)
    } finally {
      await act(async () => setup.renderer.destroy())
    }
  })

  test("scrolls the persistent viewport on mouse wheel input", async () => {
    const files = Array.from({ length: 20 }, (_, index) => makeFile(`src/scroll-${index}.ts`, Array.from({ length: 10 }, () => "+const next = 2")))
    const setup = await testRender(
      <ReviewDiffPane
        files={files.map((file) => toHunkReviewFile(file))}
        state={makeState(files)}
        layout="stack"
        width={120}
        height={10}
        selectedFileKey={files[0]!.key}
        selectedHunkIndex={0}
      />,
      { width: 120, height: 10, useMouse: true, enableMouseMovement: true },
    )

    try {
      await flush(setup)
      const scrollBox = setup.renderer.root.findDescendantById("review-diff-scrollbox") as unknown as { x: number; y: number; scrollTop: number }
      await act(async () => {
        await setup.mockMouse.scroll(scrollBox.x + 2, scrollBox.y + 2, "down")
        await setup.renderOnce()
        await Bun.sleep(0)
        await setup.renderOnce()
      })
      expect(scrollBox.scrollTop).toBeGreaterThan(0)
    } finally {
      await act(async () => setup.renderer.destroy())
    }
  })
})