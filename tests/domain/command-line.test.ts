import { describe, expect, test } from "bun:test"
import { formatCommandLine } from "../../src/domain/command"

/**
 * lazygit's `CmdObj.ToString()` (pkg/commands/oscommands/cmd_obj.go:64-75) is deliberately not
 * shell-correct: it wraps an argument in double quotes when it contains a space and otherwise
 * leaves it exactly as it is. These tests pin that, including the cases where it is "wrong",
 * because being wrong the same way lazygit is wrong is the requirement.
 */
describe("formatCommandLine", () => {
  test("joins the argv with spaces and quotes nothing that has no space", () => {
    expect(formatCommandLine(["git", "add", "--", "a.ts"])).toBe("git add -- a.ts")
  })

  test("quotes only the arguments that contain a space", () => {
    expect(formatCommandLine(["git", "add", "--", "my file.ts"])).toBe(`git add -- "my file.ts"`)
    expect(formatCommandLine(["git", "commit", "-F", "-"])).toBe("git commit -F -")
  })

  test("does not escape quotes or backslashes, as ToString does not", () => {
    expect(formatCommandLine(["git", "commit", "-m", `say "hi" now`])).toBe(`git commit -m "say "hi" now"`)
    expect(formatCommandLine(["git", "log", String.raw`--format=%B\n`])).toBe(String.raw`git log --format=%B\n`)
  })

  test("keeps an empty argument as an empty token", () => {
    expect(formatCommandLine(["git", "commit", "-m", ""])).toBe("git commit -m ")
  })

  test("returns an empty string for an empty argv", () => {
    expect(formatCommandLine([])).toBe("")
  })
})
