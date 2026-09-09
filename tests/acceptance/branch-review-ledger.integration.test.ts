import { describe, expect, test } from "bun:test"
import { createTempRepository } from "../helpers/temp-repository"
import { GitRunner } from "../../src/git/runner"
import { runHandoff, runHandoffReply } from "../../src/cli/handoff"
import { ReviewWorkspaceController } from "../../src/ui/review-workspace/controller"
import { ReviewStateStore, emptyReviewDatabaseV2 } from "../../src/review/storage/review-state-store"
import { createRangeAnchor } from "../../src/review/core/anchors"
import { createReviewHunk } from "../../src/review/core/document"
import { HANDOFF_JSON_PATH, HANDOFF_REPLIES_PATH, ledgerVerdict, reviewCheckpoint, serializeReviewReplies } from "../../src/review/core/ledger"
import { validateFinishReview } from "../../src/review/core/artifact"
import { LocalStateFile } from "../../src/storage/local-state-file"
import type { ReviewState } from "../../src/review/core/state"
import { buildHunkStackRows } from "../../src/ui/review-workspace/hunk-diff-row-model"
import { toHunkReviewFile } from "../../src/ui/review-workspace/hunk-review-model"

/**
 * The open-objections loop against a real repository: leave objections, hand
 * them off, let an agent act on one of them, and check that githunk — not the
 * agent's own report — decides which was addressed.
 */
describe("branch review — open-objections ledger", () => {
  test("an objection the agent never touched comes back UNTOUCHED and survives a restart", async () => {
    const repo = await createTempRepository()
    try {
      await repo.git(["config", "user.email", "t@t"])
      await repo.git(["config", "user.name", "t"])
      await repo.write("app.ts", ["one", "two", "three", "four", "five", "six"].join("\n") + "\n")
      await repo.git(["add", "."])
      await repo.git(["commit", "-qm", "base"])
      await repo.git(["checkout", "-qb", "feature"])
      await repo.write("app.ts", ["one", "AGENT-A", "three", "AGENT-B", "five", "six"].join("\n") + "\n")
      await repo.git(["commit", "-qam", "agent writes"])

      const controller = new ReviewWorkspaceController({
        runner: new GitRunner({ cwd: repo.path }),
        stateStore: new ReviewStateStore(new GitRunner({ cwd: repo.path })),
      })
      await controller.open("refs/heads/master")
      const file = controller.state!.document.files[0]!

      // Two objections: line 2 the agent will act on, line 4 it will ignore.
      const objections = [
        { line: 2, body: "rename AGENT-A, it shadows the import" },
        { line: 4, body: "AGENT-B does an extra O(n) pass" },
      ] as const
      objections.forEach(({ line, body }, index) => {
        const anchor = createRangeAnchor(file, { side: "new", startLine: line, endLine: line })
        controller.dispatchIntent({ type: "feedback/start-draft", anchor, kind: "note", severity: "blocking", body })
        controller.dispatchIntent({ type: "feedback/create", id: `fb-${index}`, createdAt: new Date().toISOString() })
      })
      expect(controller.state!.feedback.map((f) => ledgerVerdict(f))).toEqual(["open", "open"])

      const handoff = await controller.handoffFeedback()
      expect(handoff).toMatchObject({ ok: true, handedOff: 2, total: 2 })

      // Before HEAD moves the verdict must stay "waiting": nobody has had the
      // chance to commit, so an active anchor accuses no one.
      const atHandoff = controller.state!.document.generation.headOid
      expect(controller.state!.feedback.map((f) => ledgerVerdict(f, atHandoff))).toEqual(["waiting", "waiting"])

      // The mailbox is durable, machine-readable, and outside the worktree.
      const mailboxPath = (await new GitRunner({ cwd: repo.path }).run(["rev-parse", "--git-path", HANDOFF_JSON_PATH])).stdout.trim()
      const mailbox = JSON.parse(await Bun.file(`${repo.path}/${mailboxPath}`).text())
      expect(mailbox.items.map((i: { path: string; startLine: number }) => `${i.path}:${i.startLine}`)).toEqual(["app.ts:2", "app.ts:4"])
      expect((await repo.git(["status", "--porcelain"])).stdout.trim()).toBe("")

      // githunk is closed entirely, the agent acts on one objection, and the
      // ledger has to still be there when the reviewer comes back.
      await controller.flushDrafts()
      await controller.destroy()
      await repo.write("app.ts", ["one", "renamed", "three", "AGENT-B", "five", "six"].join("\n") + "\n")
      await repo.git(["commit", "-qam", "agent: address feedback (claims all done)"])

      const reopened = new ReviewWorkspaceController({
        runner: new GitRunner({ cwd: repo.path }),
        stateStore: new ReviewStateStore(new GitRunner({ cwd: repo.path })),
      })
      await reopened.open("refs/heads/master")
      const head = reopened.state!.document.generation.headOid
      const verdicts = Object.fromEntries(
        reopened.state!.feedback.map((f) => [f.anchor.kind === "range" ? f.anchor.startLine : 0, ledgerVerdict(f, head)]),
      )
      expect(verdicts).toEqual({ 2: "addressed", 4: "untouched" })

      // "What did the agent change?" answered from the handoff, with no review
      // ever finished here.
      expect(reviewCheckpoint(reopened.state!)?.kind).toBe("handoff")
      const lens = await reopened.enterSinceLastReview()
      expect(lens).toMatchObject({ ok: true, fileCount: 1 })
      reopened.exitProjection()

      // GitLab keeps the diff a note was written against next to the note, so an
      // outdated discussion can still show what was objected to after the code
      // is gone (note_diff_files.diff, db/structure.sql:25690-25700). The same
      // evidence has to reach the row model here.
      const addressed = reopened.state!.feedback.find((f) => ledgerVerdict(f, head) === "addressed")!
      expect(addressed.handoff?.excerpt).toEqual(["AGENT-A"])
      const rows = buildHunkStackRows(
        toHunkReviewFile(reopened.state!.document.files[0]!),
        reopened.state!,
        undefined,
        { width: 120, showLineNumbers: true, wrapLines: false },
      )
      // The objection sits under the line it was written against, not at the
      // end of the file: GitLab renders a discussion in the notes holder that
      // follows its own diff row (diffs/components/diff_view.vue:224-250).
      const rowIndex = rows.findIndex((r) => r.type === "feedback" && r.feedbackId === addressed.id)
      const lineAbove = rows[rowIndex - 1]
      expect(lineAbove?.type).toBe("stack-line")
      expect((lineAbove as { cell: { newLineNumber?: number } }).cell.newLineNumber).toBe(2)

      const excerpt = rows.filter((r) => r.type === "feedback-excerpt" && r.feedbackId === addressed.id)
      expect(excerpt.map((r) => (r as { side: string; text: string }).side)).toEqual(["was", "now"])
      expect((excerpt[0] as { text: string }).text).toContain("AGENT-A")
      expect((excerpt[1] as { text: string }).text).toContain("renamed")

      // The objection nobody touched has nothing to compare, so it stays quiet.
      const untouched = reopened.state!.feedback.find((f) => ledgerVerdict(f, head) === "untouched")!
      expect(rows.filter((r) => r.type === "feedback-excerpt" && r.feedbackId === untouched.id)).toEqual([])

      // The agent answers the objection it did not act on. Its words land beside
      // the objection; they do not settle it — an answered objection whose lines
      // are unchanged reads DISPUTED, which is a question for the reviewer.
      const disputedItem = reopened.state!.feedback.find((f) => ledgerVerdict(f, head) === "untouched")!
      const repliesFile = (await new GitRunner({ cwd: repo.path }).run(["rev-parse", "--git-path", HANDOFF_REPLIES_PATH])).stdout.trim()
      await Bun.write(
        `${repo.path}/${repliesFile}`,
        serializeReviewReplies([{ id: disputedItem.id, body: "the sort is needed for the range query", at: new Date().toISOString() }]),
      )

      const withReplies = new ReviewWorkspaceController({
        runner: new GitRunner({ cwd: repo.path }),
        stateStore: new ReviewStateStore(new GitRunner({ cwd: repo.path })),
      })
      await withReplies.open("refs/heads/master")
      const replies = withReplies.replies
      expect(replies.get(disputedItem.id)?.body).toContain("range query")
      expect(ledgerVerdict(disputedItem, head, { replied: true })).toBe("disputed")
      // The reply cannot move the verdict of an objection whose code did change.
      const addressedItem = reopened.state!.feedback.find((f) => ledgerVerdict(f, head) === "addressed")!
      expect(ledgerVerdict(addressedItem, head, { replied: true })).toBe("addressed")

      const replyRows = buildHunkStackRows(
        toHunkReviewFile(withReplies.state!.document.files[0]!),
        withReplies.state!,
        undefined,
        { width: 120, showLineNumbers: true, wrapLines: false, replies },
      ).filter((r) => r.type === "feedback-reply")
      expect(replyRows.length).toBe(1)
      expect((replyRows[0] as { text: string }).text).toContain("range query")
      await withReplies.destroy()

      // A blocking objection nobody touched blocks Approve until a human closes it.
      const approve = { decision: "approve" as const, summary: "looks good" }
      const state = reopened.state!
      expect(validateFinishReview(state, approve)).toMatchObject({ ok: false, reason: "feedback-needs-reanchor" })
      const resolved: ReviewState = { ...state, feedback: state.feedback.map((f) => ({ ...f, status: "resolved" as const })) }
      expect(validateFinishReview(resolved, approve)).toEqual({ ok: true })

      await reopened.destroy()
    } finally {
      await repo.cleanup()
    }
  })
  test("does not hand off stale feedback or count it as new work", async () => {
    const repo = await createTempRepository()
    try {
      await repo.write("app.ts", "one\n")
      await repo.git(["add", "."])
      await repo.git(["commit", "-qm", "base"])
      await repo.git(["checkout", "-qb", "feature"])
      await repo.write("app.ts", "changed\n")
      await repo.git(["commit", "-qam", "change"])

      const runner = new GitRunner({ cwd: repo.path })
      const controller = new ReviewWorkspaceController({ runner })
      await controller.open("refs/heads/master")
      const file = controller.state!.document.files[0]!
      const anchor = createRangeAnchor(file, { side: "new", startLine: 1, endLine: 1 })
      for (const id of ["active", "stale"] as const) {
        controller.dispatchIntent({
          type: "feedback/start-draft",
          anchor,
          kind: "note",
          severity: "comment",
          body: id,
        })
        controller.dispatchIntent({ type: "feedback/create", id, createdAt: "2026-09-08T01:00:00.000Z" })
      }
      const current = controller.state!
      ;(controller as unknown as { _state: ReviewState })._state = {
        ...current,
        feedback: current.feedback.map((feedback) => feedback.id === "stale" ? { ...feedback, resolution: "stale" as const } : feedback),
      }

      const outcome = await controller.handoffFeedback()
      expect(outcome).toMatchObject({ ok: true, handedOff: 1, total: 1 })
      const mailboxPath = (await runner.run(["rev-parse", "--git-path", HANDOFF_JSON_PATH])).stdout.trim()
      const mailbox = JSON.parse(await Bun.file(`${repo.path}/${mailboxPath}`).text()) as { items: { id: string }[] }
      expect(mailbox.items.map((item) => item.id)).toEqual(["active"])
      expect(controller.state!.feedback.map((feedback) => feedback.status)).toEqual(["handed-off", undefined])
      await controller.destroy()
    } finally {
      await repo.cleanup()
    }
  })
  test("refreshing an unchanged generation reloads agent replies", async () => {
    const repo = await createTempRepository()
    try {
      await repo.git(["config", "user.email", "t@t"])
      await repo.git(["config", "user.name", "t"])
      await repo.write("app.ts", "one\n")
      await repo.git(["add", "."])
      await repo.git(["commit", "-qm", "base"])
      await repo.git(["checkout", "-qb", "feature"])
      await repo.write("app.ts", "two\n")
      await repo.git(["commit", "-qam", "change"])

      const runner = new GitRunner({ cwd: repo.path })
      const controller = new ReviewWorkspaceController({
        runner,
        stateStore: new ReviewStateStore(new GitRunner({ cwd: repo.path })),
      })
      await controller.open("refs/heads/master")
      expect(controller.replies.size).toBe(0)

      const repliesFile = new LocalStateFile({ runner, relativePath: HANDOFF_REPLIES_PATH, pathKind: "handoff" })
      await repliesFile.writeText(serializeReviewReplies([{
        id: "fb-1",
        body: "the change is intentional",
        at: "2026-09-08T02:00:00.000Z",
      }]))

      await controller.refreshGeneration()

      expect(controller.replies.get("fb-1")?.body).toBe("the change is intentional")
      await controller.destroy()
    } finally {
      await repo.cleanup()
    }
  })
  test("rejects blank and unknown handoff replies", async () => {
    const repo = await createTempRepository()
    try {
      const blank = await runHandoffReply({ id: "fb-1", body: "   ", cwd: repo.path })
      expect(blank.exitCode).not.toBe(0)
      const unknown = await runHandoffReply({ id: "missing", body: "reason", cwd: repo.path })
      expect(unknown.exitCode).not.toBe(0)
    } finally {
      await repo.cleanup()
    }
  })
  test("does not overwrite a malformed replies file", async () => {
    const repo = await createTempRepository()
    try {
      const runner = new GitRunner({ cwd: repo.path })
      const mailboxFile = new LocalStateFile({ runner, relativePath: HANDOFF_JSON_PATH, pathKind: "handoff" })
      const repliesFile = new LocalStateFile({ runner, relativePath: HANDOFF_REPLIES_PATH, pathKind: "handoff" })
      const malformed = "{\"version\":1,\"replies\":["
      await mailboxFile.writeText(JSON.stringify({ version: 1, items: [{ id: "fb-1" }] }))
      await repliesFile.writeText(malformed)
      const outcome = await runHandoffReply({ id: "fb-1", body: "reason", cwd: repo.path })
      expect(outcome.exitCode).not.toBe(0)
      expect(await repliesFile.readText()).toBe(malformed)
    } finally {
      await repo.cleanup()
    }
  })
  test("names the actual handoff key when no mailbox exists", async () => {
    const repo = await createTempRepository()
    try {
      const outcome = await runHandoff({ json: false, cwd: repo.path })
      expect(outcome.exitCode).not.toBe(0)
      expect(outcome.text).toContain("press A")
      expect(outcome.text).not.toContain("press H")
    } finally {
      await repo.cleanup()
    }
  })
  test("does not report handoff success when checkpoint persistence fails", async () => {
    const repo = await createTempRepository()
    try {
      await repo.write("app.ts", "one\n")
      await repo.git(["add", "."])
      await repo.git(["commit", "-qm", "base"])
      await repo.git(["checkout", "-qb", "feature"])
      await repo.write("app.ts", "two\n")
      await repo.git(["commit", "-qam", "change"])

      let database = emptyReviewDatabaseV2()
      const stateStore = {
        load: async () => database,
        saveSemanticChange: async (updater: (value: typeof database) => typeof database) => {
          const next = updater(database)
          const includesHandoff = Object.values(next.reviews).some((review) =>
            review.feedback.some((feedback) => feedback.status === "handed-off"))
          if (includesHandoff) throw new Error("checkpoint persistence failed")
          database = next
        },
        quarantineWarning: undefined,
        saveDraftDebounced: () => {},
        flush: async () => {},
      } as unknown as ReviewStateStore
      const runner = new GitRunner({ cwd: repo.path })
      const controller = new ReviewWorkspaceController({ runner, stateStore })
      await controller.open("refs/heads/master")
      const file = controller.state!.document.files[0]!
      const anchor = createRangeAnchor(file, { side: "new", startLine: 1, endLine: 1 })
      controller.dispatchIntent({ type: "feedback/start-draft", anchor, kind: "note", severity: "comment", body: "change this" })
      controller.dispatchIntent({ type: "feedback/create", id: "fb-1", createdAt: "2026-09-08T01:00:00.000Z" })
      await controller.flushDrafts()

      const outcome = await controller.handoffFeedback()
      expect(outcome.ok).toBe(false)
      expect(controller.state!.feedback[0]!.status).not.toBe("handed-off")
      const mailbox = new LocalStateFile({ runner, relativePath: HANDOFF_JSON_PATH, pathKind: "handoff" })
      expect(await mailbox.readText()).toBeUndefined()
      await controller.destroy()
    } finally {
      await repo.cleanup()
    }
  })
  test("rejects handoff when feedback changes during mailbox writes", async () => {
    const repo = await createTempRepository()
    try {
      await repo.write("app.ts", "one\n")
      await repo.git(["add", "."])
      await repo.git(["commit", "-qm", "base"])
      await repo.git(["checkout", "-qb", "feature"])
      await repo.write("app.ts", "two\n")
      await repo.git(["commit", "-qam", "change"])

      const runner = new GitRunner({ cwd: repo.path })
      const controller = new ReviewWorkspaceController({ runner })
      await controller.open("refs/heads/master")
      const file = controller.state!.document.files[0]!
      const anchor = createRangeAnchor(file, { side: "new", startLine: 1, endLine: 1 })
      controller.dispatchIntent({ type: "feedback/start-draft", anchor, kind: "note", severity: "comment", body: "original" })
      controller.dispatchIntent({ type: "feedback/create", id: "fb-1", createdAt: "2026-09-08T01:00:00.000Z" })

      const handoff = controller.handoffFeedback()
      await Promise.resolve()
      controller.dispatchIntent({ type: "feedback/edit", id: "fb-1", body: "edited", updatedAt: "2026-09-08T02:00:00.000Z" })
      const outcome = await handoff

      expect(outcome.ok).toBe(false)
      expect(controller.state!.feedback[0]!.body).toBe("edited")
      expect(controller.state!.feedback[0]!.status).not.toBe("handed-off")
      await controller.destroy()
    } finally {
      await repo.cleanup()
    }
  })
  test("builds a projected handoff from the aggregate document", async () => {
    const repo = await createTempRepository()
    try {
      await repo.write("app.ts", "one\n")
      await repo.git(["add", "."])
      await repo.git(["commit", "-qm", "base"])
      await repo.git(["checkout", "-qb", "feature"])
      await repo.write("app.ts", "two\n")
      await repo.git(["commit", "-qam", "change"])

      const runner = new GitRunner({ cwd: repo.path })
      const controller = new ReviewWorkspaceController({
        runner,
        loadSinceLastReview: async (aggregate, fromHeadOid) => ({
          kind: "ok" as const,
          document: {
            reviewId: aggregate.identity.id,
            generationId: aggregate.generation.id,
            projection: { kind: "since-last-review" as const, fromHeadOid },
            files: [{
              ...aggregate.files[0]!,
              path: "lens/app.ts",
              contentId: "projection-content",
              hunks: [createReviewHunk({
                index: 0,
                oldStart: 1,
                oldCount: 1,
                newStart: 1,
                newCount: 1,
                lines: ["-one", "+lens"],
              })],
            }],
          },
        }),
      })
      await controller.open("refs/heads/master")
      const file = controller.state!.document.files[0]!
      const anchor = createRangeAnchor(file, { side: "new", startLine: 1, endLine: 1 })
      controller.dispatchIntent({ type: "feedback/start-draft", anchor, kind: "note", severity: "comment", body: "change this" })
      controller.dispatchIntent({ type: "feedback/create", id: "fb-1", createdAt: "2026-09-08T01:00:00.000Z" })
      const state = controller.state!
      const controllerInternals = controller as unknown as { _state: ReviewState }
      controllerInternals._state = {
        ...state,
        lastSubmission: {
          artifactId: "artifact-1",
          generationId: state.document.generation.id,
          headOid: "b".repeat(40),
          submittedAt: "2026-09-08T00:00:00.000Z",
        },
      }

      expect(await controller.enterSinceLastReview()).toMatchObject({ ok: true })
      expect(controller.state!.projection.kind).toBe("since-last-review")
      const outcome = await controller.handoffFeedback()

      expect(outcome.ok).toBe(true)
      const mailbox: unknown = JSON.parse(await new LocalStateFile({
        runner,
        relativePath: HANDOFF_JSON_PATH,
        pathKind: "handoff",
      }).readText() ?? "{}")
      expect(mailbox).toMatchObject({
        items: [{ id: "fb-1", path: "app.ts", side: "new", startLine: 1, endLine: 1, severity: "comment", kind: "note", body: "change this" }],
      })
      expect(controller.state!.feedback[0]!.handoff?.excerpt).toEqual(["two"])
      await controller.destroy()

    } finally {
      await repo.cleanup()
    }
  })
})
