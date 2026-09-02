import { afterEach, describe, expect, test } from "bun:test"
import { createShellHarness, type ShellHarness } from "../helpers/shell-harness"
import { createListState, selectListRow, setListRows } from "../../src/ui/list-view"
import { createFilesTreeState, filesTreeRows } from "../../src/ui/panes/files-pane"
import { localBranchRows } from "../../src/ui/panes/branches-pane"
import { tagRows } from "../../src/ui/panes/tags-pane"
import { stashRows } from "../../src/ui/panes/stash-pane"
import { commitFileRows } from "../../src/ui/panes/commit-files-pane"
import type { AppModel } from "../../src/app/model"
import type { CommitDetails } from "../../src/domain/commit"

type ListViewProbe = {
  selectedListId(pane: string): string | undefined
  selectedListRange(pane: string): { readonly startId?: string; readonly endId?: string; readonly mode: string }
  renderedListText(pane: string): string
  selectedRowHasBackground(pane: string): boolean
}

describe("full-row list selection", () => {
  let harness: ShellHarness | undefined
  afterEach(async () => {
    await harness?.cleanup()
    harness = undefined
  })

  for (const pane of ["files", "branches", "commits", "stash"] as const) {
    test(`${pane} j moves selectedId, no arrow marker, bgBlue focused else unfocused`, async () => {
      harness = await createShellHarness({ commits: ["alpha commit", "beta commit", "gamma commit"], stash: true })
      const view = harness.app.view
      expect(view).toBeDefined()
      const typed = view as unknown as ListViewProbe
      expect(typeof typed.selectedListId).toBe("function")
      expect(typeof typed.renderedListText).toBe("function")
      expect(typeof typed.selectedRowHasBackground).toBe("function")

      await harness.pressKey(String({ files: 2, branches: 3, commits: 4, stash: 5 }[pane]))
      await harness.flush()
      await harness.pressKey("j")
      await harness.flush()
      expect(typed.selectedListId(pane)).toBeDefined()
      expect(typed.renderedListText(pane)).not.toMatch(/^[>▸]/m)
      expect(typed.selectedRowHasBackground(pane)).toBe(true)
      await harness.pressKey("0")
      await harness.flush()
      expect(typed.selectedRowHasBackground(pane)).toBe(false)
    })
  }

  test("v plus j expands a focused side-list range", async () => {
    harness = await createShellHarness({ commits: ["alpha commit", "beta commit", "gamma commit"] })
    const view = harness.app.view as unknown as ListViewProbe
    await harness.pressKey("4")
    const anchorId = view.selectedListId("commits")
    expect(anchorId).toBeDefined()
    await harness.pressKey("v")
    await harness.pressKey("j")
    const range = view.selectedListRange("commits")
    expect(range.mode).toBe("sticky")
    expect(range.startId).toBe(anchorId)
    expect(range.endId).toBe(view.selectedListId("commits"))
    expect(range.endId).not.toBe(anchorId)
  })

  test("ordinary j cancels a shifted range", async () => {
    harness = await createShellHarness({ commits: ["alpha commit", "beta commit", "gamma commit"] })
    const view = harness.app.view as unknown as ListViewProbe
    await harness.pressKey("4")
    await harness.pressKey("ARROW_DOWN", { shift: true })
    expect(view.selectedListRange("commits").mode).toBe("non-sticky")
    await harness.pressKey("j")
    expect(view.selectedListRange("commits").mode).toBe("none")
  })

  test("direct click clears an active range", async () => {
    harness = await createShellHarness({ commits: ["alpha commit", "beta commit", "gamma commit"] })
    const view = harness.app.view as unknown as ListViewProbe
    await harness.pressKey("4")
    await harness.pressKey("v")
    await harness.pressKey("j")
    expect(view.selectedListRange("commits").mode).toBe("sticky")
    const geometry = harness.paneTextGeometry("commits")
    expect(geometry).toBeDefined()
    await harness.mockMouse.click(geometry!.screenX, geometry!.screenY)
    await harness.flush()
    expect(view.selectedListRange("commits").mode).toBe("none")
  })

  test("refresh preserves both stable range endpoints", async () => {
    harness = await createShellHarness({ commits: ["alpha commit", "beta commit", "gamma commit"] })
    const view = harness.app.view as unknown as ListViewProbe
    await harness.pressKey("4")
    await harness.pressKey("v")
    await harness.pressKey("j")
    const before = view.selectedListRange("commits")
    await harness.app.refresh()
    await harness.flush()
    expect(view.selectedListRange("commits")).toEqual(before)
  })

  test("drag paints the inclusive list range", async () => {
    harness = await createShellHarness({ commits: ["alpha commit", "beta commit", "gamma commit"] })

    const view = harness.app.view as unknown as ListViewProbe
    await harness.pressKey("4")
    const geometry = harness.paneTextGeometry("commits")
    expect(geometry).toBeDefined()
    const firstId = view.selectedListId("commits")
    expect(firstId).toBeDefined()
    await harness.drag(geometry!.screenX, geometry!.screenY, geometry!.screenX, geometry!.screenY + 2)
    const range = view.selectedListRange("commits")
    expect(range.mode).toBe("non-sticky")
    expect(range.startId).toBe(firstId)
    expect(range.endId).toBe(view.selectedListId("commits"))
    expect(range.endId).not.toBe(firstId)
  })
  test("Files refresh preserves range after endpoint focus synchronization", async () => {
    harness = await createShellHarness({
      setup: async (repository) => {
        await repository.write("a.txt", "a\n")
        await repository.write("b.txt", "b\n")
        await repository.git(["add", "a.txt", "b.txt"])
        await repository.git(["commit", "-m", "base"])
        await repository.write("a.txt", "aa\n")
        await repository.write("b.txt", "bb\n")
      },
    })
    const view = harness.app.view as unknown as ListViewProbe
    await harness.pressKey("2")
    await harness.pressKey("j")
    await harness.pressKey("v")
    await harness.pressKey("ARROW_DOWN", { shift: true })
    const before = view.selectedListRange("files")
    expect(before.mode).toBe("sticky")
    await harness.app.refresh()
    await harness.flush()
    expect(view.selectedListRange("files")).toEqual(before)
  })

  test("empty has no selection", async () => {
    const stashHarness = await createShellHarness({ stash: false })
    const stashView = stashHarness.app.view as unknown as ListViewProbe
    const emptyState = createListState([])
    expect(emptyState.selectedId).toBeUndefined()
    expect(stashView.selectedListId("stash")).toBeUndefined()
    expect(stashView.renderedListText("stash")).not.toMatch(/^[>▸]/m)
    await stashHarness.cleanup()
    const emptyFilesModel = { files: [], reviewStatuses: {}, reviewTarget: { kind: "working-tree", scope: "all" } } as unknown as AppModel
    const rows = filesTreeRows(createFilesTreeState(emptyFilesModel), emptyFilesModel)
    expect(rows.length).toBe(0)
    const state = createListState(rows, rows.length === 0 ? [{ kind: "message", text: "No changed files" }] : undefined)
    expect(state.selectedId).toBeUndefined()
  })

  test("refresh removes selected item retains numeric index clamping for files", () => {
    const base: AppModel = {
      repositoryRoot: "/tmp",
      branch: "main",
      reviewTarget: { kind: "working-tree", scope: "all" } as const,
      files: [
        { path: "a.txt", indexStatus: "M", worktreeStatus: "M", untracked: false, additions: 1, deletions: 0, conflicted: false },
        { path: "b.txt", indexStatus: "M", worktreeStatus: "M", untracked: false, additions: 1, deletions: 0, conflicted: false },
        { path: "c.txt", indexStatus: "M", worktreeStatus: "M", untracked: false, additions: 1, deletions: 0, conflicted: false },
      ],
      patches: [],
      rawPatchSections: [],
      reviewStatuses: {},
      loading: false,
      commandLog: [],
      title: "t",
    } as unknown as AppModel
    const rowsFor = (m: AppModel) => filesTreeRows(createFilesTreeState(m), m)
    const rows = rowsFor(base)
    expect(rows.map((r) => r.id)).toEqual(["dir:.", "file:./a.txt", "file:./b.txt", "file:./c.txt"])
    let state = createListState(rows)
    state = selectListRow(state, "file:./b.txt")
    expect(state.selectedIndex).toBe(2)
    const nextModel = { ...base, files: [base.files[0]!, base.files[2]!] } as AppModel
    const nextRows = rowsFor(nextModel)
    state = setListRows(state, nextRows, nextRows.length === 0 ? [{ kind: "message", text: "No changed files" }] : undefined)
    expect(state.selectedId).toBe("file:./c.txt")
    expect(state.selectedIndex).toBe(2)
    const finalModel = { ...base, files: [base.files[0]!] } as AppModel
    const finalRows = rowsFor(finalModel)
    state = setListRows(state, finalRows, finalRows.length === 0 ? [{ kind: "message", text: "No changed files" }] : undefined)
    expect(state.selectedId).toBe("file:./a.txt")
    expect(state.selectedIndex).toBe(0)
  })

  test("refresh retains index for branches", () => {
    const model = {
      branches: {
        current: "main",
        detached: false,
        localBranches: [{ name: "main", isCurrent: true }, { name: "feature", isCurrent: false }, { name: "side", isCurrent: false }],
        remotes: [],
      },
    } as unknown as AppModel
    const rows = localBranchRows(model)
    let state = createListState(rows)
    state = selectListRow(state, "local:feature")
    expect(state.selectedIndex).toBe(1)
    const nextModel = {
      branches: {
        current: "main",
        detached: false,
        localBranches: [{ name: "main", isCurrent: true }, { name: "side", isCurrent: false }],
        remotes: [],
      },
    } as unknown as AppModel
    const nextRows = localBranchRows(nextModel)
    state = setListRows(state, nextRows)
    expect(state.selectedId).toBe("local:side")
    expect(state.selectedIndex).toBe(1)
  })

  test("refresh retains index for tags", () => {
    const model = {
      tags: [
        { name: "v1", ref: "refs/tags/v1", targetOid: "abc", kind: "lightweight" },
        { name: "v2", ref: "refs/tags/v2", targetOid: "def", kind: "lightweight" },
        { name: "v3", ref: "refs/tags/v3", targetOid: "ghi", kind: "lightweight" },
      ],
    } as unknown as AppModel
    const rows = tagRows(model)
    let state = createListState(rows)
    state = selectListRow(state, "tag:refs/tags/v2")
    const nextModel = {
      tags: [
        { name: "v1", ref: "refs/tags/v1", targetOid: "abc", kind: "lightweight" },
        { name: "v3", ref: "refs/tags/v3", targetOid: "ghi", kind: "lightweight" },
      ],
    } as unknown as AppModel
    const nextRows = tagRows(nextModel)
    state = setListRows(state, nextRows)
    expect(state.selectedId).toBe("tag:refs/tags/v3")
  })

  test("refresh retains index for commits", () => {
    const rows = [{ id: "a", columns: [{ text: "a", priority: 2 }] }, { id: "b", columns: [{ text: "b", priority: 2 }] }, { id: "c", columns: [{ text: "c", priority: 2 }] }]
    let state = createListState(rows)
    state = selectListRow(state, "b")
    const nextRows = [{ id: "a", columns: [{ text: "a", priority: 2 }] }, { id: "c", columns: [{ text: "c", priority: 2 }] }]
    state = setListRows(state, nextRows)
    expect(state.selectedId).toBe("c")
    expect(state.selectedIndex).toBe(1)
  })

  test("refresh retains index for stashes", () => {
    const model = {
      stashes: [{ oid: "s1", ref: "stash@{0}", message: "m1" }, { oid: "s2", ref: "stash@{1}", message: "m2" }, { oid: "s3", ref: "stash@{2}", message: "m3" }],
    } as unknown as AppModel
    const rows = stashRows(model)
    let state = createListState(rows)
    state = selectListRow(state, "s2")
    const nextModel = {
      stashes: [{ oid: "s1", ref: "stash@{0}", message: "m1" }, { oid: "s3", ref: "stash@{2}", message: "m3" }],
    } as unknown as AppModel
    const nextRows = stashRows(nextModel)
    state = setListRows(state, nextRows, nextRows.length === 0 ? [{ kind: "message", text: "No stashes" }] : undefined)
    expect(state.selectedId).toBe("s3")
  })

  test("refresh retains index for commit files", () => {
    const details = {
      oid: "abc",
      document: {
        files: [{ newPath: "a.txt", oldPath: "a.txt", hunks: [], lines: [] }, { newPath: "b.txt", oldPath: "b.txt", hunks: [], lines: [] }, { newPath: "c.txt", oldPath: "c.txt", hunks: [], lines: [] }],
        lines: [],
        text: "",
      },
    } as unknown as CommitDetails
    const rows = commitFileRows(details)
    let state = createListState(rows)
    state = selectListRow(state, rows[1]!.id)
    const nextDetails = {
      oid: "abc",
      document: {
        files: [{ newPath: "a.txt", oldPath: "a.txt", hunks: [], lines: [] }, { newPath: "c.txt", oldPath: "c.txt", hunks: [], lines: [] }],
        lines: [],
        text: "",
      },
    } as unknown as CommitDetails
    const nextRows = commitFileRows(nextDetails)
    state = setListRows(state, nextRows, nextRows.length === 0 ? [{ kind: "message", text: "No files" }] : undefined)
    expect(state.selectedId).toBe(rows[2]!.id)
  })
})
