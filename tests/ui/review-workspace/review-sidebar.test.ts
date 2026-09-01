import { describe, expect, test } from "bun:test"
import { buildReviewSidebarEntries, sidebarEntryStats, sidebarEntryStatsWidth } from "../../../src/ui/review-workspace/review-sidebar"
import type { ReviewState } from "../../../src/review/core/state"
import { createReviewDocument, createReviewHunk } from "../../../src/review/core/document"
import { createReviewGeneration, createReviewIdentity } from "../../../src/review/core/identity"
import type { ReviewFile } from "../../../src/review/core/types"

function makeFile(overrides: Partial<ReviewFile> & { path: string; key: string }): ReviewFile {
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
    hunks: overrides.hunks ?? [createReviewHunk({ index: 0, oldStart: 1, oldCount: 1, newStart: 1, newCount: 1, lines: [" x"] })],
    source: overrides.source ?? "available",
  }
  return overrides.previousPath === undefined ? base : { ...base, previousPath: overrides.previousPath }
}

function makeState(files: ReviewFile[], feedbackFileKeys: string[] = []): ReviewState {
  const identity = createReviewIdentity({ headRef: "refs/heads/feature", headOid: "a".repeat(40), baseRef: "refs/heads/main" })
  const generation = createReviewGeneration({ baseOid: "b".repeat(40), mergeBaseOid: "c".repeat(40), headOid: "a".repeat(40) })
  const doc = createReviewDocument({ identity, generation, files, commits: [] })
  return {
    identity,
    generation,
    document: doc,
    selection: { fileKey: files[0]?.key ?? null, hunkIndex: 0 },
    viewed: new Map(),
    expandedGaps: [],
    filter: { query: "", scope: "all" },
    feedback: feedbackFileKeys.map((fileKey, i) => ({
      id: `fb-${i}`,
      anchor: { kind: "file" as const, fileKey, contentId: `cid:${fileKey}` },
      kind: "note" as const,
      severity: "comment" as const,
      body: "hello",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      resolution: "pending" as const,
    })),
    draft: null,
    viewport: { start: 0, height: 20 },
    error: undefined,
    projection: { kind: "aggregate" },
  } as unknown as ReviewState
}

describe("reviewSidebar — tree grouping (hunk parity)", () => {
  test("groups files by dirname and emits group headers in review order", () => {
    const files = [
      makeFile({ key: "a", path: "src/a.ts" }),
      makeFile({ key: "b", path: "README.md" }),
      makeFile({ key: "c", path: "src/b.ts" }),
      makeFile({ key: "d", path: "LICENSE" }),
    ]
    const entries = buildReviewSidebarEntries(makeState(files))
    const labels = entries.map((e) => (e.kind === "group" ? e.label : e.name))
    expect(labels).toEqual(["src/", "a.ts", "./", "README.md", "src/", "b.ts", "./", "LICENSE"])
  })

  test("file name is basename, rename shows prev -> next", () => {
    const files = [
      makeFile({ key: "r", path: "src/ui/Renamed.tsx", previousPath: "src/ui/Legacy.tsx", kind: "renamed" }),
      makeFile({ key: "m", path: "src/ui/only-add.ts" }),
    ]
    const entries = buildReviewSidebarEntries(makeState(files)).filter((e) => e.kind === "file")
    expect(entries[0]!.name).toBe("Legacy.tsx -> Renamed.tsx")
    expect(entries[1]!.name).toBe("only-add.ts")
  })

  test("hides zero-value stats, shows compact counts, and places comment badge first", () => {
    const files = [
      makeFile({ key: "only-add", path: "src/ui/only-add.ts", stats: { additions: 5, deletions: 0 } }),
      makeFile({ key: "only-del", path: "src/ui/only-del.ts", stats: { additions: 0, deletions: 3 } }),
      makeFile({ key: "zero", path: "src/ui/zero.ts", previousPath: "src/ui/Legacy.tsx", kind: "renamed", stats: { additions: 0, deletions: 0 } }),
    ]
    const entries = buildReviewSidebarEntries(makeState(files, ["zero"])).filter((e) => e.kind === "file")
    // only-add: +5 only
    expect(entries[0]).toMatchObject({ additionsText: "+5", deletionsText: null, agentCommentsText: null })
    // only-del: -3 only
    expect(entries[1]).toMatchObject({ additionsText: null, deletionsText: "-3" })
    // zero with feedback: *1 but no add/del
    expect(entries[2]).toMatchObject({ additionsText: null, deletionsText: null, agentCommentsText: "*1" })

    // stats ordering: agent comment first
    const withBoth = makeFile({ key: "both", path: "src/ui/both.ts", stats: { additions: 2, deletions: 2 } })
    const entry = buildReviewSidebarEntries(makeState([withBoth], ["both"])).filter((e) => e.kind === "file")[0]!
    const stats = sidebarEntryStats(entry)
    expect(stats.map((s) => s.text)).toEqual(["*1", "+2", "-2"])
    expect(stats.map((s) => s.kind)).toEqual(["agent-comment", "addition", "deletion"])
  })

  test("maps ReviewFile.kind to hunk changeType for status icon", () => {
    const files = [
      makeFile({ key: "added", path: "src/new.ts", kind: "added" }),
      makeFile({ key: "deleted", path: "src/old.ts", kind: "deleted" }),
      makeFile({ key: "renamed", path: "src/renamed-new.ts", previousPath: "src/renamed-old.ts", kind: "renamed" }),
      makeFile({ key: "modified", path: "src/mod.ts", kind: "modified" }),
      makeFile({ key: "copied", path: "src/copy.ts", kind: "copied" }),
    ]
    const entries = buildReviewSidebarEntries(makeState(files)).filter((e) => e.kind === "file")
    expect(entries[0]!.changeType).toBe("new")
    expect(entries[1]!.changeType).toBe("deleted")
    expect(entries[2]!.changeType).toBe("rename-changed")
    expect(entries[3]!.changeType).toBe("change")
    expect(entries[4]!.changeType).toBe("change")
  })

  test("statsWidth measures badges with inter-badge spaces", () => {
    const entry = { agentCommentsText: "*3", additionsText: "+5", deletionsText: "-2" } as const
    expect(sidebarEntryStatsWidth(entry)).toBe("*3".length + 1 + "+5".length + 1 + "-2".length)
    expect(sidebarEntryStatsWidth({ agentCommentsText: null, additionsText: null, deletionsText: null } as const)).toBe(0)
  })

  test("binary files have no stats badges but still render group and name", () => {
    const bin = makeFile({ key: "bin", path: "assets/image.png", kind: "binary", stats: { additions: null as unknown as number, deletions: null as unknown as number }, source: "binary" })
    const entries = buildReviewSidebarEntries(makeState([bin]))
    expect(entries).toEqual([
      { kind: "group", id: expect.stringContaining("group:assets"), label: "assets/" },
      expect.objectContaining({ kind: "file", name: "image.png", additionsText: null, deletionsText: null }),
    ])
  })

  test("escapes tabs in paths as \\t like hunk", () => {
    const file = makeFile({ key: "tab", path: "src/tab\tname.ts" })
    const entries = buildReviewSidebarEntries(makeState([file]))
    expect(entries[0]).toMatchObject({ kind: "group", label: "src/" })
    const f = entries[1] as Extract<typeof entries[number], { kind: "file" }>
    expect(f.name).toBe("tab\\tname.ts")
  })

  test("filter + ordering preserves review stream order while grouping", () => {
    const files = [
      makeFile({ key: "a", path: "src/a.ts" }),
      makeFile({ key: "b", path: "src/b.ts" }),
      makeFile({ key: "c", path: "test/c.ts" }),
    ]
    const state = makeState(files)
    // simulate text filter — we expect builder to be called with already-filtered visible files,
    // but ordering is preserved. This test verifies ids follow input order
    const entries = buildReviewSidebarEntries(state).filter((e) => e.kind === "file")
    expect(entries.map((e) => e.id)).toEqual(["a", "b", "c"])
  })
})
