import { describe, expect, test } from "bun:test"
import { CommandLog } from "../../src/app/command-log"
import type { CommandLogLine } from "../../src/domain/command"

function texts(lines: readonly CommandLogLine[]): readonly string[] {
  return lines.map((line) => line.spans.map((span) => span.text).join(""))
}

function styles(lines: readonly CommandLogLine[]): readonly string[] {
  return lines.map((line) => line.spans.map((span) => span.style).join("+"))
}

describe("CommandLog", () => {
  test("starts empty", () => {
    expect(new CommandLog().lines()).toEqual([])
  })

  /** lazygit `LogAction` (pkg/gui/command_log_panel.go:25-44): yellow, not indented. */
  test("logAction adds one unindented yellow-role line", () => {
    const log = new CommandLog()
    log.logAction("Stage file")
    expect(texts(log.lines())).toEqual(["Stage file"])
    expect(styles(log.lines())).toEqual(["action"])
  })

  /**
   * lazygit `LogCommand` (pkg/gui/command_log_panel.go:46-68): two-space indent, and every embedded
   * newline is indented too via `strings.ReplaceAll(cmdStr, "\n", "\n  ")`.
   */
  test("logCommand indents by two spaces, including embedded newlines", () => {
    const log = new CommandLog()
    log.logCommand("git add -- a.ts", true)
    log.logCommand("pick abc\npick def", false)
    expect(texts(log.lines())).toEqual(["  git add -- a.ts", "  pick abc", "  pick def"])
  })

  test("logCommand picks the command role when it is shell-runnable and internal when it is not", () => {
    const log = new CommandLog()
    log.logCommand("git push", true)
    log.logCommand("Restoring file to previous state", false)
    expect(styles(log.lines())).toEqual(["command", "internal"])
  })

  /**
   * lazygit's `prefixWriter` writes `style.FgMagenta.Sprintf("\n\n%s\n", Tr.GitOutput)` before the
   * first write for a command and never again (pkg/gui/extras_panel.go:97,100-119).
   */
  test("outputWriter writes a blank line and the heading once per command", () => {
    const log = new CommandLog()
    log.logCommand("git push", true)
    const writer = log.outputWriter()
    writer.write("Enumerating objects: 3\n")
    writer.write("To github.com:o/r.git\n")
    expect(texts(log.lines())).toEqual([
      "  git push",
      "",
      "Git output:",
      "Enumerating objects: 3",
      "To github.com:o/r.git",
    ])
    expect(styles(log.lines())).toEqual(["command", "", "output-heading", "output", "output"])
  })

  /**
   * `getCmdWriter()` hands out a fresh `prefixWriter` per command (extras_panel.go:96-97), so
   * `prefixWritten` is per-command state — two commands writing output each get their own heading.
   * A flag on the log only behaves the same while commands never interleave.
   */
  test("two interleaved commands each get their own heading", () => {
    const log = new CommandLog()
    log.logCommand("git push", true)
    const push = log.outputWriter()
    log.logCommand("git pull", true)
    const pull = log.outputWriter()
    push.write("from push\n")
    pull.write("from pull\n")
    expect(texts(log.lines()).filter((text) => text === "Git output:")).toHaveLength(2)
  })

  test("outputWriter ignores empty output and trims only trailing blank lines", () => {
    const log = new CommandLog()
    log.logCommand("git push", true)
    const writer = log.outputWriter()
    writer.write("")
    expect(texts(log.lines())).toEqual(["  git push"])
    writer.write("a\n\nb\n\n\n")
    expect(texts(log.lines())).toEqual(["  git push", "", "Git output:", "a", "", "b"])
  })

  /** lazygit `printCommandLogHeader` (pkg/gui/command_log_panel.go:70-85). */
  test("logIntro adds the cyan line and the blank line after it", () => {
    const log = new CommandLog()
    log.logIntro("You can hide/focus this panel by pressing '@'")
    expect(texts(log.lines())).toEqual(["You can hide/focus this panel by pressing '@'", ""])
    expect(styles(log.lines())).toEqual(["intro", ""])
  })

  test("logTip puts the label and the tip in one line as two spans", () => {
    const log = new CommandLog()
    log.logTip("Random tip", "Press '@' to hide this")
    expect(log.lines()).toHaveLength(1)
    expect(log.lines()[0]?.spans).toEqual([
      { style: "tip-label", text: "Random tip: " },
      { style: "tip", text: "Press '@' to hide this" },
    ])
  })

  test("logTip keeps a multi-line tip's later lines in the tip role", () => {
    const log = new CommandLog()
    log.logTip("Random tip", "first\nsecond")
    expect(texts(log.lines())).toEqual(["Random tip: first", "second"])
    expect(styles(log.lines())).toEqual(["tip-label+tip", "tip"])
  })

  test("gives every line a distinct id so the pane can detect an append", () => {
    const log = new CommandLog()
    log.logAction("Commit")
    log.logCommand("git commit -F -", true)
    const ids = log.lines().map((line) => line.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  test("lines() hands back the live list, so callers must not mutate it", () => {
    const log = new CommandLog()
    const first = log.lines()
    log.logAction("Push")
    expect(first).toBe(log.lines())
    expect(log.lines()).toHaveLength(1)
  })

  /**
   * `lastWriteKind()` feeds `AppModel.commandLogWriteKind`, which `RootView` uses to pick the
   * autoscroll transition (src/ui/panes/command-log-scroll.ts) a new write implies — lazygit
   * assigns `Autoscroll = true` only in `LogAction`/`LogCommand`
   * (pkg/gui/command_log_panel.go:38,62), never in the `prefixWriter` or the header.
   */
  describe("lastWriteKind", () => {
    test("starts as append-header, because the first write is the startup header", () => {
      expect(new CommandLog().lastWriteKind()).toBe("append-header")
    })

    test("logAction and logCommand report append-entry", () => {
      const log = new CommandLog()
      log.logIntro("intro")
      log.logAction("Stage file")
      expect(log.lastWriteKind()).toBe("append-entry")
      log.logCommand("git add -- a.ts", true)
      expect(log.lastWriteKind()).toBe("append-entry")
    })

    test("outputWriter().write reports append-output", () => {
      const log = new CommandLog()
      log.logCommand("git push", true)
      expect(log.lastWriteKind()).toBe("append-entry")
      log.outputWriter().write("Enumerating objects: 3\n")
      expect(log.lastWriteKind()).toBe("append-output")
    })

    test("logIntro and logTip report append-header", () => {
      const log = new CommandLog()
      log.logAction("Stage file")
      log.logIntro("You can hide/focus this panel by pressing '@'")
      expect(log.lastWriteKind()).toBe("append-header")
      log.logAction("Stage file")
      log.logTip("Random tip", "Press '@' to hide this")
      expect(log.lastWriteKind()).toBe("append-header")
    })

    test("an empty write is a no-op, so it leaves the prior kind alone", () => {
      const log = new CommandLog()
      log.logCommand("git push", true)
      expect(log.lastWriteKind()).toBe("append-entry")
      log.outputWriter().write("")
      expect(log.lastWriteKind()).toBe("append-entry")
    })
  })
})
