// PROTOTYPE smoke: drive the whole loop against a real git repo.
import { createTempRepository } from "../../tests/helpers/temp-repository"
import { GitRunner } from "../../src/git/runner"
import { ReviewWorkspaceController } from "../../src/ui/review-workspace/controller"
import { createRangeAnchor } from "../../src/review/core/anchors"
import { ledgerVerdict, ledgerHeaderText, HANDOFF_MARKDOWN_PATH, reviewCheckpoint } from "../../src/review/core/ledger"
import { ReviewStateStore } from "../../src/review/storage/review-state-store"
import { readFile } from "node:fs/promises"
import { join, resolve } from "node:path"

const cliEntry = resolve(import.meta.dir, "../../src/cli.ts")

const repo = await createTempRepository()
const g = repo.git
await g(["config", "user.email", "t@t"]); await g(["config", "user.name", "t"])
await repo.write("app.ts", ["one", "two", "three", "four", "five", "six"].join("\n") + "\n")
await g(["add", "."]); await g(["commit", "-qm", "base"])
await g(["checkout", "-qb", "feature"])
await repo.write("app.ts", ["one", "AGENT-A", "three", "AGENT-B", "five", "six"].join("\n") + "\n")
await g(["commit", "-qam", "agent writes"])

const runner = new GitRunner({ cwd: repo.path })
const controller = new ReviewWorkspaceController({ runner, stateStore: new ReviewStateStore(runner) })
await controller.open("refs/heads/master")
const file = controller.state!.document.files[0]!
console.log("file:", file.path, "hunks:", file.hunks.length)

// Two objections: line 2 (agent will fix) and line 4 (agent will ignore).
let n = 0
for (const [line, body] of [[2, "rename AGENT-A, it shadows the import"], [4, "AGENT-B does an extra O(n) pass"]] as const) {
  const anchor = createRangeAnchor(file, { side: "new", startLine: line, endLine: line })
  const started = controller.dispatchIntent({ type: "feedback/start-draft", anchor, kind: "note", severity: "blocking", body })
  const created = controller.dispatchIntent({ type: "feedback/create", id: `fb-${++n}`, createdAt: new Date().toISOString() })
  console.log("  create feedback", n, { started, created })
}
console.log("before handoff  :", ledgerHeaderText(controller.state!.feedback, controller.state!.document.generation.headOid))

const handoff = await controller.handoffFeedback()
console.log("handoff         :", handoff)
console.log("after handoff   :", ledgerHeaderText(controller.state!.feedback, controller.state!.document.generation.headOid))
const mdPath = (await runner.run(["rev-parse", "--git-path", HANDOFF_MARKDOWN_PATH])).stdout.trim()
console.log("--- pending.md ---")
console.log(await readFile(join(repo.path, mdPath), "utf8"))

// The agent acts: it fixes line 2 and silently leaves line 4 alone.
await repo.write("app.ts", ["one", "renamed", "three", "AGENT-B", "five", "six"].join("\n") + "\n")
await g(["commit", "-qam", "agent: address feedback (claims all done)"])
// Quit githunk entirely, then relaunch — the ledger must survive the process.
await controller.flushDrafts()
await controller.destroy()
const relaunched = new ReviewWorkspaceController({ runner: new GitRunner({ cwd: repo.path }), stateStore: new ReviewStateStore(new GitRunner({ cwd: repo.path })) })
await relaunched.open("refs/heads/master")
const head = relaunched.state!.document.generation.headOid

console.log("--- after quitting githunk, committing, and relaunching ---")
for (const fb of relaunched.state!.feedback) {
  const a = fb.anchor.kind === "range" ? `new:${fb.anchor.startLine}` : "file"
  console.log(`  ${ledgerVerdict(fb, head).padEnd(10)} ${a}  ${fb.body}`)
}
console.log("header          :", ledgerHeaderText(relaunched.state!.feedback, head))

// "What did the agent actually change?" — the lens opens from the handoff even
// though no review has ever been finished here.
console.log("checkpoint      :", reviewCheckpoint(relaunched.state!))
const lens = await relaunched.enterSinceLastReview()
console.log("enter lens      :", lens)
console.log("lens files      :", relaunched.state!.document.files.map((f) => `${f.path} +${f.stats.additions}/-${f.stats.deletions}`))
relaunched.exitProjection()

// Retire the one the agent argued its way out of.
const untouched = relaunched.state!.feedback.find((f) => ledgerVerdict(f, head) === "untouched")
if (untouched) {
  console.log("retire          :", relaunched.retireFeedback(untouched.id))
  console.log("header          :", ledgerHeaderText(relaunched.state!.feedback, head))
}

// git status must stay clean: state lives under the git dir, never the worktree.
const status = await g(["status", "--porcelain"])
console.log("git status      :", status.stdout.trim() === "" ? "clean" : `DIRTY -> ${status.stdout.trim()}`)

// The agent's read-only way in.
const cli = Bun.spawnSync(["bun", "run", cliEntry, "handoff"], { cwd: repo.path })
console.log("--- githunk handoff (cwd = repo) ---")
console.log(new TextDecoder().decode(cli.stdout).split("\n").slice(0, 6).join("\n"))
const cliJson = Bun.spawnSync(["bun", "run", cliEntry, "handoff", "--json"], { cwd: repo.path })
const parsed = JSON.parse(new TextDecoder().decode(cliJson.stdout))
console.log("handoff --json  :", { version: parsed.version, items: parsed.items.length, first: parsed.items[0]?.id })

await repo.cleanup()
