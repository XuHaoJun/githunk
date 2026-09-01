import { describe, expect, test } from "bun:test"
import { reviewHeaderLines } from "../../../src/ui/review-workspace/header"
import { createReviewDocument } from "../../../src/review/core/document"
import { createReviewGeneration, createReviewIdentity } from "../../../src/review/core/identity"
import { createReviewHunk } from "../../../src/review/core/document"
import type { ReviewState } from "../../../src/review/core/state"
import { cellWidth } from "../../../src/ui/cell-width"

function makeState(opts?: {
  headRef?: string | null
  baseRef?: string
  files?: number
  stats?: Array<{ additions: number | null; deletions: number | null }>
  viewed?: Record<string, { contentId: string; path: string }>
  projection?: ReviewState["projection"]
}): ReviewState {
  const identity = createReviewIdentity({
    headRef: opts?.headRef ?? "refs/heads/feature/payment",
    headOid: "a".repeat(40),
    baseRef: opts?.baseRef ?? "refs/heads/main",
  })
  const generation = createReviewGeneration({ baseOid: "b".repeat(40), mergeBaseOid: "c".repeat(40), headOid: "a".repeat(40) })
  const files = Array.from({ length: opts?.files ?? 3 }, (_, i) => {
    const stats = opts?.stats?.[i] ?? { additions: 10, deletions: 2 }
    return {
      key: `file-${i}.ts`,
      path: `src/file-${i}.ts`,
      kind: "modified" as const,
      oldBlobOid: "o",
      newBlobOid: "n",
      oldMode: "100644",
      newMode: "100644",
      contentId: `c${i}`,
      patchDigest: `p${i}`,
      stats,
      hunks: [createReviewHunk({ index: 0, oldStart: 1, oldCount: 1, newStart: 1, newCount: 1, lines: ["-old", "+new"] })],
      source: "available" as const,
    }
  })
  const doc = createReviewDocument({ identity, generation, commits: [{ oid: "a".repeat(40), parents: [], author: "A", timestamp: 0, subject: "s", body: "" }], files })
  const viewedValue = (opts?.viewed ?? {}) as ReviewState["viewed"]
  return {
    document: doc,
    revision: 0,
    projection: opts?.projection ?? { kind: "aggregate" },
    selection: { fileKey: files[0]?.key ?? null, hunkIndex: 0 },
    reveal: { fileTopToken: 0, fileTopRequestToken: 0, hunkToken: 0, scrollToFeedback: false },
    filter: { query: "", scope: "all" },
    viewed: viewedValue,
    feedback: [],
    draft: null,
    expandedGaps: [],
    lastSubmission: null,
  }
}

describe("reviewHeaderLines", () => {
  test("shows head→base, commits, files, and additions/deletions", () => {
    const state = makeState({ files: 2, stats: [{ additions: 842, deletions: 193 }, { additions: 5, deletions: 1 }] })
    const lines = reviewHeaderLines(state, 120)
    const text = lines.flatMap((l) => l.map((s) => s.text)).join(" ")
    expect(text).toContain("feature/payment")
    expect(text).toContain("main")
    expect(text).toMatch(/feature/)
    expect(text).toMatch(/main/)
    expect(text).toContain("2 files")
    expect(text).toContain("+847")
    expect(text).toContain("−194")
  })

  test("binary counts render as —", () => {
    const state = makeState({ files: 1, stats: [{ additions: null, deletions: null }] })
    const lines = reviewHeaderLines(state, 120)
    const text = lines.flatMap((l) => l.map((s) => s.text)).join(" ")
    expect(text).toContain("—")
    expect(text).not.toContain("null")
  })

  test("shows Viewed progress and pending counts", () => {
    const state = makeState({
      files: 3,
      viewed: {
        "file-0.ts": { fileKey: "file-0.ts", path: "src/file-0.ts", contentId: "c0", generationId: "g", viewedAt: "now" } as unknown as ReviewState["viewed"] extends Record<string, infer V> ? V : never,
      },
    })
    const feedbackState = { ...state, feedback: [{ id: "1", anchor: { kind: "file" as const, fileKey: "file-1.ts", contentId: "x" }, kind: "note" as const, severity: "comment" as const, body: "x", resolution: "active" as const, createdAt: "now", updatedAt: "now" }] } as unknown as ReviewState
    const lines = reviewHeaderLines(feedbackState, 120)
    const text = lines.flatMap((l) => l.map((s) => s.text)).join(" ")
    expect(text).toMatch(/Reviewed|viewed/i)
  })

  test("always shows the active aggregate projection label", () => {
    const labels = [
      { kind: "aggregate" as const },
      { kind: "since-last-review" as const, fromHeadOid: "a".repeat(40) },
      { kind: "commit" as const, oid: "b".repeat(40) },
    ].map((projection) => reviewHeaderLines(makeState({ projection }), 120).flatMap((line) => line.map((span) => span.text)).join(" "))
    for (const text of labels) {
      expect(text).toContain("Aggregate")
      expect(text).not.toContain("Since Last")
      expect(text).not.toContain("Commit")
    }
  })

  test("CJK-width header truncation respects cell width", () => {
    const state = makeState({ headRef: "refs/heads/機能ブランチ-very-long-name-exceeding-width", baseRef: "refs/heads/main" })
    const narrowWidth = 20
    const lines = reviewHeaderLines(state, narrowWidth)
    for (const line of lines) {
      const text = line.map((s) => s.text).join("")
      const w = cellWidth(text)
      expect(w).toBeLessThanOrEqual(narrowWidth)
    }
    const first = lines[0]
    if (!first) throw new Error("expected header line")
    const truncated = first.map((s) => s.text).join("")
    expect(truncated.length).toBeLessThan("refs/heads/機能ブランチ-very-long-name-exceeding-width → refs/heads/main".length)
  })

  test("returns styled spans without mutating state", () => {
    const state = makeState()
    const lines = reviewHeaderLines(state, 80)
    expect(Array.isArray(lines)).toBe(true)
    expect(lines.length).toBeGreaterThan(0)
    for (const line of lines) {
      for (const span of line) {
        expect(span).toHaveProperty("text")
        expect(span).toHaveProperty("style")
      }
    }
    const lines2 = reviewHeaderLines(state, 80)
    expect(lines).toEqual(lines2)
  })
})
