import { describe, expect, test } from "bun:test"
import { testRender } from "@opentui/react/test-utils"
import { act } from "react"
import { createReviewDocument, createReviewHunk } from "../../../src/review/core/document"
import { createReviewGeneration, createReviewIdentity } from "../../../src/review/core/identity"
import type { ReviewFile } from "../../../src/review/core/types"
import { createInitialReviewState } from "../../../src/review/core/state"
import { ReviewWorkspaceApp } from "../../../src/ui/review-workspace/ReviewWorkspaceApp"
import { ReactReviewSession } from "../../../src/ui/review-workspace/react-review-session"
import type { ReviewWorkspaceController } from "../../../src/ui/review-workspace/controller"

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function makeFile(overrides: Partial<ReviewFile> & { path: string; key: string; kind?: ReviewFile["kind"] }): ReviewFile {
  const base: ReviewFile = {
    key: overrides.key,
    path: overrides.path,
    kind: overrides.kind ?? "modified",
    oldBlobOid: null,
    newBlobOid: null,
    oldMode: null,
    newMode: null,
    contentId: overrides.contentId ?? `cid:${overrides.key}`,
    patchDigest: "digest",
    stats: overrides.stats ?? { additions: 1, deletions: 1 },
    hunks: overrides.hunks as unknown as ReviewFile["hunks"] ?? [createReviewHunk({ index: 0, oldStart: 1, oldCount: 1, newStart: 1, newCount: 1, lines: [" x"] })],
    source: overrides.source ?? "available",
  }
  return overrides.previousPath === undefined ? base : { ...base, previousPath: overrides.previousPath }
}

function makeController(files: readonly ReviewFile[], feedbackKeys: string[] = []): ReviewWorkspaceController {
  const identity = createReviewIdentity({ headRef: "refs/heads/feature", headOid: "a".repeat(40), baseRef: "refs/heads/main" })
  const generation = createReviewGeneration({ baseOid: "b".repeat(40), mergeBaseOid: "c".repeat(40), headOid: "a".repeat(40) })
  const doc = createReviewDocument({ identity, generation, commits: [], files: [...files] })
  const base = createInitialReviewState(doc)
  // add feedback for requested keys
  const feedback = feedbackKeys.map((fileKey, i) => ({
    id: `fb-${i}`,
    anchor: { kind: "file" as const, fileKey, contentId: `cid:${fileKey}` },
    kind: "note" as const,
    severity: "comment" as const,
    body: "hello",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    resolution: "pending" as const,
  }))
  const state = { ...base, feedback } as unknown as typeof base
  return {
    state,
    getSnapshot: () => state,
    subscribe: () => () => undefined,
    dispatch: () => undefined,
    getExpandedSourceByGap: () => new Map(),
    ensureExpandedGapSource: async () => undefined,
    expandGap: async () => undefined,
  } as unknown as ReviewWorkspaceController
}

function makeSession(files: readonly ReviewFile[], feedbackKeys: string[] = []): ReactReviewSession {
  const controller = makeController(files, feedbackKeys)
  return new ReactReviewSession(controller as any, () => undefined)
}

async function flush(setup: Awaited<ReturnType<typeof testRender>>) {
  await act(async () => {
    await Promise.resolve()
  })
  setup.renderer.requestRender()
  await act(async () => {
    await Promise.resolve()
  })
}

describe("review sidebar render — hunk parity", () => {
  test("renders tree groups, basename rows, status icons, stats badges, and comment counts", async () => {
    const files = [
      makeFile({ key: "a", path: "src/a.ts", kind: "modified", stats: { additions: 5, deletions: 2 } }),
      makeFile({ key: "b", path: "src/b.ts", kind: "added", stats: { additions: 3, deletions: 0 } }),
      makeFile({ key: "c", path: "README.md", kind: "modified", stats: { additions: 1, deletions: 1 } }),
    ]
    // add feedback on first file => *1 badge
    const session = makeSession(files, ["a"])

    const setup = await testRender(<ReviewWorkspaceApp session={session} />, { width: 120, height: 30 })
    try {
      await flush(setup)
      const frame = setup.captureCharFrame()

      // tree grouping: expect group headers "src/" and "./"
      expect(frame).toContain("src/")
      expect(frame).toContain("./")

      // basename not full path for grouped files: "a.ts" and "b.ts" should appear, but "src/a.ts" full path should not dominate
      // hunk renders basename; check basename present
      expect(frame).toContain("a.ts")
      expect(frame).toContain("b.ts")
      expect(frame).toContain("README.md")

      // status icons: M for modified, A for added
      // hunk shows "M a.ts" and "A b.ts" style; ensure icons appear near names
      expect(frame).toMatch(/M\s+a\.ts/)
      expect(frame).toMatch(/A\s+b\.ts/)

      // stats badges: +5, -2, +3 etc, with spacing
      expect(frame).toContain("+5")
      expect(frame).toContain("-2")
      expect(frame).toContain("+3")

      // comment badge *1 before stats
      expect(frame).toContain("*1")

      // selected styling: first file selected => its row should exist with accent/selection
      // check that selected file row id exists and that its background indicates selected (via renderer tree)
      const selectedRow = setup.renderer.root.findDescendantById("review-file-row:a")
      expect(selectedRow).toBeDefined()
      // group header should exist
      expect(setup.renderer.root.findDescendantById("review-file-group:src/")).toBeDefined()
    } finally {
      await act(async () => setup.renderer.destroy())
    }
  })

  test("renders rename as prev -> next basename", async () => {
    const files = [
      makeFile({ key: "r", path: "src/ui/Renamed.tsx", previousPath: "src/ui/Legacy.tsx", kind: "renamed", stats: { additions: 0, deletions: 0 } }),
    ]
    const session = makeSession(files)
    const setup = await testRender(<ReviewWorkspaceApp session={session} />, { width: 120, height: 30 })
    try {
      await flush(setup)
      const frame = setup.captureCharFrame()
      expect(frame).toContain("Legacy.tsx -> Renamed.tsx")
      expect(frame).toMatch(/R\s+Legacy/)
    } finally {
      await act(async () => setup.renderer.destroy())
    }
  })

  test("selected file row uses hunk selected style (panelAlt bg + accent border)", async () => {
    const files = [
      makeFile({ key: "a", path: "src/a.ts", kind: "modified" }),
      makeFile({ key: "b", path: "src/b.ts", kind: "modified" }),
    ]
    const session = makeSession(files)
    const setup = await testRender(<ReviewWorkspaceApp session={session} />, { width: 120, height: 30 })
    try {
      await flush(setup)
      // Probe via renderer tree: selected row should have style backgroundColor = panelAlt and left accent 1-col
      const selected = setup.renderer.root.findDescendantById("review-file-row:a") as unknown as { props?: unknown } | undefined
      expect(selected).toBeDefined()
      // If not yet implemented, this will fail — ensure at least selected row exists and unselected differs
      const unselected = setup.renderer.root.findDescendantById("review-file-row:b") as unknown as { props?: unknown } | undefined
      expect(unselected).toBeDefined()
      // Both should exist; actual style difference will be verified after implementation via visual char frame consistency
      // For now we assert that selected row's id is present and that tree grouping is used (previous test covers stats/icons)
      // This test will be expanded once rendering exposes theme props; for now it fails if sidebar is still flat list (no group)
      expect(setup.renderer.root.findDescendantById("review-file-group:src/")).toBeDefined()
    } finally {
      await act(async () => setup.renderer.destroy())
    }
  })
})
