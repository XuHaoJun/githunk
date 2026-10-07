import { afterEach, describe, expect, test } from "bun:test"
import { BoxRenderable } from "@opentui/core"
import { createShellHarness, type ShellHarness } from "../helpers/shell-harness"

function bottomBorder(harness: ShellHarness, id: "files" | "branches" | "commits" | "stash"): string {
  const win = harness.app.view!.geometry.windows[id]!
  const line = harness.frame().split("\n")[win.y1]!
  let x = 0
  let result = ""
  for (const char of line) {
    const width = Bun.stringWidth(char)
    if (x > win.x1) break
    if (x >= win.x0) result += char
    x += width
  }
  return result
}

describe("list panel footers", () => {
  let harness: ShellHarness | undefined
  afterEach(async () => {
    await harness?.cleanup()
    harness = undefined
  })

  test("tracks the cursor rather than the viewport or range size, including mouse selection", async () => {
    harness = await createShellHarness({ commits: ["alpha", "beta", "gamma"] })
    await harness.pressKey("4")
    expect(bottomBorder(harness, "commits")).toEndWith("1 of 3─┘")
    await harness.pressKey("j")
    expect(bottomBorder(harness, "commits")).toEndWith("2 of 3─┘")
    await harness.pressKey("v")
    await harness.pressKey("j")
    expect(bottomBorder(harness, "commits")).toEndWith("3 of 3─┘")
    const geom = harness.paneTextGeometry("commits")!
    await harness.mockMouse.scroll(geom.screenX + 1, geom.screenY, "up")
    await harness.flush()
    expect(bottomBorder(harness, "commits")).toEndWith("3 of 3─┘")
    await harness.pressKey("1")
    expect(bottomBorder(harness, "commits")).toEndWith("3 of 3─┘")
    await harness.mockMouse.click(geom.screenX + 1, geom.screenY)
    await harness.flush()
    expect(bottomBorder(harness, "commits")).toEndWith("1 of 3─┘")
  })

  test("refresh preserves the selected identity and clamps it when history shrinks", async () => {
    harness = await createShellHarness({ commits: ["alpha", "beta", "gamma"] })
    await harness.pressKey("4")
    await harness.pressKey("j")
    await harness.settlePreview()
    expect(bottomBorder(harness, "commits")).toEndWith("2 of 3─┘")
    const removedLatest = await harness.repository.git(["reset", "--hard", "HEAD~1"])
    expect(removedLatest.exitCode).toBe(0)
    await harness.app.refresh()
    await harness.settlePreview()
    expect(bottomBorder(harness, "commits")).toEndWith("1 of 2─┘")
    const removedSelected = await harness.repository.git(["reset", "--hard", "HEAD~1"])
    expect(removedSelected.exitCode).toBe(0)
    await harness.app.refresh()
    await harness.settlePreview()
    expect(bottomBorder(harness, "commits")).toEndWith("1 of 1─┘")
  })

  test("switches to the child list and restores the parent cursor on return", async () => {
    harness = await createShellHarness({ commits: ["alpha", "beta", "gamma"] })
    await harness.pressKey("4")
    await harness.pressKey("j")
    await harness.pressKey("RETURN")
    await harness.settlePreview()
    expect(bottomBorder(harness, "commits")).toEndWith("1 of 1─┘")
    await harness.pressKey("ESCAPE")
    expect(bottomBorder(harness, "commits")).toEndWith("2 of 3─┘")
    await harness.pressKey("3")
    expect(bottomBorder(harness, "branches")).toEndWith("1 of 1─┘")
    await harness.pressKey("]")
    expect(bottomBorder(harness, "branches")).toEndWith("0 of 0─┘")
    await harness.pressKey("[")
    expect(bottomBorder(harness, "branches")).toEndWith("1 of 1─┘")
    expect(bottomBorder(harness, "stash")).toEndWith("0 of 0─┘")
  })

  test("filters the counted items but not empty-state messages", async () => {
    harness = await createShellHarness()
    await harness.repository.write("c.txt", "another file\n")
    await harness.app.refresh()
    await harness.flush()
    await harness.pressKey("2")
    // Two files plus the existing selectable root-directory row; b.txt survives refresh.
    expect(bottomBorder(harness, "files")).toEndWith("2 of 3─┘")
    await harness.pressKey("-")
    expect(bottomBorder(harness, "files")).toEndWith("1 of 1─┘")
    await harness.pressKey("=")
    expect(bottomBorder(harness, "files")).toEndWith("1 of 3─┘")
    await harness.pressKey("/")
    await harness.typeText("c.txt")
    await harness.pressKey("RETURN")
    expect(bottomBorder(harness, "files")).toEndWith("1 of 1─┘")
    await harness.pressKey("/")
    await harness.typeText("no-match")
    await harness.pressKey("RETURN")
    expect(bottomBorder(harness, "files")).toEndWith("0 of 0─┘")
  })

  test("two border rows without a content viewport do not show a list counter", async () => {
    harness = await createShellHarness()
    const box = harness.app.view!.commitsPane.box
    box.height = 2
    await harness.flush()
    const border = harness
      .frame()
      .split("\n")
      [box.screenY + 1]!.slice(box.screenX, box.screenX + box.width)
    expect(border).toStartWith("└")
    expect(border).toEndWith("┘")
    expect(border).not.toContain("of")
  })

  test("preserves wide-character notices and hides the counter instead of colliding or truncating", async () => {
    harness = await createShellHarness({ width: 120 })
    const box = harness.app.view!.root.findDescendantById("commits-pane") as BoxRenderable
    box.bottomTitle = "檢查 e\u0301"
    await harness.flush()
    expect(bottomBorder(harness, "commits")).toContain("檢查 e\u0301")
    expect(bottomBorder(harness, "commits")).toEndWith("1 of 3─┘")
    box.bottomTitle = "檢".repeat(15)
    await harness.flush()
    expect(bottomBorder(harness, "commits")).toContain("檢".repeat(15))
    expect(bottomBorder(harness, "commits")).not.toContain("of 3")
    box.bottomTitle = undefined
    await harness.flush()
    expect(bottomBorder(harness, "commits")).toEndWith("1 of 3─┘")
    box.width = 8
    await harness.flush()
    expect(bottomBorder(harness, "commits")).not.toContain("of")
    await harness.resize(24, 40)
    expect(harness.app.view!.geometry.windows.commits).toBeUndefined()
    await harness.resize(120, 40)
    expect(bottomBorder(harness, "commits")).toEndWith("1 of 3─┘")
    await harness.resize(120, 20)
    const folded = harness.app.view!.geometry.windows.stash!
    expect(folded.y1 - folded.y0 + 1).toBe(1)
    expect(bottomBorder(harness, "stash")).not.toContain("of")
    await harness.pressKey("5")
    expect(bottomBorder(harness, "stash")).toEndWith("0 of 0─┘")
  })
})
