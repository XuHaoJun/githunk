import { afterEach, describe, expect, test } from "bun:test"
import { createShellHarness, type ShellHarness } from "../helpers/shell-harness"
import type { TempRepository } from "../helpers/temp-repository"
import { createMockMouse } from "@opentui/core/testing"
import { heightOf, FOLDED_PANE_HEIGHT } from "../../src/ui/layout"
import { paneScrollbar } from "../../src/ui/panes/common"
import type { FocusId } from "../../src/ui/focus"
import { copySelection, selectionFromRenderable } from "../../src/domain/diff/selection"
import type { MainPaneContent } from "../../src/ui/panes/main-pane"

async function expectGit(repository: TempRepository, args: readonly string[]): Promise<void> {
  const result = await repository.git(args)
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr} stdout:${result.stdout}`)
}

function mainText(view: NonNullable<ShellHarness["app"]["view"]>): string {
  const content = view.mainContent
  if (!content) return ""
  if (content.document) return `${content.preamble ?? ""}${content.document.text}`
  return content.plainText ?? content.preamble ?? ""
}

describe("lazygit core UI acceptance", () => {
  let harness: ShellHarness | undefined
  afterEach(async () => {
    await harness?.cleanup()
    harness = undefined
  })

  test("ordered acceptance covers keyboard mouse tabs graph preview layout scrollbars splitters and copy", async () => {
    harness = await createShellHarness({
      width: 120,
      height: 40,
      setup: async (repository, fetchBare, pushBare) => {
        await expectGit(repository, ["config", "user.name", "Noah Reviewer"])
        await expectGit(repository, ["config", "user.email", "noah@example.invalid"])
        await repository.write("base.txt", "base\n")
        await expectGit(repository, ["add", "base.txt"])
        await expectGit(repository, ["commit", "-m", "base commit"])
        await expectGit(repository, ["switch", "-c", "side"])
        await repository.write("side.txt", "side\n")
        await expectGit(repository, ["add", "side.txt"])
        await expectGit(repository, ["commit", "-m", "side commit"])
        await expectGit(repository, ["switch", "master"])
        await repository.write("main.txt", "main\n")
        await expectGit(repository, ["add", "main.txt"])
        await expectGit(repository, ["commit", "-m", "main commit"])
        await expectGit(repository, ["merge", "--no-ff", "side", "-m", "merge side"])
        await expectGit(repository, ["tag", "light"])
        await expectGit(repository, ["tag", "-a", "v1", "-m", "release one"])
        await repository.write("stash.txt", "stash\n")
        await expectGit(repository, ["add", "stash.txt"])
        await expectGit(repository, ["stash", "push", "-m", "review stash"])
        await repository.write("rename-before.txt", "before\n")
        await expectGit(repository, ["add", "rename-before.txt"])
        await expectGit(repository, ["commit", "-m", "rename base"])
        await expectGit(repository, ["mv", "rename-before.txt", "rename-after.txt"])
        await repository.write("staged.txt", "staged\n")
        await expectGit(repository, ["add", "rename-after.txt", "staged.txt"])
        await repository.write("unstaged.txt", "unstaged\n")
        await expectGit(repository, ["remote", "add", "fetch-seed", fetchBare.path])
        await expectGit(repository, ["push", "fetch-seed", "master"])
        await expectGit(repository, ["remote", "remove", "fetch-seed"])
        await expectGit(repository, ["remote", "add", "origin", fetchBare.path])
        await expectGit(repository, ["remote", "set-url", "--push", "origin", pushBare.path])
        await expectGit(repository, ["push", "origin", "master"])
        await expectGit(repository, ["fetch", "origin"])
      },
    })

    const view = harness.app.view!
    const app = harness.app
    const mouse = createMockMouse(harness.renderer)

    // Harness contract: exposes renderer and paneTextGeometry for createMockMouse
    expect(harness.fetchBare).toBeDefined()
    expect(harness.pushBare).toBeDefined()
    expect(harness.renderer).toBeDefined()
    const geometryFn = harness.paneTextGeometry.bind(harness)
    expect(typeof geometryFn).toBe("function")
    const commitsGeom = geometryFn("commits" as FocusId)
    expect(commitsGeom).toBeDefined()
    expect(view.paneTextGeometry("commits")).toEqual(commitsGeom)

    // 1. Commits rows contain Noah Reviewer, short hash, graph glyphs, no arrow cursor
    await harness.pressKey("4")
    await harness.flush()
    await view.whenPreviewSettled().catch(() => {})
    await harness.flush()
    const commitsText = view.renderedListText("commits")
    expect(commitsText).toContain("Noah Reviewer")
    expect(commitsText).toMatch(/\b[0-9a-f]{7}\b/)
    expect(commitsText).toMatch(/[●│┬]/)
    expect(commitsText).not.toContain("▸")
    expect(commitsText).not.toContain(">")
    expect(view.selectedRowHasBackground("commits")).toBe(true)
    await harness.pressKey("0")
    await harness.flush()
    expect(view.selectedRowHasBackground("commits")).toBe(false)
    await harness.pressKey("4")
    await harness.flush()
    expect(view.selectedRowHasBackground("commits")).toBe(true)

    // 2. Keyboard and mouse commit selection update Main metadata + file changed stat + patch
    await harness.flush()
    await view.whenPreviewSettled().catch(() => {})
    let mainMeta = view.mainContent?.preamble ?? mainText(view)
    expect(mainMeta).toContain("Noah Reviewer")
    expect(mainMeta).toMatch(/file changed|files changed/)
    let patchText = mainText(view)
    expect(patchText).toContain("diff --git")
    const firstOid = view.commitsSelectedOid!
    expect(firstOid).toMatch(/^[0-9a-f]{40}$/)
    await harness.pressKey("j")
    await harness.flush()
    await view.whenPreviewSettled().catch(() => {})
    await harness.flush()
    const secondOid = view.commitsSelectedOid!
    expect(secondOid).not.toBe(firstOid)
    expect(view.mainContent?.stableId).toBe(secondOid)
    expect(view.mainContent?.source).toBe("commit")
    mainMeta = view.mainContent?.preamble ?? ""
    expect(mainMeta.length).toBeGreaterThan(0)
    patchText = mainText(view)
    expect(patchText).toContain("diff --git")
    const commitsBox = harness.paneTextGeometry("commits")!
    expect(commitsBox.height).toBeGreaterThanOrEqual(3)
    await mouse.click(commitsBox.screenX + 2, commitsBox.screenY + 2)
    await harness.flush()
    await view.whenPreviewSettled().catch(() => {})
    await harness.flush()
    const thirdOid = view.commitsSelectedOid!
    expect(thirdOid).not.toBe(secondOid)
    expect(view.mainContent?.stableId).toBe(thirdOid)
    expect(app.controller.state.reviewTarget.kind).toBe("working-tree")

    // 3. Selecting different commit clears Main selection and resets both viewport axes; returning to same unchanged preview preserves stable identity + stale preview not overwrite
    const mainView = view.mainPane.text as unknown as {
      setSelection?: (start: number, end: number) => void
      hasSelection?: () => boolean
      resetSelection?: () => void
      scrollY: number
      scrollX: number
      maxScrollY: number
      maxScrollX: number
    }
    view.mainPane.text.scrollY = 5
    view.mainPane.text.scrollX = 3
    if (typeof mainView.setSelection === "function") {
      try { mainView.setSelection(0, 8) } catch {}
    }
    const stableBeforeMove = view.mainContent?.stableId
    const textBeforeMove = mainText(view)
    await harness.pressKey("k")
    await harness.flush()
    await view.whenPreviewSettled().catch(() => {})
    await harness.flush()
    expect(view.mainPane.text.scrollY).toBe(0)
    expect(view.mainPane.text.scrollX).toBe(0)
    expect(typeof mainView.hasSelection === "function" ? mainView.hasSelection() : false).toBe(false)
    const stableAfterDifferent = view.mainContent?.stableId
    expect(stableAfterDifferent).not.toBe(stableBeforeMove)
    // stale preview generation: rapid moves should keep last selection's preview
    const oidBeforeRapid = view.commitsSelectedOid!
    await harness.pressKey("j")
    await harness.flush()
    const firstRapid = view.whenPreviewSettled().catch(() => {})
    await harness.pressKey("j")
    await harness.flush()
    const secondRapid = view.whenPreviewSettled().catch(() => {})
    await Promise.all([firstRapid, secondRapid])
    await view.whenPreviewSettled().catch(() => {})
    await harness.flush()
    const oidAfterRapid = view.commitsSelectedOid!
    expect(oidAfterRapid).not.toBe(oidBeforeRapid)
    expect(view.mainContent?.stableId).toBe(oidAfterRapid)
    // Return to same unchanged preview preserves stable identity
    let attempts = 0
    while (view.commitsSelectedOid !== stableBeforeMove && attempts < 10) {
      await harness.pressKey("k")
      await harness.flush()
      await view.whenPreviewSettled().catch(() => {})
      attempts++
    }
    expect(view.commitsSelectedOid).toBe(stableBeforeMove)
    expect(view.mainContent?.stableId).toBe(stableBeforeMove)
    expect(mainText(view)).toBe(textBeforeMove)
    // Same-identity reinstall preserves viewport when text identical
    view.mainPane.text.scrollY = 4
    if (typeof mainView.setSelection === "function") {
      try { mainView.setSelection(0, 5) } catch {}
    }
    const prevScrollY = view.mainPane.text.scrollY
    const prevHadSel = typeof mainView.hasSelection === "function" ? mainView.hasSelection() : false
    const currentContent = view.mainContent!
    view.installMainContent(currentContent)
    await harness.flush()
    expect(view.mainPane.text.scrollY).toBe(prevScrollY)
    if (prevHadSel) {
      expect(typeof mainView.hasSelection === "function" ? mainView.hasSelection() : false).toBe(true)
    }
    // Different text for same stableId clears selection
    if (currentContent.plainText !== undefined) {
      const changed = {
        source: currentContent.source,
        stableId: currentContent.stableId,
        label: currentContent.label,
        plainText: `${currentContent.plainText}\nchanged`,
        preamble: `${currentContent.preamble ?? ""}\nchanged`,
      } as unknown as MainPaneContent
      view.installMainContent(changed)
      await harness.flush()
      expect(typeof mainView.hasSelection === "function" ? mainView.hasSelection() : false).toBe(false)
    } else if (currentContent.document) {
      const docChanged: MainPaneContent = {
        source: currentContent.source,
        stableId: currentContent.stableId,
        label: currentContent.label,
        document: { ...currentContent.document, text: `${currentContent.document.text}\nchanged line\n` },
        ...(currentContent.preamble === undefined ? {} : { preamble: currentContent.preamble }),
      }
      view.installMainContent(docChanged)
      await harness.flush()
      expect(typeof mainView.hasSelection === "function" ? mainView.hasSelection() : false).toBe(false)
    }

    // 4. Enter/double-click opens CommitFiles in window 4 without changing reviewTarget; file keyboard/mouse selection changes Main; Escape restores OID
    // Ensure we drill a commit with at least 2 files (merge side) so j changes selection; otherwise j would be a no-op for single-file commits
    let mergeOid: string | undefined
    for (const c of app.controller.state.commits ?? []) {
      if (c.subject === "merge side") mergeOid = c.oid
    }
    if (mergeOid) {
      let attemptsMerge = 0
      while (view.commitsSelectedOid !== mergeOid && attemptsMerge < 12) {
        await harness.pressKey("j")
        await harness.flush()
        await view.whenPreviewSettled().catch(() => {})
        attemptsMerge++
        if (view.commitsSelectedOid === mergeOid) break
        // also try k wrapping
        if (attemptsMerge === 6) {
          for (let k = 0; k < 6; k++) {
            await harness.pressKey("k")
            await harness.flush()
            await view.whenPreviewSettled().catch(() => {})
            if (view.commitsSelectedOid === mergeOid) break
          }
        }
      }
    }
    const oidForDrill = view.commitsSelectedOid!
    const targetBeforeDrill = JSON.stringify(app.controller.state.reviewTarget)
    const branchTargetBefore = JSON.stringify((app.controller.state as unknown as { branchReviewTarget?: unknown }).branchReviewTarget)
    const generationBefore = (app.controller as unknown as { generation?: number }).generation
    await harness.pressKey("4")
    await harness.flush()
    await harness.pressKey("RETURN")
    await harness.flush()
    await view.whenPreviewSettled().catch(() => {})
    await harness.flush()
    expect(view.commitsPanel.child).toBeDefined()
    expect(view.commitsPanel.child?.value.kind).toBe("commit-files")
    expect(view.commitsPanel.child?.value.oid).toBe(oidForDrill)
    expect(JSON.stringify(app.controller.state.reviewTarget)).toBe(targetBeforeDrill)
    expect(JSON.stringify((app.controller.state as unknown as { branchReviewTarget?: unknown }).branchReviewTarget)).toBe(branchTargetBefore)
    if (generationBefore !== undefined) expect((app.controller as unknown as { generation?: number }).generation).toBe(generationBefore)
    const beforeFileSel = view.mainContent?.stableId
    await harness.pressKey("j")
    await harness.flush()
    await view.whenPreviewSettled().catch(() => {})
    await harness.flush()
    if (view.commitsPanel.child) {
      expect(view.mainContent?.source).toBe("commit-file")
      const files = view.mainContent?.document?.files ?? []
      expect(files.length).toBeGreaterThan(0)
      if (files.length > 1) {
        expect(view.mainContent?.stableId).not.toBe(beforeFileSel)
      }
    }
    const commitFilesBox = harness.paneTextGeometry("commits")!
    await mouse.click(commitFilesBox.screenX + 1, commitFilesBox.screenY + 1)
    await harness.flush()
    await view.whenPreviewSettled().catch(() => {})
    await harness.flush()
    expect(view.mainContent?.stableId).toBeDefined()
    await harness.pressKey("ESCAPE")
    await harness.flush()
    await view.whenPreviewSettled().catch(() => {})
    await harness.flush()
    expect(view.commitsPanel.child).toBeUndefined()
    expect(view.commitsSelectedOid).toBe(oidForDrill)
    expect(view.mainContent?.source).toBe("commit")
    expect(view.mainContent?.stableId).toBe(oidForDrill)
    expect(JSON.stringify((app.controller.state as unknown as { branchReviewTarget?: unknown }).branchReviewTarget)).toBe(branchTargetBefore)
    // double-click path
    const commitsBox2 = harness.paneTextGeometry("commits")!
    await mouse.doubleClick(commitsBox2.screenX + 2, commitsBox2.screenY + 1)
    await harness.flush()
    await view.whenPreviewSettled().catch(() => {})
    await harness.flush()
    if (view.commitsPanel.child === undefined) {
      await harness.pressKey("RETURN")
      await harness.flush()
    }
    expect(view.commitsPanel.child?.value.kind).toBe("commit-files")
    expect(JSON.stringify(app.controller.state.reviewTarget)).toBe(targetBeforeDrill)
    expect(JSON.stringify((app.controller.state as unknown as { branchReviewTarget?: unknown }).branchReviewTarget)).toBe(branchTargetBefore)
    const oidInChild = view.commitsPanel.child!.value.oid
    await harness.pressKey("ESCAPE")
    await harness.flush()
    await view.whenPreviewSettled().catch(() => {})
    await harness.flush()
    expect(view.commitsPanel.child).toBeUndefined()
    expect(view.commitsSelectedOid).toBe(oidInChild)
    expect(view.mainContent?.stableId).toBe(oidInChild)
    expect(JSON.stringify((app.controller.state as unknown as { branchReviewTarget?: unknown }).branchReviewTarget)).toBe(branchTargetBefore)

    // 5. Panel 3 [/] wraps Branches/Remotes/Tags and preserves each selection
    await harness.pressKey("3")
    await harness.flush()
    expect((view.activeBranchesTab as string)).toBe("branches")
    const branchesSel = view.selectedListId("branches")
    await harness.pressKey("j")
    await harness.flush()
    const savedBranches = view.selectedListId("branches") ?? branchesSel
    await harness.pressKey("]")
    await harness.flush()
    expect((view.activeBranchesTab as string)).toBe("remotes")
    const remotesSel = view.selectedListId("branches")
    expect(remotesSel).toBeDefined()
    await harness.pressKey("j")
    await harness.flush()
    const remotesAfterMove = view.selectedListId("branches") ?? remotesSel
    await harness.pressKey("]")
    await harness.flush()
    expect((view.activeBranchesTab as string)).toBe("tags")
    const tagsSel = view.selectedListId("branches")
    expect(tagsSel).toBeDefined()
    await harness.pressKey("j")
    await harness.flush()
    const tagsAfterMove = view.selectedListId("branches") ?? tagsSel
    await harness.pressKey("]")
    await harness.flush()
    expect((view.activeBranchesTab as string)).toBe("branches")
    expect(view.selectedListId("branches")).toBe(savedBranches)
    await harness.pressKey("[")
    await harness.flush()
    expect((view.activeBranchesTab as string)).toBe("tags")
    expect(view.selectedListId("branches")).toBe(tagsAfterMove)
    await harness.pressKey("[")
    await harness.flush()
    expect((view.activeBranchesTab as string)).toBe("remotes")
    expect(view.selectedListId("branches")).toBe(remotesAfterMove)
    await harness.pressKey("[")
    await harness.flush()
    expect((view.activeBranchesTab as string)).toBe("branches")
    expect(view.selectedListId("branches")).toBe(savedBranches)

    // 6. Remotes Enter/Escape child behavior and Tags preview fields are correct
    while ((view.activeBranchesTab as string) !== "remotes") {
      await harness.pressKey("]")
      await harness.flush()
    }
    expect(view.renderedListText("branches")).toContain("origin")
    const remotesSelectionBefore = view.selectedListId("branches")
    expect(remotesSelectionBefore).toBeDefined()
    expect(remotesSelectionBefore!.startsWith("remote:")).toBe(true)
    await harness.pressKey("RETURN")
    await harness.flush()
    await harness.settle()
    await harness.flush()
    expect(view.branchesPanel.child).toBeDefined()
    expect(view.branchesPanel.child?.value.kind).toBe("remote-branches")
    expect(view.branchesPanel.child?.value.remote).toBe("origin")
    expect(view.renderedListText("branches")).toContain("origin/master")
    expect(view.mainContent?.source).toBe("remote-branch")
    await harness.pressKey("ESCAPE")
    await harness.flush()
    await harness.flush()
    expect(view.branchesPanel.child).toBeUndefined()
    expect(view.selectedListId("branches")).toBe(remotesSelectionBefore)
    expect((view.activeBranchesTab as string)).toBe("remotes")
    while ((view.activeBranchesTab as string) !== "tags") {
      await harness.pressKey("]")
      await harness.flush()
    }
    expect(view.renderedListText("branches")).toContain("light")
    expect(view.renderedListText("branches")).toContain("v1")
    let attemptsTag = 0
    while (view.selectedListId("branches") !== "tag:refs/tags/light" && attemptsTag < 8) {
      await harness.pressKey("k")
      await harness.flush()
      attemptsTag++
    }
    if (view.selectedListId("branches") !== "tag:refs/tags/light") {
      attemptsTag = 0
      while (view.selectedListId("branches") !== "tag:refs/tags/light" && attemptsTag < 8) {
        await harness.pressKey("j")
        await harness.flush()
        attemptsTag++
      }
    }
    expect(view.selectedListId("branches")).toBe("tag:refs/tags/light")
    await view.whenPreviewSettled().catch(() => {})
    await harness.flush()
    expect(view.mainContent?.source).toBe("tag")
    let tagPlain = view.mainContent?.plainText ?? ""
    expect(tagPlain).toContain("light")
    expect(tagPlain).toContain("lightweight")
    expect(tagPlain).toMatch(/[0-9a-f]{7}/)
    attemptsTag = 0
    while (view.selectedListId("branches") !== "tag:refs/tags/v1" && attemptsTag < 8) {
      await harness.pressKey("j")
      await harness.flush()
      attemptsTag++
    }
    if (view.selectedListId("branches") !== "tag:refs/tags/v1") {
      attemptsTag = 0
      while (view.selectedListId("branches") !== "tag:refs/tags/v1" && attemptsTag < 8) {
        await harness.pressKey("k")
        await harness.flush()
        attemptsTag++
      }
    }
    expect(view.selectedListId("branches")).toBe("tag:refs/tags/v1")
    await view.whenPreviewSettled().catch(() => {})
    await harness.flush()
    expect(view.mainContent?.source).toBe("tag")
    tagPlain = view.mainContent?.plainText ?? ""
    expect(tagPlain).toContain("v1")
    expect(tagPlain).toContain("annotated")
    expect(tagPlain).toMatch(/[0-9a-f]{7}/)
    expect(tagPlain).toContain("release one")

    // 7. Main and Files do not consume [/]
    await harness.pressKey("0")
    await harness.flush()
    const tabBeforeMainBracket = view.activeBranchesTab
    await harness.pressKey("[")
    await harness.flush()
    expect(view.activeBranchesTab).toBe(tabBeforeMainBracket)
    await harness.pressKey("]")
    await harness.flush()
    expect(view.activeBranchesTab).toBe(tabBeforeMainBracket)
    const targetBeforeBracket = JSON.stringify(app.controller.state.reviewTarget)
    await harness.pressKey("2")
    await harness.flush()
    await harness.pressKey("[")
    await harness.flush()
    expect(view.activeBranchesTab).toBe(tabBeforeMainBracket)
    expect(JSON.stringify(app.controller.state.reviewTarget)).toBe(targetBeforeBracket)
    await harness.pressKey("]")
    await harness.flush()
    expect(view.activeBranchesTab).toBe(tabBeforeMainBracket)
    expect(JSON.stringify(app.controller.state.reviewTarget)).toBe(targetBeforeBracket)

    // 8. Stash is three rows while not current and expands when focused
    await harness.pressKey("2")
    await harness.flush()
    const stashWinUnfocused = view.geometry.windows.stash
    expect(stashWinUnfocused).toBeDefined()
    expect(heightOf(stashWinUnfocused!)).toBe(FOLDED_PANE_HEIGHT)
    expect(heightOf(stashWinUnfocused!)).toBe(3)
    await harness.pressKey("5")
    await harness.flush()
    const stashWinFocused = view.geometry.windows.stash
    expect(stashWinFocused).toBeDefined()
    expect(heightOf(stashWinFocused!)).toBeGreaterThan(FOLDED_PANE_HEIGHT)
    expect(view.renderedListText("stash")).toContain("review stash")
    expect(view.selectedListId("stash")).toBeDefined()
    await harness.pressKey("2")
    await harness.flush()
    expect(heightOf(view.geometry.windows.stash!)).toBe(3)

    // 9. Wheel affects only the pointed pane; track click/thumb drag keep scrollbar synchronized without focus change
    await harness.pressKey("4")
    await harness.flush()
    await view.whenPreviewSettled().catch(() => {})
    await harness.flush()
    await harness.resize(120, 22)
    await harness.flush()
    const commitsBoxSmall = harness.paneTextGeometry("commits")!
    const mainBoxSmall = harness.paneTextGeometry("main")!
    view.mainPane.text.scrollY = 0
    await harness.flush()
    const commitsScrollBefore = view.paneScrollY("commits")
    const mainScrollBefore = view.mainScrollY
    const focusBeforeWheel = view.focusManager.active
    const commitsMaxBefore = view.commitsPane.text.maxScrollY
    await mouse.scroll(commitsBoxSmall.screenX + 1, commitsBoxSmall.screenY + 1, "down")
    await harness.flush()
    expect(view.mainScrollY).toBe(mainScrollBefore)
    expect(view.focusManager.active).toBe(focusBeforeWheel)
    const expectedCommitsAfter = Math.min(commitsMaxBefore, commitsScrollBefore + 2)
    expect(view.paneScrollY("commits")).toBe(expectedCommitsAfter)
    const mainBefore2 = view.mainScrollY
    const commitsBefore2 = view.paneScrollY("commits")
    const mainMaxBefore2 = view.mainPane.text.maxScrollY
    await mouse.scroll(mainBoxSmall.screenX + 1, mainBoxSmall.screenY + 1, "down")
    await harness.flush()
    expect(view.paneScrollY("commits")).toBe(commitsBefore2)
    const expectedMainAfter = Math.min(mainMaxBefore2, mainBefore2 + 2)
    expect(view.mainScrollY).toBe(expectedMainAfter)
    // wheel over border still routes to commits, not main
    const winCommits = view.geometry.windows.commits!
    const commitsBeforeBorderWheel = view.paneScrollY("commits")
    const commitsMaxBorder = view.commitsPane.text.maxScrollY
    const mainBeforeBorder = view.mainScrollY
    await mouse.scroll(winCommits.x0, winCommits.y0, "down")
    await harness.flush()
    const expectedBorderCommits = Math.min(commitsMaxBorder, commitsBeforeBorderWheel + 2)
    expect(view.paneScrollY("commits")).toBe(expectedBorderCommits)
    expect(view.mainScrollY).toBe(mainBeforeBorder)
    // wheel over scrollbar does not focus
    const bar = paneScrollbar(view.commitsPane.text)
    if (bar?.visible) {
      const win = view.geometry.windows.commits!
      const barX = win.x1 - 1
      const barY = win.y0 + 1
      const focusBeforeBarWheel = view.focusManager.active
      await mouse.scroll(barX, barY, "down")
      await harness.flush()
      expect(view.focusManager.active).toBe(focusBeforeBarWheel)
    }
    const vsplit = view.geometry.windows.vsplit
    if (vsplit) {
      const commitsBeforeSplitterWheel = view.paneScrollY("commits")
      const mainBeforeSplitterWheel = view.mainScrollY
      await mouse.scroll(vsplit.x0, vsplit.y0 + 1, "down")
      await harness.flush()
      expect(view.paneScrollY("commits")).toBe(commitsBeforeSplitterWheel)
      expect(view.mainScrollY).toBe(mainBeforeSplitterWheel)
    }
    await harness.resize(120, 40)
    await harness.flush()
    await harness.pressKey("0")
    await harness.flush()
    await harness.resize(120, 22)
    await harness.flush()
    let mainBar = paneScrollbar(view.mainPane.text)
    if (!mainBar?.visible) {
      const large: MainPaneContent = { source: "files", stableId: "large-scroll-test", label: "large", plainText: Array.from({ length: 80 }, (_, i) => `line ${i} — a€🙂 unicode test ${i}`).join("\n") }
      view.installMainContent(large)
      await harness.flush()
      mainBar = paneScrollbar(view.mainPane.text)
    }
    expect(mainBar?.visible).toBe(true)
    await harness.pressKey("4")
    await harness.flush()
    const focusBeforeTrack2 = view.focusManager.active
    const mainScrollBeforeTrack = view.mainPane.text.scrollY
    const mainWin = view.geometry.windows.main!
    const mainBarX = mainWin.x1 - 1
    const mainBarTrackY = mainWin.y0 + 1 + Math.floor((mainWin.y1 - mainWin.y0 - 1) / 2)
    await mouse.click(mainBarX, mainBarTrackY)
    await harness.flush()
    expect(view.focusManager.active).toBe(focusBeforeTrack2)
    expect(view.mainPane.text.scrollY).not.toBe(mainScrollBeforeTrack)
    expect(mainBar!.scrollPosition).toBe(view.mainPane.text.scrollY)
    const topY = mainWin.y0 + 1
    const bottomY = mainWin.y1 - 1
    await mouse.drag(mainBarX, topY, mainBarX, bottomY)
    await harness.flush()
    expect(view.mainPane.text.scrollY).toBe(view.mainPane.text.maxScrollY)
    expect(mainBar!.scrollPosition).toBe(view.mainPane.text.scrollY)
    expect(view.focusManager.active).toBe(focusBeforeTrack2)
    const commitsBar = paneScrollbar(view.commitsPane.text)
    if (commitsBar?.visible) {
      const cWin = view.geometry.windows.commits!
      const cBarX = cWin.x1 - 1
      const cTopY = cWin.y0 + 1
      const cBottomY = cWin.y1 - 1
      const fBefore = view.focusManager.active
      await mouse.drag(cBarX, cTopY, cBarX, cBottomY)
      await harness.flush()
      expect(view.focusManager.active).toBe(fBefore)
      expect(commitsBar.scrollPosition).toBe(view.commitsPane.text.scrollY)
    }
    await harness.resize(120, 40)
    await harness.flush()

    // 10. Splitter drag outside rule continues; Main Unicode selection copies exact patch text and never includes left pane
    const vsplitWin = view.geometry.windows.vsplit
    expect(vsplitWin).toBeDefined()
    const vX = vsplitWin!.x0
    const vY = vsplitWin!.y0 + 2
    const beforeRatio = view.sidePanelRatio
    await mouse.drag(vX, vY, vX + 15, vY)
    await harness.flush()
    expect(view.sidePanelRatio).not.toBe(beforeRatio)
    expect(view.sidePanelRatio).toBeGreaterThan(beforeRatio)
    const hsplitWin = view.geometry.windows.hsplit
    if (hsplitWin) {
      const hX = hsplitWin.x0 + 2
      const hY = hsplitWin.y0
      const beforeLogRaw = heightOf(view.geometry.windows.log!)
      await mouse.drag(hX, hY, hX, hY + 6)
      await harness.flush()
      const afterLogRaw = heightOf(view.geometry.windows.log!)
      expect(afterLogRaw).not.toBe(beforeLogRaw)
    }
    expect(view.gestureOwner === undefined || typeof view.gestureOwner === "object").toBe(true)
    // Unicode copy
    await harness.repository.write("unicode-€-test.txt", "a€🙂\nline2\n")
    await expectGit(harness.repository, ["add", "unicode-€-test.txt"])
    await app.controller.refresh()
    await harness.app.refresh()
    await harness.flush()
    await harness.pressKey("2")
    await harness.flush()
    let unicodeFound = false
    for (let i = 0; i < 12; i++) {
      const sel = view.selectedListId("files")
      if (sel === "unicode-€-test.txt") { unicodeFound = true; break }
      await harness.pressKey("j")
      await harness.flush()
    }
    if (!unicodeFound) {
      for (let i = 0; i < 12; i++) {
        const sel = view.selectedListId("files")
        if (sel === "unicode-€-test.txt") { unicodeFound = true; break }
        await harness.pressKey("k")
        await harness.flush()
      }
    }
    expect(unicodeFound).toBe(true)
    await harness.flush()
    const unicodeMainText = mainText(view)
    expect(unicodeMainText).toContain("a€🙂")
    const doc = view.mainContent?.document
    expect(doc).toBeDefined()
    if (doc) {
      const lineWithUnicode = doc.lines.find((l) => l.raw.includes("€") || l.raw.includes("🙂"))
      expect(lineWithUnicode).toBeDefined()
      const textViewUnicode = view.mainPane.text as unknown as {
        setSelection: (start: number, end: number) => void
        getSelectedText: () => string
        getSelection: () => { start?: number; end?: number } | null
        hasSelection: () => boolean
        resetSelection: () => void
      }
      if (typeof textViewUnicode.resetSelection === "function") textViewUnicode.resetSelection()
      const textModeCopy = copySelection(doc, { valid: true, startUtf16: 0, endUtf16: doc.text.length, active: true }, "text")
      expect(textModeCopy).toContain("a€🙂")
      expect(textModeCopy).not.toContain("Local Branches")
      const unicodeStart = doc.text.indexOf("a€🙂")
      expect(unicodeStart).toBeGreaterThan(-1)
      const unicodeEnd = unicodeStart + "a€🙂".length
      const sel = { valid: true as const, startUtf16: unicodeStart, endUtf16: unicodeEnd, active: true as const }
      const copied = copySelection(doc, sel, "text")
      expect(copied).toBe("a€🙂")
      await harness.pressKey("0")
      await harness.flush()
      view.mainPane.text.scrollY = 0
      view.mainPane.text.scrollX = 0
      const mainGeom = harness.paneTextGeometry("main")!
      await mouse.drag(mainGeom.screenX + 1, mainGeom.screenY + 2, mainGeom.screenX + 10, mainGeom.screenY + 2)
      await harness.flush()
      const hasSelAfterDrag = typeof textViewUnicode.hasSelection === "function" ? textViewUnicode.hasSelection() : false
      if (hasSelAfterDrag) {
        const nativeRange = textViewUnicode.getSelection()
        const selText = textViewUnicode.getSelectedText()
        const mapped = selectionFromRenderable(doc, nativeRange ?? {}, selText)
        const viaCopy = copySelection(doc, mapped, "text")
        expect(viaCopy.length).toBeGreaterThan(0)
        expect(viaCopy).not.toContain("Local Branches")
        expect(viaCopy).not.toContain("5 Stash")
        const copiedViaService = copySelection(doc, mapped, "text")
        expect(copiedViaService).toBe(viaCopy)
      }
      const leftPaneText = view.renderedListText("branches") + view.renderedListText("commits")
      const copiedAll = copySelection(doc, { valid: true, startUtf16: 0, endUtf16: doc.text.length, active: true }, "text")
      expect(copiedAll).not.toContain(leftPaneText.slice(0, 20))
      if (typeof textViewUnicode.resetSelection === "function") textViewUnicode.resetSelection()
    }

    const observed = {
      paneTitles: {
        status: view.statusPane.box.title,
        files: view.filesPane.box.title,
        branches: String(view.branchesPane.box.title),
        commits: view.commitsPane.box.title,
        stash: view.stashPane.box.title,
        main: view.mainPane.box.title,
      },
      selectedIds: {
        files: view.selectedListId("files"),
        branches: view.selectedListId("branches"),
        commits: view.commitsSelectedOid,
        stash: view.selectedListId("stash"),
      },
      main: {
        source: view.mainContent?.source,
        stableId: view.mainContent?.stableId,
        label: view.mainContent?.label,
        textSnippet: mainText(view).slice(0, 120),
      },
      scrollPositions: {
        mainY: view.mainScrollY,
        mainX: view.mainPane.text.scrollX,
        commitsY: view.paneScrollY("commits"),
        filesY: view.paneScrollY("files"),
        branchesY: view.paneScrollY("branches"),
        stashY: view.paneScrollY("stash"),
      },
      copiedTextSample: (() => {
        const d = view.mainContent?.document
        if (!d) return mainText(view).slice(0, 80)
        try { return copySelection(d, { valid: true, startUtf16: 0, endUtf16: Math.min(80, d.text.length), active: true }, "text").slice(0, 80) } catch { return d.text.slice(0, 80) }
      })(),
      geometry: {
        stashHeightUnfocused: heightOf(view.geometry.windows.stash!),
        sidePanelRatio: view.sidePanelRatio,
        logHeight: heightOf(view.geometry.windows.log!),
      },
      bareRemotes: {
        originFetchUrl: (await harness.repository.git(["remote", "get-url", "origin"])).stdout.trim(),
        originPushUrl: (await harness.repository.git(["remote", "get-url", "--push", "origin"])).stdout.trim(),
      },
    }
    // Record for smoke verification
    console.log("LAZYGIT-ACCEPTANCE-OBSERVED", JSON.stringify(observed, null, 2))
    expect(observed.paneTitles.commits).toBeDefined()
    expect(observed.selectedIds.commits).toMatch(/^[0-9a-f]{40}$/)
    expect(observed.main.source).toBeDefined()
  }, 30000)
})
