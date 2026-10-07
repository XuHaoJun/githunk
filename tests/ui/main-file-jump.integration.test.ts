import { afterEach, describe, expect, test } from "bun:test"
import { createShellHarness, type ShellHarness } from "../helpers/shell-harness"
import type { TempRepository } from "../helpers/temp-repository"
import { getMainCursorTarget, getMainDocument } from "../../src/ui/panes/main-pane"

/**
 * lazygit v0.66's focused main view steps from file to file with `n`/`N` (Main.NextFile /
 * Main.PrevFile, pkg/config/user_config.go:1195-1196) — except while a search is active, when the
 * same keys go to the next and previous match (pkg/gocui/gui.go:320).
 */
describe("main pane n/N file navigation", () => {
  let harness: ShellHarness | undefined
  afterEach(async () => {
    await harness?.cleanup()
    harness = undefined
  })

  async function commitDiffHarness(): Promise<ShellHarness> {
    const created = await createShellHarness({
      width: 140,
      height: 40,
      setup: async (repository: TempRepository) => {
        await repository.write("a.txt", "a\n")
        await repository.write("b.txt", "b\n")
        await repository.write("c.txt", "c\n")
        await repository.git(["add", "-A"])
        await repository.git(["commit", "-m", "three files"])
      }
    })
    await created.pressKey("4")
    await created.settle()
    await created.settlePreview()
    await created.pressKey("0")
    await created.settle()
    return created
  }

  function cursorPath(current: ShellHarness): string | undefined {
    const pane = current.app.view!.mainPane
    const target = getMainCursorTarget(pane)
    const file = target === undefined ? undefined : getMainDocument(pane)?.files[target.fileIndex]
    return file?.newPath
  }

  test("n and N step the hunk cursor from file to file when no search is active", async () => {
    harness = await commitDiffHarness()
    expect(getMainDocument(harness.app.view!.mainPane)?.files.map((file) => file.newPath)).toEqual(["a.txt", "b.txt", "c.txt"])

    await harness.pressKey("n")
    expect(cursorPath(harness)).toBe("b.txt")
    await harness.pressKey("n")
    expect(cursorPath(harness)).toBe("c.txt")
    await harness.pressKey("n")
    expect(cursorPath(harness)).toBe("c.txt")
    await harness.pressKey("N")
    expect(cursorPath(harness)).toBe("b.txt")
  })
})
