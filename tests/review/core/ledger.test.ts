import { describe, expect, test } from "bun:test"
import { createReviewDocument, createReviewHunk } from "../../../src/review/core/document"
import { createReviewGeneration, createReviewIdentity } from "../../../src/review/core/identity"
import { createFileAnchor, createRangeAnchor, linesForAnchor } from "../../../src/review/core/anchors"
import { createInitialReviewState, type ReviewState } from "../../../src/review/core/state"
import {
  buildHandoffMailbox,
  latestHandoff,
  ledgerBadge,
  ledgerCounts,
  ledgerHeaderText,
  ledgerVerdict,
  objectionList,
  parseReviewReplies,
  renderHandoffMarkdown,
  reviewCheckpoint,
  serializeReviewReplies,
  type ReviewReplies,
} from "../../../src/review/core/ledger"
import type { ReviewDocument, ReviewFeedback, ReviewFile } from "../../../src/review/core/types"

const HANDOFF_OID = "a".repeat(40)
const LATER_OID = "b".repeat(40)

function makeFile(key: string, lines: readonly string[]): ReviewFile {
  return {
    key,
    path: key,
    kind: "modified",
    oldBlobOid: "o1",
    newBlobOid: "n1",
    oldMode: "100644",
    newMode: "100644",
    contentId: `content-${key}`,
    patchDigest: `patch-${key}`,
    stats: { additions: 1, deletions: 1 },
    hunks: [createReviewHunk({ index: 0, oldStart: 1, oldCount: lines.length, newStart: 1, newCount: lines.length, lines: lines.map((line) => ` ${line}`) })],
    source: "available",
  } as unknown as ReviewFile
}

function makeDoc(files: readonly ReviewFile[], headOid = LATER_OID): ReviewDocument {
  return createReviewDocument({
    identity: createReviewIdentity({ headRef: "refs/heads/feature", headOid, baseRef: "refs/heads/main" }),
    generation: createReviewGeneration({ mergeBaseOid: "m1", baseOid: "b1", headOid }),
    commits: [],
    files: [...files],
  })
}

function makeFeedback(overrides: Partial<ReviewFeedback> & { id: string; anchor: ReviewFeedback["anchor"] }): ReviewFeedback {
  return {
    kind: "note",
    severity: "comment",
    body: `body for ${overrides.id}`,
    resolution: "active",
    createdAt: "2026-09-08T00:00:00.000Z",
    updatedAt: "2026-09-08T00:00:00.000Z",
    ...overrides,
  }
}

function handedOff(overrides: Partial<ReviewFeedback> & { id: string; anchor: ReviewFeedback["anchor"] }): ReviewFeedback {
  return makeFeedback({
    status: "handed-off",
    handoff: { at: "2026-09-08T01:00:00.000Z", headOid: HANDOFF_OID },
    ...overrides,
  })
}

function stateWith(files: readonly ReviewFile[], feedback: readonly ReviewFeedback[]): ReviewState {
  return { ...createInitialReviewState(makeDoc(files)), feedback }
}

const replied = (id: string): ReviewReplies =>
  new Map([[id, { id, body: "because the range query needs it", at: "2026-09-08T02:00:00.000Z" }]])

describe("ledgerVerdict — resolution and status only mean something as a pair", () => {
  const anchor = createFileAnchor(makeFile("a.ts", ["one"]))

  test("feedback nobody has been asked to act on is open, whatever its anchor says", () => {
    for (const resolution of ["active", "stale", "orphaned"] as const) {
      expect(ledgerVerdict(makeFeedback({ id: "x", anchor, resolution }), LATER_OID)).toBe("open")
    }
  })

  test("an explicit open status reads the same as an absent one", () => {
    expect(ledgerVerdict(makeFeedback({ id: "x", anchor, status: "open" }), LATER_OID)).toBe("open")
  })

  test("while HEAD still sits at the handoff nothing is accused: nobody could have committed yet", () => {
    const feedback = handedOff({ id: "x", anchor })
    expect(ledgerVerdict(feedback, HANDOFF_OID)).toBe("waiting")
    // Without a HEAD to compare against there is no checkpoint, so the pair decides.
    expect(ledgerVerdict(feedback)).toBe("untouched")
  })

  test("once HEAD moves, an anchor that still resolves means those lines were left alone", () => {
    expect(ledgerVerdict(handedOff({ id: "x", anchor, resolution: "active" }), LATER_OID)).toBe("untouched")
  })
  test("a changed file-level anchor is addressed after handoff", () => {
    const handedOffFile = makeFile("a.ts", ["one"])
    const currentFile = { ...handedOffFile, contentId: "content-a.ts-current" }
    const feedback = handedOff({
      id: "x",
      anchor: createFileAnchor(currentFile),
      handoff: {
        at: "2026-09-08T01:00:00.000Z",
        headOid: HANDOFF_OID,
        contentId: handedOffFile.contentId,
      },
    })
    expect(ledgerVerdict(feedback, LATER_OID)).toBe("addressed")
  })


  test("an anchor that no longer resolves means the code under the objection moved", () => {
    for (const resolution of ["stale", "orphaned"] as const) {
      expect(ledgerVerdict(handedOff({ id: "x", anchor, resolution }), LATER_OID)).toBe("addressed")
    }
  })

  test("untouched lines plus an answer is an argument, not an oversight", () => {
    const feedback = handedOff({ id: "x", anchor, resolution: "active" })
    expect(ledgerVerdict(feedback, LATER_OID, { replied: true })).toBe("disputed")
    expect(ledgerVerdict(feedback, LATER_OID, { replied: false })).toBe("untouched")
  })

  test("a reply cannot talk a changed anchor out of its verdict", () => {
    expect(ledgerVerdict(handedOff({ id: "x", anchor, resolution: "stale" }), LATER_OID, { replied: true })).toBe("addressed")
  })

  test("a reply cannot promote feedback that was never handed off", () => {
    expect(ledgerVerdict(makeFeedback({ id: "x", anchor }), LATER_OID, { replied: true })).toBe("open")
  })

  test("resolved outranks everything, including a broken anchor and an answer", () => {
    const feedback = handedOff({ id: "x", anchor, status: "resolved", resolution: "orphaned" })
    expect(ledgerVerdict(feedback, LATER_OID, { replied: true })).toBe("resolved")
  })

  test("the badge shouts only for the two verdicts that need reading", () => {
    expect(ledgerBadge("untouched")).toBe("UNTOUCHED")
    expect(ledgerBadge("disputed")).toBe("DISPUTED")
    expect(ledgerBadge("addressed")).toBe("addressed")
    expect(ledgerBadge("resolved")).toBe("resolved")
    expect(ledgerBadge("waiting")).toBe("handed-off")
    expect(ledgerBadge("open")).toBe("open")
  })
})

describe("ledger counts and header", () => {
  const file = makeFile("a.ts", ["one", "two"])
  const anchor = createFileAnchor(file)

  test("counts every verdict and sums what still wants attention", () => {
    const feedback = [
      makeFeedback({ id: "open", anchor }),
      handedOff({ id: "untouched", anchor }),
      handedOff({ id: "disputed", anchor }),
      handedOff({ id: "addressed", anchor, resolution: "stale" }),
      handedOff({ id: "resolved", anchor, status: "resolved" }),
    ]
    const counts = ledgerCounts(feedback, LATER_OID, replied("disputed"))
    expect(counts).toMatchObject({ open: 1, waiting: 0, untouched: 1, disputed: 1, addressed: 1, resolved: 1 })
    // Resolved is settled; everything else is still the reviewer's problem.
    expect(counts.unsettled).toBe(4)
  })

  test("the header names only what is present, so an empty ledger stays silent", () => {
    expect(ledgerHeaderText([], LATER_OID)).toBe("")
    expect(ledgerHeaderText([handedOff({ id: "x", anchor })], HANDOFF_OID)).toBe("1 handed off")
    expect(ledgerHeaderText([handedOff({ id: "x", anchor })], LATER_OID)).toBe("1 UNTOUCHED")
    expect(ledgerHeaderText([handedOff({ id: "x", anchor })], LATER_OID, replied("x"))).toBe("1 DISPUTED")
  })
})

describe("reviewCheckpoint — what 'since' is measured from", () => {
  const anchor = createFileAnchor(makeFile("a.ts", ["one"]))
  const submission = { artifactId: "art", generationId: "gen", headOid: "c".repeat(40), submittedAt: "2026-09-08T00:30:00.000Z" }

  test("with neither stamp there is nothing to measure from", () => {
    expect(reviewCheckpoint({ feedback: [], lastSubmission: null })).toBeUndefined()
  })

  test("a handoff is a checkpoint even when no review was ever finished", () => {
    const checkpoint = reviewCheckpoint({ feedback: [handedOff({ id: "x", anchor })], lastSubmission: null })
    expect(checkpoint).toEqual({ kind: "handoff", at: "2026-09-08T01:00:00.000Z", headOid: HANDOFF_OID })
  })

  test("the later stamp wins, in both directions", () => {
    const laterHandoff = handedOff({ id: "x", anchor })
    expect(reviewCheckpoint({ feedback: [laterHandoff], lastSubmission: submission })?.kind).toBe("handoff")

    const earlierHandoff = makeFeedback({
      id: "y", anchor, status: "handed-off",
      handoff: { at: "2026-09-08T00:00:00.000Z", headOid: HANDOFF_OID },
    })
    expect(reviewCheckpoint({ feedback: [earlierHandoff], lastSubmission: submission })?.kind).toBe("submission")
  })

  test("the most recent handoff is the one that counts", () => {
    const older = makeFeedback({ id: "a", anchor, status: "handed-off", handoff: { at: "2026-09-08T00:00:00.000Z", headOid: "d".repeat(40) } })
    const newer = handedOff({ id: "b", anchor })
    expect(latestHandoff([older, newer])?.headOid).toBe(HANDOFF_OID)
    expect(latestHandoff([])).toBeUndefined()
    expect(latestHandoff([makeFeedback({ id: "c", anchor })])).toBeUndefined()
  })
})

describe("the mailbox", () => {
  const file = makeFile("src/cache.ts", ["one", "two", "three"])
  const range = createRangeAnchor(file, { side: "new", startLine: 2, endLine: 2 })

  test("carries enough to locate the lines and read the ask", () => {
    const state = stateWith([file], [makeFeedback({ id: "fb-1", anchor: range, severity: "blocking", body: "use find()" })])
    const mailbox = buildHandoffMailbox(state, { generatedAt: "2026-09-08T01:00:00.000Z", headOid: HANDOFF_OID })
    expect(mailbox.version).toBe(1)
    expect(mailbox.headOid).toBe(HANDOFF_OID)
    expect(mailbox.items).toEqual([{
      id: "fb-1",
      path: "src/cache.ts",
      side: "new",
      startLine: 2,
      endLine: 2,
      severity: "blocking",
      kind: "note",
      body: "use find()",
    }])
  })

  test("leaves out what the reviewer already closed", () => {
    const state = stateWith([file], [
      makeFeedback({ id: "live", anchor: range }),
      makeFeedback({ id: "done", anchor: range, status: "resolved" }),
    ])
    const mailbox = buildHandoffMailbox(state, { generatedAt: "t", headOid: HANDOFF_OID })
    expect(mailbox.items.map((item) => item.id)).toEqual(["live"])
  })

  test("tells the agent it cannot mark its own work done, and how to argue instead", () => {
    const state = stateWith([file], [makeFeedback({ id: "fb-1", anchor: range })])
    const markdown = renderHandoffMarkdown(buildHandoffMailbox(state, { generatedAt: "t", headOid: HANDOFF_OID }))
    expect(markdown).toContain("Do NOT report these as done")
    expect(markdown).toContain("UNTOUCHED")
    expect(markdown).toContain("githunk handoff reply --id <id>")
    expect(markdown).toContain("DISPUTED")
    expect(markdown).toContain("[fb-1] src/cache.ts:2")
  })

  test("an empty mailbox says so rather than rendering an instruction with no items", () => {
    const markdown = renderHandoffMarkdown(buildHandoffMailbox(stateWith([file], []), { generatedAt: "t", headOid: HANDOFF_OID }))
    expect(markdown).toContain("Nothing outstanding.")
    expect(markdown).not.toContain("Do NOT report")
  })
})

describe("replies are read as data, never trusted as structure", () => {
  test("round-trips what the agent wrote", () => {
    const replies = parseReviewReplies(serializeReviewReplies([{ id: "fb-1", body: "line one\nline two", at: "2026-09-08T02:00:00.000Z" }]))
    expect(replies.get("fb-1")?.body).toBe("line one\nline two")
  })

  test("anything malformed reads as no replies rather than failing the review", () => {
    for (const raw of [undefined, "", "   ", "not json", "[]", "null", "42", '{"replies":"nope"}', '{"replies":[null,3]}']) {
      expect(parseReviewReplies(raw).size).toBe(0)
    }
  })

  test("entries missing an id or a body are dropped, not defaulted", () => {
    const raw = JSON.stringify({ replies: [{ id: "", body: "x" }, { id: "a" }, { body: "b" }, { id: "space", body: "   " }, { id: "ok", body: "kept" }] })
    const replies = parseReviewReplies(raw)
    expect([...replies.keys()]).toEqual(["ok"])
  })

  test("a missing timestamp is empty rather than invented", () => {
    expect(parseReviewReplies(JSON.stringify({ replies: [{ id: "a", body: "b" }] })).get("a")?.at).toBe("")
  })

  test("the last reply for one objection wins", () => {
    const raw = JSON.stringify({ replies: [{ id: "a", body: "first" }, { id: "a", body: "second" }] })
    expect(parseReviewReplies(raw).get("a")?.body).toBe("second")
  })
})

describe("objectionList — the jump list carries the verdict, not just the place", () => {
  const first = makeFile("a.ts", ["one", "two"])
  const second = makeFile("b.ts", ["one", "two"])

  test("sorts by file then line, and says what is left to do", () => {
    const state = stateWith([first, second], [
      handedOff({ id: "second-file", anchor: createRangeAnchor(second, { side: "new", startLine: 1, endLine: 1 }) }),
      makeFeedback({ id: "first-file", anchor: createRangeAnchor(first, { side: "new", startLine: 2, endLine: 2 }), severity: "blocking" }),
    ])
    const entries = objectionList(state, LATER_OID)
    expect(entries.map((entry) => entry.id)).toEqual(["first-file", "second-file"])
    expect(entries[0]!.verdict).toBe("open")
    expect(entries[0]!.text).toContain("a.ts:2")
    expect(entries[0]!.text).toContain("!")
    expect(entries[1]!.verdict).toBe("untouched")
    expect(entries[1]!.text).toContain("UNTOUCHED")
  })

  test("an empty body still renders a row rather than a blank line", () => {
    const state = stateWith([first], [makeFeedback({ id: "x", anchor: createFileAnchor(first), body: "   " })])
    expect(objectionList(state, LATER_OID)[0]!.text).toContain("(empty)")
  })
  test("marks an answered untouched objection as disputed in the list", () => {
    const state = stateWith([first], [handedOff({ id: "answered", anchor: createFileAnchor(first) })])

    const entries = objectionList(state, LATER_OID, replied("answered"))

    expect(entries[0]?.verdict).toBe("disputed")
    expect(entries[0]?.text).toContain("DISPUTED")
  })
})

describe("linesForAnchor — the text an objection points at", () => {
  const file = makeFile("a.ts", ["alpha", "beta", "gamma"])
  const doc = makeDoc([file])

  test("reads the anchored range from the current document", () => {
    const anchor = createRangeAnchor(file, { side: "new", startLine: 2, endLine: 3 })
    expect(linesForAnchor(anchor, doc)).toEqual(["beta", "gamma"])
  })

  test("a file anchor has no lines to read", () => {
    expect(linesForAnchor(createFileAnchor(file), doc)).toBeUndefined()
  })

  test("an anchor whose file is gone reads as gone, not as empty", () => {
    const anchor = createRangeAnchor(file, { side: "new", startLine: 2, endLine: 2 })
    expect(linesForAnchor(anchor, makeDoc([makeFile("other.ts", ["x"])]))).toBeUndefined()
  })
})
