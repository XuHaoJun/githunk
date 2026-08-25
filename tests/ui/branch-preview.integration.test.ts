import { afterEach, describe, expect, test } from "bun:test"
import { createShellHarness, type ShellHarness } from "../helpers/shell-harness"
import { createTempRepository, type TempRepository } from "../helpers/temp-repository"

/**
 * Panel 3's render-to-main. lazygit shows a ref's commit graph for every selection the panel has:
 * branches_controller.go:199-227 (`GetGraphCmdObj`, title `Log`), remote_branches_controller.go:114
 * (title `Remote Branch`) and tags_controller.go:101 (the tag's own info, then `---`, then the same
 * graph). Only the Remotes tab renders something else: the remote's name and URLs
 * (remotes_controller.go:101-125).
 */
describe("panel 3 render-to-main", () => {
  let harness: ShellHarness | undefined
  let remoteBare: TempRepository | undefined

  afterEach(async () => {
    await harness?.cleanup()
    harness = undefined
    await remoteBare?.cleanup()
    remoteBare = undefined
  })

  test("selecting a local branch shows its commit graph, coloured by git", async () => {
    harness = await createShellHarness({ commits: ["first commit", "second commit"] })
    await harness.pressKey("3")
    await harness.app.view!.whenPreviewSettled()
    await harness.flush()

    const content = harness.app.view!.mainContent
    expect(content?.source).toBe("local-branch")
    expect(content?.ansi?.text).toContain("second commit")
    expect(content?.ansi?.text).toContain("first commit")
    expect(content?.ansi?.text).toContain("Author:")
    // git's own SGR sequences survived as highlight spans, not as literal escapes in the text.
    expect(content!.ansi!.spans.length).toBeGreaterThan(0)
    expect(content?.ansi?.text).not.toContain("\u001b")
    expect(harness.frame()).toContain("second commit")
  })

  test("the main pane is titled Log while a local branch is selected", async () => {
    harness = await createShellHarness()
    await harness.pressKey("3")
    await harness.app.view!.whenPreviewSettled()
    await harness.flush()
    expect(harness.frame()).toContain("0 Main — Log")
  })

  test("moving the selection re-runs the graph for the newly selected branch", async () => {
    harness = await createShellHarness({ commits: ["shared base"] })
    await harness.repository.git(["checkout", "-b", "feature", "--quiet"])
    await harness.repository.write("f.txt", "feature\n")
    await harness.repository.git(["add", "f.txt"])
    await harness.repository.git(["commit", "-m", "feature only commit"])
    await harness.repository.git(["checkout", "-", "--quiet"])
    await harness.app.refresh()
    await harness.pressKey("3")
    await harness.app.view!.whenPreviewSettled()
    expect(harness.app.view!.mainContent?.ansi?.text).not.toContain("feature only commit")

    await harness.pressKey("j")
    await harness.app.view!.whenPreviewSettled()
    await harness.flush()
    const content = harness.app.view!.mainContent
    expect(content?.stableId).toBe("feature")
    expect(content?.ansi?.text).toContain("feature only commit")
  })

  test("the Remotes tab shows the remote's name and URLs", async () => {
    harness = await createShellHarness()
    remoteBare = await createTempRepository()
    await remoteBare.git(["config", "core.bare", "true"])
    await harness.repository.git(["remote", "add", "origin", remoteBare.path])
    await harness.app.refresh()
    await harness.pressKey("3")
    await harness.pressKey("]")
    await harness.app.view!.whenPreviewSettled()
    await harness.flush()

    const content = harness.app.view!.mainContent
    expect(content?.source).toBe("remote")
    expect(content?.plainText).toContain("origin")
    expect(content?.plainText).toContain("Urls:")
    expect(content?.plainText).toContain(remoteBare.path)
  })

  test("a remote branch inside the Remotes drill-down shows its own commit graph", async () => {
    harness = await createShellHarness({ commits: ["pushed commit"] })
    remoteBare = await createTempRepository()
    await remoteBare.git(["config", "core.bare", "true"])
    await harness.repository.git(["remote", "add", "origin", remoteBare.path])
    await harness.repository.git(["push", "origin", "HEAD:refs/heads/feature"])
    await harness.repository.git(["fetch", "origin"])
    await harness.app.refresh()
    await harness.pressKey("3")
    await harness.pressKey("]")
    await harness.pressKey("RETURN")
    await harness.settle()
    await harness.app.view!.whenPreviewSettled()
    await harness.flush()

    const content = harness.app.view!.mainContent
    expect(content?.source).toBe("remote-branch")
    expect(content?.stableId).toBe("origin/feature")
    expect(content?.ansi?.text).toContain("pushed commit")
  })

  test("the Tags tab shows the tag's own info above the graph", async () => {
    harness = await createShellHarness({ commits: ["tagged commit"] })
    await harness.repository.git(["tag", "v1.0"])
    await harness.app.refresh()
    await harness.pressKey("3")
    await harness.pressKey("]")
    await harness.pressKey("]")
    await harness.app.view!.whenPreviewSettled()
    await harness.flush()

    const content = harness.app.view!.mainContent
    expect(content?.source).toBe("tag")
    expect(content?.preamble).toContain("Lightweight tag: v1.0")
    expect(content?.ansi?.text).toContain("tagged commit")
  })

  test("an empty tab renders lazygit's own empty-state line rather than nothing", async () => {
    harness = await createShellHarness()
    await harness.pressKey("3")
    await harness.pressKey("]")
    await harness.app.view!.whenPreviewSettled()
    await harness.flush()
    expect(harness.app.view!.mainContent?.plainText).toBe("No remotes")

    await harness.pressKey("]")
    await harness.app.view!.whenPreviewSettled()
    await harness.flush()
    expect(harness.app.view!.mainContent?.plainText).toBe("No tags")
  })
})
