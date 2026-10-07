import { afterEach, describe, expect, test } from "bun:test"
import { createShellHarness, type ShellHarness } from "../helpers/shell-harness"
import type { TempRepository } from "../helpers/temp-repository"
import { getMainCursorTarget, getMainDiffLineSelection, getMainDocument } from "../../src/ui/panes/main-pane"

// Lines 2, 10 and 18 change: far enough apart that git keeps them in three hunks.
const BASE = Array.from({ length: 20 }, (_, index) => `line ${index + 1}`)
const CHANGED = BASE.map((line, index) => (index === 1 || index === 9 || index === 17 ? line.toUpperCase() : line))

describe("main pane selection after a line action", () => {
  let harness: ShellHarness | undefined
  afterEach(async () => {
    await harness?.cleanup()
    harness = undefined
  })

  async function unstagedHarness(): Promise<ShellHarness> {
    const created = await createShellHarness({
      width: 140,
      height: 40,
      setup: async (repository: TempRepository) => {
        await repository.write("a.txt", `${BASE.join("\n")}\n`)
        await repository.git(["add", "-A"])
        await repository.git(["commit", "-m", "base"])
        await repository.write("a.txt", `${CHANGED.join("\n")}\n`)
      }
    })
    await created.pressKey("0")
    await created.pressKey("]")
    await created.settle()
    await created.pressKey("]")
    await created.settle()
    return created
  }

  function selectedRaws(current: ShellHarness): readonly string[] {
    const pane = current.app.view!.mainPane
    const selection = getMainDiffLineSelection(pane)
    return (selection?.indexes ?? []).map((index) => selection!.document.lines[index]!.raw.trimEnd())
  }

  test("a line range collapses onto the change that moves into its place", async () => {
    harness = await unstagedHarness()
    await harness.pressKey("ARROW_DOWN", { shift: true })
    expect(selectedRaws(harness)).toEqual(["-line 2", "+LINE 2"])

    await harness.pressKey(" ")
    await harness.settle()

    expect((await harness.repository.git(["diff", "--cached", "--", "a.txt"])).stdout).toContain("+LINE 2")
    expect(selectedRaws(harness)).toEqual(["-line 10"])
  })

  test("the hunk cursor moves onto the hunk that takes the place of the one staged", async () => {
    harness = await unstagedHarness()
    // A fresh diff has no hunk cursor yet: the first `l` places it on hunk 0.
    await harness.pressKey("l")
    await harness.pressKey("l")
    expect(getMainCursorTarget(harness.app.view!.mainPane)?.hunkIndex).toBe(1)

    await harness.pressKey(" ")
    await harness.settle()

    const pane = harness.app.view!.mainPane
    expect((await harness.repository.git(["diff", "--cached", "--", "a.txt"])).stdout).toContain("+LINE 10")
    const target = getMainCursorTarget(pane)
    const hunk = getMainDocument(pane)!.files[target!.fileIndex]!.hunks[target!.hunkIndex!]!
    expect(hunk.lines.map((line) => line.raw.trimEnd())).toContain("+LINE 18")
  })

  test("a keyboard range keeps covering its lines when the diff changes elsewhere", async () => {
    harness = await unstagedHarness()
    await harness.pressKey("v")
    await harness.pressKey("ARROW_DOWN")
    expect(selectedRaws(harness)).toEqual(["-line 2", "+LINE 2"])

    await harness.repository.write("a.txt", `${CHANGED.map((line, index) => (index === 17 ? "Line 18" : line)).join("\n")}\n`)
    await harness.pressKey("R")
    await harness.settle()

    expect(getMainDocument(harness.app.view!.mainPane)!.text).toContain("+Line 18")
    expect(selectedRaws(harness)).toEqual(["-line 2", "+LINE 2"])
  })

  test("the hunk cursor stays on its hunk when the diff changes elsewhere", async () => {
    harness = await unstagedHarness()
    await harness.pressKey("l")
    await harness.pressKey("l")

    await harness.repository.write("a.txt", `${CHANGED.map((line, index) => (index === 17 ? "Line 18" : line)).join("\n")}\n`)
    await harness.pressKey("R")
    await harness.settle()

    const pane = harness.app.view!.mainPane
    expect(getMainDocument(pane)!.text).toContain("+Line 18")
    const target = getMainCursorTarget(pane)
    const hunk = getMainDocument(pane)!.files[target!.fileIndex]!.hunks[target!.hunkIndex!]!
    expect(hunk.lines.map((line) => line.raw.trimEnd())).toContain("+LINE 10")
  })

  test("a key pressed while a hunk is being staged acts on the next hunk once the diff has moved on", async () => {
    harness = await unstagedHarness()
    await harness.pressKey("l")
    await harness.pressKey(" ")
    await harness.pressKey(" ")
    await harness.settle()
    await harness.settle()

    const staged = (await harness.repository.git(["diff", "--cached", "--", "a.txt"])).stdout
    expect(staged).toContain("+LINE 2")
    expect(staged).toContain("+LINE 10")
    expect(staged).not.toContain("+LINE 18")
  })

  test("d on the staged side takes the selected lines back out of the index without asking", async () => {
    harness = await createShellHarness({
      width: 140,
      height: 40,
      setup: async (repository: TempRepository) => {
        await repository.write("a.txt", `${BASE.join("\n")}\n`)
        await repository.git(["add", "-A"])
        await repository.git(["commit", "-m", "base"])
        await repository.write("a.txt", `${CHANGED.join("\n")}\n`)
        await repository.git(["add", "-A"])
      }
    })
    await harness.pressKey("0")
    await harness.pressKey("]")
    await harness.settle()
    await harness.pressKey("ARROW_DOWN", { shift: true })
    expect(selectedRaws(harness)).toEqual(["-line 2", "+LINE 2"])

    await harness.pressKey("d")
    await harness.settle()

    const staged = (await harness.repository.git(["diff", "--cached", "--", "a.txt"])).stdout
    expect(staged).not.toContain("+LINE 2")
    expect(staged).toContain("+LINE 10")
    expect((await harness.repository.git(["diff", "--", "a.txt"])).stdout).toContain("+LINE 2")
  })

  test("e opens the editor at the selected line rather than at its hunk's start", async () => {
    const edits: Array<{ readonly path: string; readonly line: number | undefined }> = []
    harness = await createShellHarness({
      width: 140,
      height: 40,
      onEditFile: async (path, line) => {
        edits.push({ path, line })
      },
      setup: async (repository: TempRepository) => {
        await repository.write("a.txt", `${BASE.join("\n")}\n`)
        await repository.git(["add", "-A"])
        await repository.git(["commit", "-m", "base"])
        await repository.write("a.txt", `${CHANGED.join("\n")}\n`)
      }
    })
    await harness.pressKey("0")
    await harness.pressKey("]")
    await harness.settle()
    await harness.pressKey("]")
    await harness.settle()
    await harness.pressKey("l")
    await harness.pressKey("e")
    await harness.settle()
    await harness.pressKey("ARROW_DOWN", { shift: true })
    expect(selectedRaws(harness)).toEqual(["-line 2", "+LINE 2"])
    await harness.pressKey("e")
    await harness.settle()

    // The hunk cursor alone opens at the hunk's first line, as before; a selection opens at the
    // line its cursor end is on.
    expect(edits).toEqual([
      { path: "a.txt", line: 1 },
      { path: "a.txt", line: 2 }
    ])
  })

  test("escape dismisses a range before it leaves the main view", async () => {
    harness = await unstagedHarness()
    const view = harness.app.view!
    await harness.pressKey("v")
    await harness.pressKey("ARROW_DOWN")
    expect(selectedRaws(harness)).toEqual(["-line 2", "+LINE 2"])

    await harness.pressKey("ESCAPE")
    expect(view.focusManager.active).toBe("main")
    expect(selectedRaws(harness)).toEqual([])

    await harness.pressKey("ESCAPE")
    expect(view.focusManager.active).not.toBe("main")
  })
})
