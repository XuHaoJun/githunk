import { describe, expect, test } from "bun:test"
import { tailCommandLogLines } from "../../src/ui/panes/command-log-pane"
import type { CommandRecord } from "../../src/domain/command"

function record(id: number, stderr = ""): CommandRecord {
  return {
    id,
    cwd: "/tmp/repo",
    args: ["git", `step-${id}`],
    startedAt: `t${id}`,
    durationMs: id,
    exitCode: stderr.length === 0 ? 0 : 1,
    stdout: "",
    stderr,
  }
}

describe("command log viewport", () => {
  test("keeps newest command and failure output visible in a bounded tail", () => {
    const records = [record(1), record(2), record(3, "latest failure")]
    const tall = tailCommandLogLines(records, 10)
    const short = tailCommandLogLines(records, 4)
    expect(tall.join("\n")).toContain("step-3")
    expect(short.length).toBe(4)
    expect(short.join("\n")).toContain("step-3")
    expect(short.join("\n")).toContain("latest failure")
    expect(short.join("\n")).not.toContain("step-1")
  })
})
