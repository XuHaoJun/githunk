import { describe, expect, test } from "bun:test"
import { reviewStatusText } from "../../src/ui/hints-bar"
import { renderMenuLines } from "../../src/ui/keybinding-menu"
import type { AppModel } from "../../src/app/model"
import type { MenuEntry } from "../../src/ui/bindings"

function model(overrides: Partial<AppModel> = {}): AppModel {
  return {
    repositoryRoot: "/tmp/repo",
    branch: "feature/payment",
    reviewTarget: { kind: "working-tree", scope: "unstaged" },
    files: [],
    patches: [],
    rawPatchSections: [],
    reviewStatuses: {},
    reviewSummary: { reviewed: 7, invalidated: 0, commits: 0, files: 12, additions: 0, deletions: 0 },
    loading: false,
    commandLog: [],
    title: "Working Tree — Unstaged",
    commits: [],
    ...overrides,
  } as AppModel
}

describe("reviewStatusText", () => {
  test("names the target and the review progress", () => {
    expect(reviewStatusText(model())).toBe("Working Tree — Unstaged  7/12 ●")
  })

  test("appends an invalidation count when files changed after review", () => {
    const invalidated = model({
      reviewSummary: { reviewed: 17, invalidated: 2, commits: 7, files: 24, additions: 0, deletions: 0 },
      reviewTarget: { kind: "stash", ref: "stash@{0}" },
      title: "Stash — stash@{0}",
    })
    expect(reviewStatusText(invalidated)).toBe("Stash — stash@{0}  17/24 ●  2!")
  })

  test("omits the progress segment when there are no files", () => {
    const empty = model({
      reviewSummary: { reviewed: 0, invalidated: 0, commits: 0, files: 0, additions: 0, deletions: 0 },
    })
    expect(reviewStatusText(empty)).toBe("Working Tree — Unstaged")
  })

  test("shows a banner instead of the routine status while one is set", () => {
    const banner = model({ banner: "Deleted branch feature/x" })
    expect(reviewStatusText(banner)).toBe("! Deleted branch feature/x")
  })
})

describe("renderMenuLines", () => {
  const entries: readonly MenuEntry[] = [
    { group: "context", keys: "space", description: "stage the selected file", enabled: true },
    { group: "context", keys: "d", description: "discard the file's changes", enabled: false },
    { group: "global", keys: "q", description: "quit", enabled: true },
  ]

  test("groups context bindings under the pane name and global ones after", () => {
    const lines = renderMenuLines(entries, "Files")
    expect(lines[0]).toBe("Files")
    expect(lines[1]).toBe("  space  stage the selected file")
    expect(lines).toContain("Global")
    expect(lines.at(-1)).toBe("  q      quit")
  })

  test("marks disabled bindings so they are visibly unavailable", () => {
    expect(renderMenuLines(entries, "Files")[2]).toBe("  d      discard the file's changes  (unavailable)")
  })

  test("aligns the key column to the widest key", () => {
    const lines = renderMenuLines([
      { group: "context", keys: "space", description: "stage", enabled: true },
      { group: "context", keys: "d", description: "discard", enabled: true },
    ], "Files")
    expect(lines[1]).toBe("  space  stage")
    expect(lines[2]).toBe("  d      discard")
  })
})
