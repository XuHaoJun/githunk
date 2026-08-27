import { afterEach, describe, expect, test } from "bun:test"
import { createShellHarness, type ShellHarness } from "../helpers/shell-harness"

/**
 * `Open file` (`Actions.OpenFile`, english.go:2195) is lazygit's one `LogAction` call outside a UI
 * controller — it lives in a helper (`pkg/gui/controllers/helpers/files_helper.go:78`), because
 * opening an editor is not a git mutation. githunk mirrors that: the label is logged at
 * `create-app.ts`'s `onEditFile` wiring rather than in `AppController`, so exercising it needs a
 * real `RootView` and a real keypress, not just the controller.
 */
describe("Open file action label", () => {
  let harness: ShellHarness | undefined
  afterEach(async () => {
    await harness?.cleanup()
    harness = undefined
  })

  function actionLabels(harness: ShellHarness): readonly string[] {
    return harness.app.controller.state.commandLog
      .filter((line) => line.spans.some((span) => span.style === "action"))
      .map((line) => line.spans.map((span) => span.text).join(""))
  }

  test("pressing e on the files tab logs Open file, whether the default or an injected editor runs", async () => {
    let editedPath: string | undefined
    harness = await createShellHarness({ onEditFile: async (path) => { editedPath = path } })
    await harness.pressKey("2")
    await harness.settle()
    await harness.pressKey("e")
    await harness.settle()
    expect(editedPath).toBe("b.txt")
    expect(actionLabels(harness)).toContain("Open file")
  })
})
