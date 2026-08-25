import { describe, expect, test } from "bun:test"
import {
  COLLAPSED_ARROW,
  EXPANDED_ARROW,
  buildFlatTreeFromFiles,
  buildTreeFromFiles,
  collapseAllFileTree,
  collapseAllPaths,
  createFileTreeState,
  emptyCollapsedPaths,
  everyFileInNode,
  expandAllFileTree,
  expandFileTreeToPath,
  expandToPath,
  fileTreeRows,
  flattenNode,
  forEachFile,
  isFileNode,
  isPathCollapsed,
  nodeLeaves,
  nodeName,
  nodePath,
  nodeSortComparator,
  someFileInNode,
  renderFileTreeRows,
  setFileTreeItems,
  splitFileTreePath,
  toggleCollapsedPath,
  toggleFileTreeCollapsedPath,
  toggleFileTreeMode,
  type FileTreeAccessors,
  type FileTreeRow,
  type FileTreeSortOrder,
} from "../../src/ui/file-tree"

type TestFile = {
  readonly path: string
  readonly previousPath?: string
  readonly shortStatus: string
  readonly tracked: boolean
  readonly conflicted: boolean
}

function file(path: string, extra: Partial<Omit<TestFile, "path">> = {}): TestFile {
  return { path, shortStatus: extra.shortStatus ?? "M ", tracked: extra.tracked ?? true, conflicted: extra.conflicted ?? false, ...(extra.previousPath !== undefined ? { previousPath: extra.previousPath } : {}) }
}

const accessors: FileTreeAccessors<TestFile> = {
  getPath: (item) => item.path,
  getPreviousPath: (item) => item.previousPath,
  getShortStatus: (item) => item.shortStatus,
  hasMergeConflicts: (item) => item.conflicted,
  isTracked: (item) => item.tracked,
}

/** Reconstructs lazygit's rendered line so the tests read like its own presentation output. */
function line(row: FileTreeRow<unknown>): string {
  const prefix = row.kind === "directory" ? `${row.arrow} ` : `${row.status ?? ""} `
  return `${row.indentation}${prefix}${row.name}`
}

function lines(rows: readonly FileTreeRow<unknown>[]): string[] {
  return rows.map(line)
}

function rowsFor(paths: readonly TestFile[], options: { showRootItem?: boolean; collapsed?: ReadonlySet<string> } = {}): readonly FileTreeRow<TestFile>[] {
  const showRootItem = options.showRootItem ?? false
  const root = buildTreeFromFiles(paths, { ...accessors, showRootItem })
  return renderFileTreeRows(root, options.collapsed ?? emptyCollapsedPaths(), { ...accessors, showRootItem })
}

describe("path splitting", () => {
  test("prefixes the root item only when it is shown", () => {
    expect(splitFileTreePath("dir/a", false)).toEqual(["dir", "a"])
    expect(splitFileTreePath("dir/a", true)).toEqual([".", "dir", "a"])
  })
})

describe("tree building", () => {
  test("an empty file list produces an empty tree", () => {
    const root = buildTreeFromFiles<TestFile>([], accessors)
    expect(root.children).toEqual([])
    expect(renderFileTreeRows(root, emptyCollapsedPaths(), accessors)).toEqual([])
  })

  test("skips the root item when there is only one file at top level", () => {
    const root = buildTreeFromFiles([file("a")], { ...accessors, showRootItem: true })
    expect(root.children.map((child) => child.path)).toEqual(["./a"])
    expect(lines(renderFileTreeRows(root, emptyCollapsedPaths(), { ...accessors, showRootItem: true }))).toEqual(["M  a"])
  })

  test("the skip-the-root-item branch also drops a lone directory of a single file", () => {
    // lazygit's guard is `i == 0 && len(files) == 1 && len(splitPath) == 2`, which
    // is blind to showRootItem: one file one level deep loses its directory row
    // and shows its full path instead.
    const root = buildTreeFromFiles([file("dir/a")], accessors)
    expect(root.children.map((child) => child.path)).toEqual(["dir/a"])
    expect(lines(renderFileTreeRows(root, emptyCollapsedPaths(), accessors))).toEqual(["M  dir/a"])
  })

  test("keeps the root item when more than one file sits at top level", () => {
    const root = buildTreeFromFiles([file("a"), file("b")], { ...accessors, showRootItem: true })
    expect(root.children.map((child) => child.path)).toEqual(["."])
    expect(lines(renderFileTreeRows(root, emptyCollapsedPaths(), { ...accessors, showRootItem: true }))).toEqual([
      `${EXPANDED_ARROW} /`,
      "  M  a",
      "  M  b",
    ])
  })

  test("groups files that share a directory", () => {
    expect(lines(rowsFor([file("dir1/b"), file("dir1/a")]))).toEqual([`${EXPANDED_ARROW} dir1`, "  M  a", "  M  b"])
  })

  test("treats paths that are prefixes of each other as siblings", () => {
    expect(lines(rowsFor([file("a/bc"), file("a/b")]))).toEqual([`${EXPANDED_ARROW} a`, "  M  b", "  M  bc"])
  })
})

describe("compression", () => {
  test("a chain of single-child directories collapses into one row", () => {
    const root = buildTreeFromFiles([file("a/b/file")], accessors)
    expect(root.children).toHaveLength(1)
    expect(root.children[0]!.path).toBe("a/b")
    expect(root.children[0]!.compressionLevel).toBe(1)
    expect(lines(renderFileTreeRows(root, emptyCollapsedPaths(), accessors))).toEqual([`${EXPANDED_ARROW} a/b`, "  M  file"])
  })

  test("compression level counts every squashed directory", () => {
    const root = buildTreeFromFiles([file("a/b/c/d/e/file")], accessors)
    expect(root.children[0]!.path).toBe("a/b/c/d/e")
    expect(root.children[0]!.compressionLevel).toBe(4)
    expect(lines(renderFileTreeRows(root, emptyCollapsedPaths(), accessors))).toEqual([`${EXPANDED_ARROW} a/b/c/d/e`, "  M  file"])
  })

  test("stops compressing where a directory gains a second child", () => {
    const root = buildTreeFromFiles([file("a/b/c/one"), file("a/b/d/two")], accessors)
    expect(root.children[0]!.path).toBe("a/b")
    expect(root.children[0]!.compressionLevel).toBe(1)
    expect(lines(renderFileTreeRows(root, emptyCollapsedPaths(), accessors))).toEqual([
      `${EXPANDED_ARROW} a/b`,
      `  ${EXPANDED_ARROW} c`,
      "    M  one",
      `  ${EXPANDED_ARROW} d`,
      "    M  two",
    ])
  })

  test("the shown root item is compressed into its only child directory", () => {
    const root = buildTreeFromFiles([file("dir1/a"), file("dir1/b")], { ...accessors, showRootItem: true })
    expect(root.children[0]!.path).toBe("./dir1")
    expect(root.children[0]!.compressionLevel).toBe(1)
  })
})

describe("tree depth versus visual depth", () => {
  test("indentation follows visual depth while names are truncated at tree depth", () => {
    const rows = rowsFor([file("dir1/dir3/a"), file("dir2/dir4/b")])
    expect(rows.map((row) => [row.name, row.treeDepth, row.visualDepth, row.indentation.length])).toEqual([
      ["dir1/dir3", 0, 0, 0],
      ["a", 2, 1, 2],
      ["dir2/dir4", 0, 0, 0],
      ["b", 2, 1, 2],
    ])
  })

  test("visual depth increases by one per row while tree depth jumps over compressions", () => {
    const rows = rowsFor([file("dir1/dir3/a"), file("dir2/dir4/b")], { showRootItem: true })
    expect(rows.map((row) => row.visualDepth)).toEqual([0, 1, 2, 1, 2])
    expect(rows.map((row) => row.treeDepth)).toEqual([0, 1, 3, 1, 3])
    expect(rows.map((row) => row.name)).toEqual(["/", "dir1/dir3", "a", "dir2/dir4", "b"])
  })

  test("indentation is two spaces per visual depth", () => {
    const rows = rowsFor([file("a/b/c/one"), file("a/b/d/two")])
    expect(rows.map((row) => row.indentation)).toEqual(["", "  ", "    ", "  ", "    "])
  })
})

describe("row contents", () => {
  test("file rows carry the two-character short status and the payload", () => {
    const rows = rowsFor([file("dir/a", { shortStatus: " M" }), file("dir/b", { shortStatus: "??", tracked: false })])
    const fileRows = rows.filter((row) => row.kind === "file")
    expect(fileRows.map((row) => row.status)).toEqual([" M", "??"])
    expect(fileRows.map((row) => row.payload?.path)).toEqual(["dir/a", "dir/b"])
    expect(rows[0]!.payload).toBeUndefined()
  })

  test("directory rows show the expanded arrow, and the collapsed arrow when collapsed", () => {
    const expanded = rowsFor([file("dir/a"), file("dir/b")])
    expect(expanded[0]!.arrow).toBe(EXPANDED_ARROW)
    expect(expanded[0]!.collapsed).toBe(false)
    const collapsed = rowsFor([file("dir/a"), file("dir/b")], { collapsed: new Set(["dir"]) })
    expect(collapsed[0]!.arrow).toBe(COLLAPSED_ARROW)
    expect(collapsed[0]!.collapsed).toBe(true)
  })

  test("a collapsed directory hides its whole subtree", () => {
    const files = [file("dir/sub/a"), file("dir/sub/b"), file("top")]
    expect(lines(rowsFor(files))).toEqual([
      `${EXPANDED_ARROW} dir/sub`,
      "  M  a",
      "  M  b",
      "M  top",
    ])
    expect(lines(rowsFor(files, { collapsed: new Set(["dir/sub"]) }))).toEqual([`${COLLAPSED_ARROW} dir/sub`, "M  top"])
  })

  test("renamed files show the previous name, shortened when the parent directory is unchanged", () => {
    const rows = rowsFor([file("dir/new", { previousPath: "dir/old", shortStatus: "R " }), file("dir/moved", { previousPath: "elsewhere/moved", shortStatus: "R " })])
    expect(rows.filter((row) => row.kind === "file").map((row) => row.name)).toEqual(["elsewhere/moved → moved", "old → new"])
  })

  test("ids distinguish a directory from a file with the same path", () => {
    const rows = rowsFor([file("a/b"), file("a/c")])
    expect(rows.map((row) => row.id)).toEqual(["dir:a", "file:a/b", "file:a/c"])
    const withRoot = rowsFor([file("a/b"), file("a/c")], { showRootItem: true })
    expect(withRoot.map((row) => row.id)).toEqual(["dir:./a", "file:./a/b", "file:./a/c"])
  })

  test("rows expose the node so callers can aggregate over a directory's leaves", () => {
    const rows = rowsFor([file("dir/a", { conflicted: true }), file("dir/b")])
    expect(nodeLeaves(rows[0]!.node).map((leaf) => leaf.payload?.path)).toEqual(["dir/a", "dir/b"])
    expect(isFileNode(rows[0]!.node)).toBe(false)
    expect(isFileNode(rows[1]!.node)).toBe(true)
  })
})

describe("sorting", () => {
  // "Dir" (uppercase D), "b-file" and "Z-file" separate every combination:
  //   ASCII order:            D(68) < Z(90) < b(98)
  //   case-insensitive order: b < d < z
  const files = [file("Dir/inner"), file("b-file"), file("Z-file")]

  const scenarios: readonly { sortOrder: FileTreeSortOrder; caseSensitive: boolean; expected: readonly string[] }[] = [
    { sortOrder: "mixed", caseSensitive: true, expected: ["Dir", "Dir/inner", "Z-file", "b-file"] },
    { sortOrder: "mixed", caseSensitive: false, expected: ["b-file", "Dir", "Dir/inner", "Z-file"] },
    { sortOrder: "filesFirst", caseSensitive: true, expected: ["Z-file", "b-file", "Dir", "Dir/inner"] },
    { sortOrder: "filesFirst", caseSensitive: false, expected: ["b-file", "Z-file", "Dir", "Dir/inner"] },
    { sortOrder: "foldersFirst", caseSensitive: true, expected: ["Dir", "Dir/inner", "Z-file", "b-file"] },
    { sortOrder: "foldersFirst", caseSensitive: false, expected: ["Dir", "Dir/inner", "b-file", "Z-file"] },
  ]

  for (const scenario of scenarios) {
    test(`${scenario.sortOrder}, case sensitive: ${scenario.caseSensitive}`, () => {
      const options = { ...accessors, sortOrder: scenario.sortOrder, sortCaseSensitive: scenario.caseSensitive }
      const root = buildTreeFromFiles(files, options)
      const rows = renderFileTreeRows(root, emptyCollapsedPaths(), options)
      expect(rows.map((row) => row.path)).toEqual([...scenario.expected])
    })
  }

  test("the comparator sorts on the internal path", () => {
    const cmp = nodeSortComparator<TestFile>("mixed", true)
    const a = { path: "./a", children: [], compressionLevel: 0 }
    const b = { path: "./b", children: [], compressionLevel: 0 }
    expect(cmp(a, b)).toBeLessThan(0)
    expect(cmp(b, a)).toBeGreaterThan(0)
    expect(cmp(a, a)).toBe(0)
  })
})

describe("flat mode", () => {
  test("flattens the tree to its leaves", () => {
    const root = buildFlatTreeFromFiles([file("dir1/b"), file("dir1/a"), file("top")], accessors)
    expect(root.children.map((child) => child.path)).toEqual(["dir1/a", "dir1/b", "top"])
    expect(lines(renderFileTreeRows(root, emptyCollapsedPaths(), accessors))).toEqual(["M  dir1/a", "M  dir1/b", "M  top"])
  })

  test("shows full paths at visual depth zero even when the root item is shown", () => {
    const root = buildFlatTreeFromFiles([file("dir1/a"), file("dir2/b")], { ...accessors, showRootItem: true })
    const rows = renderFileTreeRows(root, emptyCollapsedPaths(), { ...accessors, showRootItem: true })
    expect(rows.map((row) => row.name)).toEqual(["dir1/a", "dir2/b"])
    expect(rows.map((row) => row.visualDepth)).toEqual([0, 0])
  })

  test("puts merge conflicts first, then tracked files, then untracked ones", () => {
    const files = [
      file("a2", { tracked: false }),
      file("a1", { tracked: false }),
      file("c2", { conflicted: true }),
      file("c1", { conflicted: true }),
      file("b2", { tracked: true }),
      file("b1", { tracked: true }),
    ]
    const root = buildFlatTreeFromFiles(files, { ...accessors, showRootItem: true })
    expect(root.children.map((child) => child.payload?.path)).toEqual(["c1", "c2", "b1", "b2", "a1", "a2"])
  })

  test("an empty file list flattens to nothing", () => {
    expect(buildFlatTreeFromFiles<TestFile>([], accessors).children).toEqual([])
  })
})

describe("collapsed paths", () => {
  test("toggling a path adds it, then removes it", () => {
    const collapsed = toggleCollapsedPath(emptyCollapsedPaths(), "dir")
    expect(isPathCollapsed(collapsed, "dir")).toBe(true)
    expect(isPathCollapsed(toggleCollapsedPath(collapsed, "dir"), "dir")).toBe(false)
  })

  test("expanding to a path expands every directory along the way", () => {
    const collapsed = new Set(["a", "a/b", "a/b/c", "other"])
    const expanded = expandToPath(collapsed, "a/b/c/file")
    expect([...expanded]).toEqual(["other"])
  })

  test("collapse all collapses every visible directory and expand all clears them", () => {
    const root = buildTreeFromFiles([file("dir/sub/a"), file("dir/other/b"), file("top")], accessors)
    const collapsed = collapseAllPaths(root, emptyCollapsedPaths())
    expect([...collapsed].sort()).toEqual(["dir", "dir/other", "dir/sub"])
    expect(lines(renderFileTreeRows(root, collapsed, accessors))).toEqual([`${COLLAPSED_ARROW} dir`, "M  top"])
  })
})

describe("file tree state", () => {
  const files = [file("dir/sub/a"), file("dir/sub/b"), file("top")]

  test("starts in tree mode and renders the tree", () => {
    const state = createFileTreeState(files, accessors)
    expect(state.mode).toBe("tree")
    expect(lines(fileTreeRows(state))).toEqual([`${EXPANDED_ARROW} dir/sub`, "  M  a", "  M  b", "M  top"])
  })

  test("toggling the mode switches between tree and flat rendering", () => {
    const flat = toggleFileTreeMode(createFileTreeState(files, accessors))
    expect(flat.mode).toBe("flat")
    expect(lines(fileTreeRows(flat))).toEqual(["M  dir/sub/a", "M  dir/sub/b", "M  top"])
    expect(toggleFileTreeMode(flat).mode).toBe("tree")
  })

  test("toggling a directory hides its subtree and leaves other rows alone", () => {
    const state = toggleFileTreeCollapsedPath(createFileTreeState(files, accessors), "dir/sub")
    expect(lines(fileTreeRows(state))).toEqual([`${COLLAPSED_ARROW} dir/sub`, "M  top"])
  })

  test("collapse all then expand all round-trips", () => {
    const state = createFileTreeState(files, accessors)
    const collapsed = collapseAllFileTree(state)
    expect(fileTreeRows(collapsed).map((row) => row.id)).toEqual(["dir:dir/sub", "file:top"])
    expect(fileTreeRows(expandAllFileTree(collapsed))).toEqual(fileTreeRows(state))
  })

  test("expanding to a path reveals a file inside a collapsed directory", () => {
    const state = toggleFileTreeCollapsedPath(createFileTreeState(files, accessors), "dir/sub")
    expect(fileTreeRows(expandFileTreeToPath(state, "dir/sub/a")).map((row) => row.id)).toEqual([
      "dir:dir/sub",
      "file:dir/sub/a",
      "file:dir/sub/b",
      "file:top",
    ])
  })

  test("flattening a tree skips the children of collapsed directories", () => {
    const state = createFileTreeState(files, accessors)
    expect(flattenNode(state.root, state.collapsedPaths).map((node) => node.path)).toEqual(["", "dir/sub", "dir/sub/a", "dir/sub/b", "top"])
    expect(flattenNode(state.root, new Set(["dir/sub"])).map((node) => node.path)).toEqual(["", "dir/sub", "top"])
  })

  test("replacing the items keeps the mode and the collapsed paths", () => {
    const state = toggleFileTreeCollapsedPath(createFileTreeState(files, accessors), "dir/sub")
    const next = setFileTreeItems(state, [...files, file("dir/sub/c")])
    expect(next.mode).toBe("tree")
    expect(lines(fileTreeRows(next))).toEqual([`${COLLAPSED_ARROW} dir/sub`, "M  top"])
    expect(lines(fileTreeRows(toggleFileTreeCollapsedPath(next, "dir/sub")))).toEqual([
      `${EXPANDED_ARROW} dir/sub`,
      "  M  a",
      "  M  b",
      "  M  c",
      "M  top",
    ])
  })
})

describe("node helpers", () => {
  const root = buildTreeFromFiles([file("dir/a", { conflicted: true }), file("dir/b"), file("top")], { ...accessors, showRootItem: true })

  test("logical paths drop the root item prefix while internal paths keep it", () => {
    const dir = root.children[0]!.children[0]!
    expect(dir.path).toBe("./dir")
    expect(nodePath(dir)).toBe("dir")
    expect(nodeName(dir)).toBe("dir")
  })

  test("visits every file beneath a node", () => {
    const paths: string[] = []
    forEachFile(root, (item) => paths.push(item.path))
    expect(paths).toEqual(["dir/a", "dir/b", "top"])
  })

  test("some and every apply a predicate to a subtree's files", () => {
    const dir = root.children[0]!.children[0]!
    expect(someFileInNode(dir, (item) => item.conflicted)).toBe(true)
    expect(everyFileInNode(dir, (item) => item.conflicted)).toBe(false)
    expect(everyFileInNode(dir, (item) => item.tracked)).toBe(true)
  })
})

describe("generic over the leaf payload", () => {
  type CommitFile = { readonly newPath: string; readonly changeStatus: string }

  test("works with a payload that is not a changed file", () => {
    const commitFiles: readonly CommitFile[] = [
      { newPath: "src/ui/list-view.ts", changeStatus: "M" },
      { newPath: "src/ui/file-tree.ts", changeStatus: "A" },
    ]
    const options = { getPath: (item: CommitFile) => item.newPath, getShortStatus: (item: CommitFile) => item.changeStatus }
    const root = buildTreeFromFiles(commitFiles, options)
    const rows = renderFileTreeRows(root, emptyCollapsedPaths(), options)
    expect(lines(rows)).toEqual([`${EXPANDED_ARROW} src/ui`, "  A file-tree.ts", "  M list-view.ts"])
    expect(rows[1]!.payload?.changeStatus).toBe("A")
  })
})
