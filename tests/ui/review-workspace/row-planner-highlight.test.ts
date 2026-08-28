import { describe, expect, test } from "bun:test"
import { createReviewDocument, createReviewHunk } from "../../../src/review/core/document"
import { createReviewGeneration, createReviewIdentity } from "../../../src/review/core/identity"
import { createInitialReviewState } from "../../../src/review/core/state"
import { planReviewRows, __clearRowPlannerCache } from "../../../src/ui/review-workspace/row-planner"
import type { HighlightPayload } from "../../../src/review/git/highlight/highlight-payload"
import { loadHighlightForPatch } from "../../../src/review/git/highlight/highlight-adapter"

function makeIdentity(headOid = "a".repeat(40)) {
  return createReviewIdentity({ headRef: "refs/heads/feature", headOid, baseRef: "refs/heads/main" })
}
function makeGeneration(headOid = "a".repeat(40)) {
  return createReviewGeneration({ baseOid: "b".repeat(40), mergeBaseOid: "c".repeat(40), headOid })
}
function makeHunk(lines: string[]) {
  return createReviewHunk({ oldStart: 1, oldCount: 1, newStart: 1, newCount: 1, lines, index: 0 })
}
function makeFile(key: string, path: string, hunks: ReturnType<typeof createReviewHunk>[], overrides?: Partial<import("../../../src/review/core/types").ReviewFile>) {
  return {
    key,
    path,
    kind: "modified" as const,
    oldBlobOid: "o1",
    newBlobOid: "n1",
    oldMode: "100644",
    newMode: "100644",
    contentId: `content-${key}`,
    patchDigest: `patch-${key}`,
    stats: { additions: 1, deletions: 1 },
    hunks,
    source: "available" as const,
    ...overrides,
  }
}
function makeDoc(files: ReturnType<typeof makeFile>[]) {
  const identity = makeIdentity()
  const generation = makeGeneration()
  return createReviewDocument({ identity, generation, commits: [{ oid: "a".repeat(40), parents: [], author: "A", timestamp: 0, subject: "s", body: "" }], files })
}

describe("row-planner highlight integration", () => {
  test("emits highlighted spans for addition lines when payload present", async () => {
    __clearRowPlannerCache()
    const patch = `diff --git a/foo.ts b/foo.ts
--- a/foo.ts
+++ b/foo.ts
@@ -1,1 +1,1 @@
-const x: number = 1
+const y: string = "hi"
`
    const payload = await loadHighlightForPatch(patch, "foo.ts", "dark")
    expect(payload).not.toBeNull()

    const file = makeFile("foo.ts", "foo.ts", [makeHunk(["-const x: number = 1", "+const y: string = \"hi\""])])
    const doc = makeDoc([file])
    const state = createInitialReviewState(doc)
    const plan = planReviewRows(state, {
      viewportStart: 0,
      viewportHeight: 20,
      width: 80,
      effectiveMode: "stack",
      showLineNumbers: true,
      wrapLines: false,
      highlightByFileKey: new Map<string, HighlightPayload>([["foo.ts", payload!]]),
    })
    const additionRows = plan.rows.filter((r) => r.kind === "diff" && r.newLine === 1)
    expect(additionRows.length).toBeGreaterThan(0)
    const additionRow = additionRows[0]!
    // At least one span after gutter should have fg
    const hasFg = additionRow.text.some((s) => (s as unknown as { fg?: string }).fg !== undefined)
    expect(hasFg).toBe(true)
  })

  test("fallback to plain style when no highlight payload", () => {
    __clearRowPlannerCache()
    const file = makeFile("bar.ts", "bar.ts", [makeHunk(["-old", "+new"])])
    const doc = makeDoc([file])
    const state = createInitialReviewState(doc)
    const plan = planReviewRows(state, {
      viewportStart: 0,
      viewportHeight: 20,
      width: 80,
      effectiveMode: "stack",
      showLineNumbers: true,
      wrapLines: false,
    })
    const additionRow = plan.rows.find((r) => r.kind === "diff" && r.newLine !== null)
    expect(additionRow).toBeDefined()
    // Without highlight, spans should have style addition but no fg
    const additionSpans = additionRow!.text.filter((s) => s.style === "addition")
    expect(additionSpans.length).toBeGreaterThan(0)
    const hasFg = additionSpans.some((s) => (s as unknown as { fg?: string }).fg !== undefined)
    expect(hasFg).toBe(false)
  })

  test("binary file still renders binary row even with empty highlight map", () => {
    __clearRowPlannerCache()
    const file = makeFile("img.png", "img.png", [], { kind: "binary", source: "binary" as const })
    const doc = makeDoc([file])
    const state = createInitialReviewState(doc)
    const plan = planReviewRows(state, {
      viewportStart: 0,
      viewportHeight: 20,
      width: 80,
      effectiveMode: "stack",
      showLineNumbers: true,
      wrapLines: false,
      highlightByFileKey: new Map(),
    })
    expect(plan.rows.some((r) => r.kind === "binary")).toBe(true)
  })

  test("windowed plan still returns highlight-aware rows after scroll", async () => {
    __clearRowPlannerCache()
    const patch = `diff --git a/foo.ts b/foo.ts
--- a/foo.ts
+++ b/foo.ts
@@ -1,1 +1,1 @@
-const a = 1
+const b = 2
`
    const payload = await loadHighlightForPatch(patch, "foo.ts", "dark")
    const file = makeFile("foo.ts", "foo.ts", [makeHunk(["-const a = 1", "+const b = 2"])])
    const doc = makeDoc([file])
    const state = createInitialReviewState(doc)
    const plan0 = planReviewRows(state, {
      viewportStart: 0,
      viewportHeight: 5,
      width: 80,
      effectiveMode: "stack",
      showLineNumbers: true,
      wrapLines: false,
      highlightByFileKey: new Map([["foo.ts", payload!]]),
    })
    const plan1 = planReviewRows(state, {
      viewportStart: 2,
      viewportHeight: 5,
      width: 80,
      effectiveMode: "stack",
      showLineNumbers: true,
      wrapLines: false,
      highlightByFileKey: new Map([["foo.ts", payload!]]),
    })
    // Both windows should contain highlighted rows if they include diff lines
    const hasFg0 = plan0.rows.some((r) => r.text.some((s) => (s as unknown as { fg?: string }).fg))
    const hasFg1 = plan1.rows.some((r) => r.text.some((s) => (s as unknown as { fg?: string }).fg))
    // At least one window should have highlight
    expect(hasFg0 || hasFg1).toBe(true)
  })
})
