import { describe, expect, test } from "bun:test"
import { REVIEW_COMMANDS, resolveReviewCommand, reviewHelp, reviewHints } from "../../../src/ui/review-workspace/command-catalog"
import type { ReviewState } from "../../../src/review/core/state"
import { createReviewDocument } from "../../../src/review/core/document"
import { createReviewGeneration, createReviewIdentity } from "../../../src/review/core/identity"
import { createReviewHunk } from "../../../src/review/core/document"

function makeState(projection: ReviewState["projection"]): ReviewState {
  const identity = createReviewIdentity({ headRef: "refs/heads/feature", headOid: "a".repeat(40), baseRef: "refs/heads/main" })
  const generation = createReviewGeneration({ baseOid: "b".repeat(40), mergeBaseOid: "c".repeat(40), headOid: "a".repeat(40) })
  const doc = createReviewDocument({
    identity,
    generation,
    commits: [{ oid: "a".repeat(40), parents: [], author: "A", timestamp: 0, subject: "s", body: "" }],
    files: [
      {
        key: "src/a.ts",
        path: "src/a.ts",
        kind: "modified",
        oldBlobOid: "o1",
        newBlobOid: "n1",
        oldMode: "100644",
        newMode: "100644",
        contentId: "c1",
        patchDigest: "p1",
        stats: { additions: 1, deletions: 1 },
        hunks: [createReviewHunk({ index: 0, oldStart: 1, oldCount: 1, newStart: 1, newCount: 1, lines: ["-old", "+new"] })],
        source: "available",
      },
    ],
  })
  return {
    document: doc,
    revision: 0,
    projection,
    selection: { fileKey: "src/a.ts", hunkIndex: 0 },
    reveal: { fileTopToken: 0, fileTopRequestToken: 0, hunkToken: 0, scrollToFeedback: false },
    filter: { query: "", scope: "all" },
    viewed: {},
    feedback: [],
    draft: null,
    expandedGaps: [],
    lastSubmission: null,
  }
}

describe("command-catalog defaults — exact spec §5.4 keys", () => {
  test("contains all required default keys", () => {
    const byId = new Map(REVIEW_COMMANDS.map((c) => [c.id, c]))
    expect(byId.get("review.moveDown")?.keys).toEqual(expect.arrayContaining(["j"]))
    expect(byId.get("review.moveUp")?.keys).toEqual(expect.arrayContaining(["k"]))
    const downKeys = byId.get("review.moveDown")?.keys.join(",") ?? ""
    const upKeys = byId.get("review.moveUp")?.keys.join(",") ?? ""
    expect(downKeys).toContain("ArrowDown")
    expect(upKeys).toContain("ArrowUp")
    expect(byId.get("review.nextHunk")?.keys).toEqual(["]"])
    expect(byId.get("review.prevHunk")?.keys).toEqual(["["])
    expect(byId.get("review.nextFile")?.keys).toEqual(["."])
    expect(byId.get("review.prevFile")?.keys).toEqual([","])
    expect(byId.get("review.nextUnreviewed")?.keys).toEqual(["n"])
    expect(byId.get("review.prevUnreviewed")?.keys).toEqual(["N"])
    expect(byId.get("review.nextFeedback")?.keys).toEqual(["}"])
    expect(byId.get("review.prevFeedback")?.keys).toEqual(["{"])
    expect(byId.get("review.focusFilter")?.keys).toEqual(["/"])
    expect(byId.get("review.toggleFocus")?.keys).toEqual(["tab"])
    expect(byId.get("review.toggleRange")?.keys).toEqual(["v"])
    expect(byId.get("review.createFeedback")?.keys).toEqual(["c"])
    expect(byId.get("review.markViewed")?.keys).toEqual(["r"])
    expect(byId.get("review.focusDiff")?.keys).toEqual(["0"])
    expect(byId.get("review.focusFiles")?.keys).toEqual(["1"])
    expect(byId.get("review.layoutCycle")?.keys).toEqual(["l"])
    expect(byId.get("review.finishReview")?.keys).toEqual(["R"])
    expect(byId.get("review.help")?.keys).toEqual(["?"])
    expect(byId.get("review.close")?.keys).toEqual(["escape"])
  })
  test("aggregate owns panel bindings and layout has no numeric aliases", () => {
    const command = (id: string) => REVIEW_COMMANDS.find((entry) => entry.id === id)!
    expect(command("review.focusDiff").keys).toEqual(["0"])
    expect(command("review.focusFiles").keys).toEqual(["1"])
    expect(command("review.toggleFocus").keys).toEqual(["tab"])
    expect(command("review.layoutCycle").keys).toEqual(["l"])
    expect(REVIEW_COMMANDS.flatMap((entry) => entry.keys)).not.toContain("2")
    expect(REVIEW_COMMANDS.some((entry) => /projection|since last|commit projection/i.test(entry.title))).toBe(false)
  })

  test("uses only spec §5.4 keys — no old Branch Review compatibility aliases", () => {
    const allKeys = REVIEW_COMMANDS.flatMap((c) => c.keys)
    expect(allKeys).not.toContain("b")
    expect(allKeys).not.toContain("q")
    for (const k of allKeys) {
      expect(k).not.toMatch(/^ctrl\+/i)
    }
  })
})

describe("command-catalog — unique key claims per focus context", () => {
  test("no duplicate keys within the same focus", () => {
    const focusGroups = new Map<string, Map<string, string>>()
    for (const cmd of REVIEW_COMMANDS) {
      for (const focus of cmd.focus) {
        if (!focusGroups.has(focus)) focusGroups.set(focus, new Map())
        const m = focusGroups.get(focus)!
        for (const key of cmd.keys) {
          if (focus === "any" || focus === "global") continue
          if (m.has(key)) {
            throw new Error(`duplicate key "${key}" in focus "${focus}" between ${m.get(key)} and ${cmd.id}`)
          }
          m.set(key, cmd.id)
        }
      }
    }
    expect(focusGroups.size).toBeGreaterThan(0)
  })

  test("resolveReviewCommand respects focus", () => {
    const cmdStream = resolveReviewCommand("j", "stream")
    expect(cmdStream?.id).toBe("review.moveDown")
    const cmdEsc = resolveReviewCommand("escape", "stream")
    expect(cmdEsc?.id).toBe("review.close")
    const cmdSlash = resolveReviewCommand("/", "sidebar")
    expect(cmdSlash?.id).toBe("review.focusFilter")
    expect(resolveReviewCommand("ctrl+x", "stream")).toBeUndefined()
  })
})

describe("command-catalog — availability per projection", () => {
  test("markViewed available in aggregate and since-last, disabled in commit", () => {
    const agg = makeState({ kind: "aggregate" })
    const since = makeState({ kind: "since-last-review", fromHeadOid: "deadbeef".repeat(5) })
    const commit = makeState({ kind: "commit", oid: "abc".repeat(13) })
    const mark = REVIEW_COMMANDS.find((c) => c.id === "review.markViewed")!
    expect(mark.available(agg)).toBe(true)
    expect(mark.available(since)).toBe(true)
    expect(mark.available(commit)).toBe(false)
  })

  test("navigation commands available in all projections", () => {
    const states = [
      makeState({ kind: "aggregate" }),
      makeState({ kind: "since-last-review", fromHeadOid: "x".repeat(40) }),
      makeState({ kind: "commit", oid: "y".repeat(40) }),
    ]
    const ids = ["review.nextHunk", "review.prevHunk", "review.nextFile", "review.prevFile", "review.nextFeedback", "review.prevFeedback"]
    for (const id of ids) {
      const cmd = REVIEW_COMMANDS.find((c) => c.id === id)!
      for (const s of states) expect(cmd.available(s)).toBe(true)
    }
  })

  test("layout and help always available", () => {
    const s = makeState({ kind: "commit", oid: "z".repeat(40) })
    for (const id of ["review.layoutCycle", "review.help", "review.close"]) {
      expect(REVIEW_COMMANDS.find((c) => c.id === id)!.available(s)).toBe(true)
    }
  })
})

describe("command-catalog — context-aware hints/help", () => {
  test("hints differ by focus and include available keys", () => {
    const agg = makeState({ kind: "aggregate" })
    const streamHints = reviewHints("stream", agg)
    const sidebarHints = reviewHints("sidebar", agg)
    expect(streamHints).toContain("j")
    expect(streamHints).toContain("]")
    expect(sidebarHints).toContain("/")
    expect(streamHints).not.toBe(sidebarHints)
    const helpStream = reviewHelp("stream", agg)
    const helpCommit = reviewHelp("stream", makeState({ kind: "commit", oid: "a".repeat(40) }))
    expect(helpStream).toContain("Mark current file Viewed")
    expect(helpStream).toContain("r")
    expect(helpStream).toContain("0 Diff")
    expect(helpStream).toContain("1 Files")
    expect(helpStream).toContain("Tab cycle panels")
    expect(helpStream).toContain("l layout")
    expect(helpStream).toContain("Begin/end semantic line/range selection")
    expect(helpStream).toContain("e Edit selected feedback")
    expect(helpStream).toContain("d Delete selected feedback")
    expect(helpStream).toContain("a Re-anchor selected feedback")
    expect(helpStream).toContain("z Expand context gap")
    expect(helpStream).toContain("f Cycle filter scope")
  })
})

describe("command-catalog — full keyboard coverage for every mouse action", () => {
  test("every mouse action has a keyboard equivalent", () => {
    const mouseToKeyboard: Record<string, readonly string[]> = {
      sidebarSelect: ["review.nextFile", "review.prevFile", "review.nextUnreviewed", "review.prevUnreviewed"],
      streamScroll: ["review.moveDown", "review.moveUp"],
      lineRangeSelect: ["review.toggleRange"],
      gapExpand: ["review.nextHunk", "review.prevHunk"],
      feedbackSelect: ["review.nextFeedback", "review.prevFeedback"],
      menuAction: ["review.help", "review.close"],
    }
    for (const [mouse, ids] of Object.entries(mouseToKeyboard)) {
      for (const id of ids) {
        const cmd = REVIEW_COMMANDS.find((c) => c.id === id)
        expect(cmd, `mouse ${mouse} -> ${id} missing`).toBeDefined()
        expect(cmd!.keys.length, `mouse ${mouse} -> ${id} has no keys`).toBeGreaterThan(0)
      }
    }
  })
})
