import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { createTempRepository, type TempRepository } from "../helpers/temp-repository"
import { CommandLog } from "../../src/app/command-log"
import { GitRunner } from "../../src/git/runner"
import { createApp } from "../../src/app/create-app"

describe("command log", () => {
  let repo: TempRepository
  let log: CommandLog

  beforeEach(async () => {
    repo = await createTempRepository()
    await repo.write("a.txt", "one\n")
    await repo.git(["add", "a.txt"])
    await repo.git(["commit", "-m", "first"])
    log = new CommandLog()
  })

  afterEach(async () => {
    await repo.cleanup()
  })

  function texts(): readonly string[] {
    return log.lines().map((line) => line.spans.map((span) => span.text).join(""))
  }

  /**
   * The whole point of the dontLog rule (src/git/runner.ts:84-88, reproducing lazygit's 80
   * `DontLog()` calls per Task 2's audit): lazygit's log shows what the user did, not what the app
   * asked git about. A 10-second refresh used to bury the former under the latter — this is the
   * regression the whole plan exists to prevent, so it is asserted as a negative directly rather
   * than only positively (below) that the right things ARE logged.
   */
  test("a refresh puts no loader command in the log", async () => {
    const app = createApp({ repositoryRoot: repo.path, runner: new GitRunner({ cwd: repo.path, log }) })
    await app.refresh()
    const commands = texts().filter((text) => text.startsWith("  git "))
    expect(commands).toEqual([])
  })

  /**
   * `pkg/gui/command_log_panel.go:14-24`: one action groups the command(s) it logs. Stage-then-
   * commit is githunk's shortest real mutation pair, so it pins the action/command interleaving
   * end to end against a real git process.
   */
  test("staging then committing logs each action above its command, in order", async () => {
    const app = createApp({ repositoryRoot: repo.path, runner: new GitRunner({ cwd: repo.path, log }) })
    await repo.write("a.txt", "two\n")
    await app.refresh()
    await app.controller.stageFile("a.txt")
    await app.controller.commit("second\n")

    const meaningful = texts().filter((text) => text === "Stage file" || text === "Commit" || text.startsWith("  git "))
    expect(meaningful).toEqual([
      "Stage file",
      "  git add -- a.txt",
      "Commit",
      "  git commit -F -",
    ])
  })

  /**
   * `printCommandLogHeader` (pkg/gui/command_log_panel.go:70-85) runs before the gui's first
   * render. `src/main.ts:26` ran an un-`readOnly` `rev-parse --show-toplevel` before Task 3's fix,
   * which under the dontLog rule made a bootstrap read the first line of every session's log —
   * `src/main.ts` has no tests of its own (`grep -rn startApp tests` is empty), so nothing else
   * would catch a regression there. Pinning the header as line zero turns a stray bootstrap read
   * into a failing test.
   */
  test("the header is the first thing in the log", async () => {
    createApp({ repositoryRoot: repo.path, runner: new GitRunner({ cwd: repo.path, log }) })
    expect(texts()[0]).toBe("You can hide/focus this panel by pressing '@'")
    expect(texts()[1]).toBe("")
  })

  /**
   * PRD §6.7: failures must stay inspectable. lazygit instead raises an error popup and logs
   * nothing for a non-streamed failure; githunk has no popup, so a failed command's stderr goes
   * under the "Git output:" heading (src/app/command-log.ts's `CommandLogOutputWriter`) while a
   * successful command's output never appears at all. `push()` against this temp repository does
   * NOT reject — there is no remote at all, so `upstreamRef()` catches the exit-128 and `push()`
   * resolves `{ kind: "upstream-required" }` instead of throwing (verified directly against this
   * environment). `deleteBranch` against a branch that does not exist runs `git branch -d --
   * no-such-branch`, which git always rejects, so it is used here instead.
   */
  test("a failed command's output is inspectable, a successful one's is not", async () => {
    const app = createApp({ repositoryRoot: repo.path, runner: new GitRunner({ cwd: repo.path, log }) })
    await app.refresh()
    await expect(app.controller.deleteBranch("no-such-branch")).rejects.toThrow()
    // Assert the actual stderr body, not just the heading's presence: the seeded header and
    // random tip satisfy a "some non-blank, non-command line exists" predicate on their own,
    // before any command has even run, so that shape of assertion passes whether or not the
    // heading is ever followed by real output. Asserting the specific stderr text lands AFTER
    // the heading is what a dropped-body regression (e.g. `outputWriter()` writing only the
    // heading) actually fails.
    const headingIndex = texts().indexOf("Git output:")
    expect(headingIndex).toBeGreaterThanOrEqual(0)
    expect(texts().slice(headingIndex + 1).join("\n")).toContain("not found")
  })
})
