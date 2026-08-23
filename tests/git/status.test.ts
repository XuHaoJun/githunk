import { describe, expect, test } from "bun:test"
import { parsePorcelainV2 } from "../../src/git/status"

describe("porcelain v2 status parsing", () => {
  test("parses ordinary, rename, untracked, and conflict records", () => {
    const raw = [
      "# branch.oid abc123",
      "# branch.head main",
      "# branch.upstream origin/main",
      "1 M. N... 100644 100644 100644 abc abc src/file with spaces.ts",
      "2 R. N... 100644 100644 100644 abc def R100 src/renamed 🚀.ts",
      "src/old name.ts",
      "? untracked/子 🧪.txt",
      "u UU N... 100644 100644 100644 100644 abc def ghi conflict.txt",
    ].join("\0") + "\0"

    const result = parsePorcelainV2(raw)
    expect(result.branch).toBe("main")
    expect(result.upstream).toBe("origin/main")
    expect(result.files).toEqual([
      {
        path: "src/file with spaces.ts",
        indexStatus: "M",
        worktreeStatus: ".",
        untracked: false,
        conflicted: false,
        additions: 0,
        deletions: 0,
      },
      {
        path: "src/renamed 🚀.ts",
        previousPath: "src/old name.ts",
        indexStatus: "R",
        worktreeStatus: ".",
        untracked: false,
        conflicted: false,
        additions: 0,
        deletions: 0,
      },
      {
        path: "untracked/子 🧪.txt",
        indexStatus: ".",
        worktreeStatus: "?",
        untracked: true,
        conflicted: false,
        additions: 0,
        deletions: 0,
      },
      {
        path: "conflict.txt",
        indexStatus: "U",
        worktreeStatus: "U",
        untracked: false,
        conflicted: true,
        additions: 0,
        deletions: 0,
      },
    ])
  })
})
