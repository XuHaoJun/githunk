import { afterEach, describe, expect, test } from "bun:test"
import { createShellHarness, type ShellHarness } from "../helpers/shell-harness"
import type { TempRepository } from "../helpers/temp-repository"

const LONG_PATH = `${"deeply/nested/".repeat(6)}file-with-a-long-name.txt`

/**
 * A commit's diffstat is laid out to the main view's width, not git's 80-column default for a
 * pipe, and laid out again when the layout gives the view another width — lazygit
 * pkg/gui/main_view_render.go:250-256 and commit 0afb94e97.
 */
describe("commit preview diffstat width", () => {
  let harness: ShellHarness | undefined
  afterEach(async () => {
    await harness?.cleanup()
    harness = undefined
  })

  test("follows the width of the main view", async () => {
    harness = await createShellHarness({
      width: 220,
      height: 40,
      setup: async (repository: TempRepository) => {
        await repository.write(LONG_PATH, "one\n")
        await repository.git(["add", "-A"])
        await repository.git(["commit", "-m", "long path"])
      }
    })
    const view = harness.app.view!
    await harness.pressKey("4")
    await harness.settle()
    await view.whenPreviewSettled()
    expect(view.mainContent?.source).toBe("commit")
    expect(view.mainContent?.preamble).toContain(` ${LONG_PATH} `)

    await harness.resize(90, 40)
    await harness.settle()
    await view.whenPreviewSettled()
    expect(view.mainContent?.preamble).not.toContain(` ${LONG_PATH} `)
    expect(view.mainContent?.preamble).toContain("...")
  })
})
