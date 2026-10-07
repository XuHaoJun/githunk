import { afterEach, describe, expect, test } from "bun:test"
import { TextAttributes, type RGBA } from "@opentui/core"
import { createShellHarness, type ShellHarness } from "../helpers/shell-harness"

/**
 * lazygit prints a commit's tags between the graph and the subject
 * (`pkg/gui/presentation/commits.go:487-489`): `strings.Join(commit.Tags, " ") + " "` in
 * `theme.DiffTerminalColor.SetBold()`, which is `style.FgMagenta` (`pkg/theme/theme.go:47`).
 */
describe("commit tags in panel 4", () => {
  let harness: ShellHarness | undefined
  afterEach(async () => {
    await harness?.cleanup()
    harness = undefined
  })

  const taggedRepository = async (repo: { write(path: string, content: string): Promise<void>; git(args: readonly string[]): Promise<unknown> }): Promise<void> => {
    await repo.write("a.txt", "one\n")
    await repo.git(["add", "a.txt"])
    await repo.git(["commit", "-m", "first commit"])
    await repo.git(["tag", "v1.0.0"])
    await repo.write("a.txt", "two\n")
    await repo.git(["add", "a.txt"])
    await repo.git(["commit", "-m", "second commit"])
    await repo.write("a.txt", "three\n")
    await repo.git(["add", "a.txt"])
    await repo.git(["commit", "-m", "third commit"])
    // Annotated: `listTags` must peel `%(*objectname)` to reach the tagged commit.
    await repo.git(["tag", "-a", "v2.0.0", "-m", "annotated release"])
  }

  function rowContaining(harness: ShellHarness, needle: string): number {
    const row = harness
      .frame()
      .split("\n")
      .findIndex((line) => line.includes(needle))
    if (row < 0) throw new Error(`no row contains ${needle}`)
    return row
  }

  function spansInRow(harness: ShellHarness, row: number): ReadonlyArray<{ text: string; fg: RGBA; attributes: number }> {
    const line = harness.captureSpans().lines[row]
    if (line === undefined) throw new Error(`no captured line ${row}`)
    return line.spans.map((span) => ({ text: span.text, fg: span.fg, attributes: span.attributes }))
  }

  test("a tagged commit shows its tags before the subject, magenta and bold", async () => {
    harness = await createShellHarness({ setup: taggedRepository, width: 120, height: 40 })
    await harness.pressKey("4")
    await harness.flush()
    const text = harness.app.view!.renderedListText("commits")
    expect(text).toContain("v1.0.0 first commit")
    expect(text).toContain("v2.0.0 third commit")
    // The untagged middle commit keeps the graph directly against its subject.
    expect(text).toContain("second commit")
    expect(text).not.toContain("second commit v")

    const tagSpans = spansInRow(harness, rowContaining(harness, "v1.0.0")).filter((span) => span.text.includes("v1.0.0"))
    expect(tagSpans.length).toBeGreaterThan(0)
    expect(tagSpans.every((span) => span.fg.intent === "indexed" && span.fg.slot === 5)).toBe(true)
    expect(tagSpans.every((span) => (span.attributes & TextAttributes.BOLD) === TextAttributes.BOLD)).toBe(true)
  })

  test("the tags tab and the commits panel agree on which tags point at a commit", async () => {
    harness = await createShellHarness({ setup: taggedRepository, width: 120, height: 40 })
    await harness.pressKey("3")
    await harness.pressKey("]")
    await harness.pressKey("]")
    await harness.flush()
    const tags = harness.app.controller.state.tags ?? []
    expect(tags.map((tag) => tag.name).sort()).toEqual(["v1.0.0", "v2.0.0"])
    const commits = harness.app.controller.state.commits ?? []
    const tagged = commits.filter((commit) => commit.subject === "first commit" || commit.subject === "third commit")
    expect(tagged.length).toBe(2)
    expect(tags.every((tag) => tagged.some((commit) => commit.oid === tag.targetOid))).toBe(true)
  })
})
