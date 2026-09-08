import { describe, expect, test } from "bun:test"
import { createTempRepository } from "../helpers/temp-repository"
import { GitRunner } from "../../src/git/runner"
import { ReviewWorkspaceController } from "../../src/ui/review-workspace/controller"
import { ReviewStateStore } from "../../src/review/storage/review-state-store"
import { createRangeAnchor } from "../../src/review/core/anchors"
import { HANDOFF_JSON_PATH, ledgerVerdict, reviewCheckpoint } from "../../src/review/core/ledger"
import { validateFinishReview } from "../../src/review/core/artifact"
import type { ReviewState } from "../../src/review/core/state"

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

      // A blocking objection nobody touched blocks Approve until a human closes it.
      const approve = { decision: "approve" as const, summary: "looks good" }
      const state = reopened.state!
      expect(validateFinishReview(state, approve)).toMatchObject({ ok: false, reason: "feedback-needs-reanchor" })
      const retired: ReviewState = { ...state, feedback: state.feedback.map((f) => ({ ...f, status: "retired" as const })) }
      expect(validateFinishReview(retired, approve)).toEqual({ ok: true })

      await reopened.destroy()
    } finally {
      await repo.cleanup()
    }
  })
})
