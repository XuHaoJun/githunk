import { describe, expect, test } from "bun:test"
import { ReviewWorkspaceController } from "../../../src/ui/review-workspace/controller"
import { createReviewDocument, createReviewHunk } from "../../../src/review/core/document"
import { createReviewIdentity, createReviewGeneration } from "../../../src/review/core/identity"
import type { ReviewFile } from "../../../src/review/core/types"
import type { GitRunner } from "../../../src/git/runner"

function fakeRunner(): GitRunner {
  const log = {
    logIntro: () => {},
    logAction: () => {},
    logCommand: () => {},
    logTip: () => {},
    lines: () => [] as unknown[],
    autoscrollArms: () => false,
    commandLogSnapshot: () => ({ entries: [] }),
  } as unknown as GitRunner["log"]
  return { run: async () => ({ stdout: "", stderr: "", exitCode: 0 }), log, cwd: "/tmp/fake" } as unknown as GitRunner
}

function makeHunk(index: number, lines: string[]) {
  return createReviewHunk({ index, oldStart: 1, oldCount: lines.filter((l) => l[0] !== "+").length, newStart: 1, newCount: lines.filter((l) => l[0] !== "-").length, lines })
}

function makeFile(key: string, path: string): ReviewFile {
  return {
    kind: "modified",
    key,
    path,
    oldBlobOid: "o1",
    newBlobOid: "n1",
    oldMode: "100644",
    newMode: "100644",
    contentId: `content-${key}`,
    patchDigest: `patch-${key}`,
    stats: { additions: 1, deletions: 1 },
    hunks: [makeHunk(0, [" a", "+b"])],
    source: "available",
  } as unknown as ReviewFile
}

function makeDoc(files: ReviewFile[]) {
  const headOid = "a".repeat(40)
  const identity = createReviewIdentity({ headRef: "refs/heads/feature", headOid, baseRef: "refs/heads/main" })
  const generation = createReviewGeneration({ baseOid: "b".repeat(40), mergeBaseOid: "c".repeat(40), headOid })
  return createReviewDocument({ identity, generation, commits: [{ oid: headOid, parents: [], author: "A", timestamp: 0, subject: "s", body: "" }], files })
}

describe("ReviewWorkspaceController.dispatchIntent", () => {
  test("returns false and leaves state untouched for an intent that fails validation", async () => {
    const doc = makeDoc([makeFile("a", "src/a.ts"), makeFile("b", "src/b.ts")])
    const controller = new ReviewWorkspaceController({ runner: fakeRunner(), loadDocument: async () => doc })
    await controller.open("refs/heads/main")
    const before = controller.state

    expect(controller.dispatchIntent({ type: "selection/select-file", fileKey: "missing" })).toBe(false)
    expect(controller.state).toBe(before)
    await controller.destroy()
  })

  test("returns true and advances state for a valid intent", async () => {
    const doc = makeDoc([makeFile("a", "src/a.ts"), makeFile("b", "src/b.ts")])
    const controller = new ReviewWorkspaceController({ runner: fakeRunner(), loadDocument: async () => doc })
    await controller.open("refs/heads/main")

    expect(controller.dispatchIntent({ type: "selection/select-file", fileKey: "b" })).toBe(true)
    expect(controller.state?.selection.fileKey).toBe("b")
    await controller.destroy()
  })

  test("returns false before a review is open", async () => {
    const controller = new ReviewWorkspaceController({ runner: fakeRunner(), loadDocument: async () => makeDoc([makeFile("a", "src/a.ts")]) })
    expect(controller.dispatchIntent({ type: "feedback/cancel-draft" })).toBe(false)
    await controller.destroy()
  })
})
