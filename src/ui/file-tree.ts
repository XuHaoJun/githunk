/**
 * Port of lazygit's `pkg/gui/filetree` (`build_tree.go`, `node.go`,
 * `collapsed_paths.go`, `file_tree.go`) plus the tree half of
 * `pkg/gui/presentation/files.go` (`renderAux`, `getFileLine`, `fileNameAtDepth`).
 *
 * The module is pure: it knows nothing about the renderer and nothing about a
 * particular file model. Callers supply accessors for the leaf payload (its path,
 * its previous path for renames, its short status) and get back a flat list of
 * display rows that the pane layer maps onto `ListRow`/`ListColumn`.
 *
 * Row ids are `dir:<internalPath>` for directories and `file:<internalPath>` for
 * files, so a directory never collides with a file of the same path, and ids are
 * stable across refreshes (the internal path only moves when the file does).
 */

export const EXPANDED_ARROW = "▼"
export const COLLAPSED_ARROW = "▶"

export type FileTreeSortOrder = "mixed" | "filesFirst" | "foldersFirst"
export type FileTreeMode = "tree" | "flat"

/**
 * A file or directory in the tree. `payload` is set on files only. `path` is the
 * *internal* path: the repo-relative path, prefixed with `./` when the root item
 * is shown. Use `nodePath` for the logical path to show or hand to git.
 */
export type FileTreeNode<T> = {
  readonly payload?: T | undefined
  readonly children: readonly FileTreeNode<T>[]
  readonly path: string
  /**
   * Rather than render `a/` > `b/` > `file` on three lines we render `a/b/` then
   * `file`. The compression level is the number of such squashes that produced
   * this node, and it is what makes tree depth run ahead of visual depth.
   */
  readonly compressionLevel: number
}

/** How to read a path (and optionally a rename, a status and flat-mode rank) off a leaf payload. */
export type FileTreeAccessors<T> = {
  readonly getPath: (item: T) => string
  readonly getPreviousPath?: ((item: T) => string | undefined) | undefined
  readonly getShortStatus?: ((item: T) => string) | undefined
  readonly hasMergeConflicts?: ((item: T) => boolean) | undefined
  readonly isTracked?: ((item: T) => boolean) | undefined
}

export type FileTreeOptions<T> = FileTreeAccessors<T> & {
  readonly showRootItem?: boolean | undefined
  readonly sortOrder?: FileTreeSortOrder | undefined
  readonly sortCaseSensitive?: boolean | undefined
}

/** One rendered line. Everything the pane layer needs is here; no tree walking required. */
export type FileTreeRow<T> = {
  /** `dir:<internalPath>` or `file:<internalPath>`. */
  readonly id: string
  readonly kind: "file" | "directory"
  /** Logical (repo-relative) path, without the root item's `./` prefix. */
  readonly path: string
  /** Internal path — what `toggleCollapsedPath` and friends expect. */
  readonly internalPath: string
  /** Name truncated at tree depth, with `old → new` for renames. */
  readonly name: string
  /** Depth in the real tree; drives name truncation. Compressed nodes span several. */
  readonly treeDepth: number
  /** Depth on screen; drives indentation. One per rendered level. */
  readonly visualDepth: number
  /** `"  ".repeat(visualDepth)`. */
  readonly indentation: string
  readonly collapsed: boolean
  /** `▼`/`▶` on directory rows, absent on file rows. */
  readonly arrow?: string | undefined
  /** Two-character git short status on file rows, when an accessor was supplied. */
  readonly status?: string | undefined
  /** Set on file rows only. */
  readonly payload?: T | undefined
  readonly node: FileTreeNode<T>
}

type MutableNode<T> = {
  payload?: T | undefined
  children: MutableNode<T>[]
  path: string
  compressionLevel: number
}

// --- paths ---

export function internalTreePathForFilePath(path: string, showRootItem: boolean): string {
  return showRootItem ? `./${path}` : path
}

export function splitFileTreePath(path: string, showRootItem: boolean): string[] {
  return internalTreePathForFilePath(path, showRootItem).split("/")
}

// --- nodes ---

export function isFileNode<T>(node: FileTreeNode<T>): boolean {
  return node.payload !== undefined
}

/** The logical path from the user's point of view: relative to the repo root. */
export function nodePath<T>(node: FileTreeNode<T>): string {
  return node.path.startsWith("./") ? node.path.slice(2) : node.path
}

export function nodeName<T>(node: FileTreeNode<T>): string {
  const segments = node.path.split("/")
  return segments[segments.length - 1] ?? ""
}

export function nodeLeaves<T>(node: FileTreeNode<T>): FileTreeNode<T>[] {
  if (isFileNode(node)) return [node]
  return node.children.flatMap((child) => nodeLeaves(child))
}

export function forEachFile<T>(node: FileTreeNode<T>, callback: (item: T) => void): void {
  if (node.payload !== undefined) callback(node.payload)
  for (const child of node.children) forEachFile(child, callback)
}

export function someFileInNode<T>(node: FileTreeNode<T>, predicate: (item: T) => boolean): boolean {
  if (node.payload !== undefined) return predicate(node.payload)
  return node.children.some((child) => someFileInNode(child, predicate))
}

export function everyFileInNode<T>(node: FileTreeNode<T>, predicate: (item: T) => boolean): boolean {
  if (node.payload !== undefined) return predicate(node.payload)
  return node.children.every((child) => everyFileInNode(child, predicate))
}

export function flattenNode<T>(node: FileTreeNode<T>, collapsedPaths: CollapsedPaths): FileTreeNode<T>[] {
  const result: FileTreeNode<T>[] = [node]
  if (node.children.length > 0 && !isPathCollapsed(collapsedPaths, node.path)) {
    for (const child of node.children) result.push(...flattenNode(child, collapsedPaths))
  }
  return result
}

// --- sorting ---

function compareAscii(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

export function nodeSortComparator<T>(
  sortOrder: FileTreeSortOrder,
  caseSensitive: boolean,
): (a: FileTreeNode<T>, b: FileTreeNode<T>) => number {
  const compare = caseSensitive ? compareAscii : (a: string, b: string) => compareAscii(a.toLowerCase(), b.toLowerCase())

  // The value returned when `a` is a directory and `b` is a file.
  const dirVsFileOrder = sortOrder === "foldersFirst" ? -1 : sortOrder === "filesFirst" ? 1 : 0
  if (dirVsFileOrder === 0) return (a, b) => compare(a.path, b.path)

  return (a, b) => {
    const aIsDir = !isFileNode(a)
    const bIsDir = !isFileNode(b)
    if (aIsDir !== bIsDir) return aIsDir ? dirVsFileOrder : -dirVsFileOrder
    return compare(a.path, b.path)
  }
}

function sortNode<T>(node: MutableNode<T>, compare: (a: FileTreeNode<T>, b: FileTreeNode<T>) => number): void {
  if (node.payload === undefined) node.children.sort(compare)
  for (const child of node.children) sortNode(child, compare)
}

// --- compression ---

function compressNode<T>(node: MutableNode<T>): MutableNode<T> {
  if (node.payload !== undefined) return node

  const children = node.children
  for (let i = 0; i < children.length; i++) {
    let grandchildren = children[i]!.children
    while (grandchildren.length === 1 && grandchildren[0]!.payload === undefined) {
      grandchildren[0]!.compressionLevel = children[i]!.compressionLevel + 1
      children[i] = grandchildren[0]!
      grandchildren = children[i]!.children
    }
  }

  for (let i = 0; i < children.length; i++) children[i] = compressNode(children[i]!)

  return node
}

// --- building ---

function comparatorFor<T>(options: FileTreeOptions<T>): (a: FileTreeNode<T>, b: FileTreeNode<T>) => number {
  return nodeSortComparator<T>(options.sortOrder ?? "mixed", options.sortCaseSensitive ?? false)
}

export function buildTreeFromFiles<T>(items: readonly T[], options: FileTreeOptions<T>): FileTreeNode<T> {
  const showRootItem = options.showRootItem ?? false
  const root: MutableNode<T> = { children: [], path: "", compressionLevel: 0 }
  const childrenMapsByNode = new Map<MutableNode<T>, Map<string, MutableNode<T>>>()

  for (const item of items) {
    const splitPath = splitFileTreePath(options.getPath(item), showRootItem)
    let curr = root
    for (let i = 0; i < splitPath.length; i++) {
      const isFile = i === splitPath.length - 1
      const path = splitPath.slice(0, i + 1).join("/")

      let childrenMap = childrenMapsByNode.get(curr)
      if (childrenMap === undefined) {
        childrenMap = new Map<string, MutableNode<T>>()
        childrenMapsByNode.set(curr, childrenMap)
      }

      const existing = childrenMap.get(path)
      if (existing !== undefined) {
        curr = existing
        continue
      }

      // Skip the root item when there's only one file at top level; we don't need it in that case.
      if (i === 0 && items.length === 1 && splitPath.length === 2) continue

      const child: MutableNode<T> = { children: [], path, compressionLevel: 0, ...(isFile ? { payload: item } : {}) }
      curr.children.push(child)
      childrenMap.set(path, child)
      curr = child
    }
  }

  sortNode(root, comparatorFor(options))
  compressNode(root)

  return root
}

export function buildFlatTreeFromFiles<T>(items: readonly T[], options: FileTreeOptions<T>): FileTreeNode<T> {
  const leaves = nodeLeaves(buildTreeFromFiles(items, options))

  // From top down we have merge conflict files, then tracked files, then
  // untracked files. This is the one way in which sorting differs between flat
  // mode and tree mode.
  const rank = (node: FileTreeNode<T>): number => {
    const payload = node.payload
    if (payload === undefined) return 2
    if (options.hasMergeConflicts?.(payload) === true) return 0
    if (options.isTracked?.(payload) === true) return 1
    return 2
  }
  const sorted = leaves.slice().sort((a, b) => rank(a) - rank(b))

  return { children: sorted, path: "", compressionLevel: 0 }
}

// --- collapsed paths ---

/** The set of collapsed *internal* paths. Treated as immutable; every helper returns a new set. */
export type CollapsedPaths = ReadonlySet<string>

export function emptyCollapsedPaths(): CollapsedPaths {
  return new Set<string>()
}

export function isPathCollapsed(collapsedPaths: CollapsedPaths, path: string): boolean {
  return collapsedPaths.has(path)
}

export function collapsePath(collapsedPaths: CollapsedPaths, path: string): CollapsedPaths {
  const next = new Set(collapsedPaths)
  next.add(path)
  return next
}

export function expandPath(collapsedPaths: CollapsedPaths, path: string): CollapsedPaths {
  const next = new Set(collapsedPaths)
  next.delete(path)
  return next
}

export function toggleCollapsedPath(collapsedPaths: CollapsedPaths, path: string): CollapsedPaths {
  return collapsedPaths.has(path) ? expandPath(collapsedPaths, path) : collapsePath(collapsedPaths, path)
}

/** Expands every directory along the way to `path`, so that path becomes visible. */
export function expandToPath(collapsedPaths: CollapsedPaths, path: string): CollapsedPaths {
  const segments = path.split("/")
  const next = new Set(collapsedPaths)
  for (let i = 0; i < segments.length; i++) next.delete(segments.slice(0, i + 1).join("/"))
  return next
}

/** Collapses every currently visible directory, like lazygit's `-` binding. */
export function collapseAllPaths<T>(root: FileTreeNode<T>, collapsedPaths: CollapsedPaths): CollapsedPaths {
  const next = new Set(collapsedPaths)
  // Skip the root, which is never rendered.
  for (const node of flattenNode(root, collapsedPaths).slice(1)) {
    if (!isFileNode(node)) next.add(node.path)
  }
  return next
}

/** Expands everything, like lazygit's `=` binding. */
export function expandAllPaths(): CollapsedPaths {
  return emptyCollapsedPaths()
}

// --- rendering ---

function fileNameAtDepth<T>(node: FileTreeNode<T>, depth: number, options: FileTreeOptions<T>): string {
  const splitName = node.path.split("/")
  let nameDepth = depth
  if (nameDepth === 0 && splitName[0] === ".") {
    if (splitName.length === 1) return "/"
    nameDepth = 1
  }
  const name = splitName.slice(nameDepth).join("/")

  const payload = node.payload
  if (payload === undefined) return name
  const previousPath = options.getPreviousPath?.(payload)
  if (previousPath === undefined || previousPath === "") return name

  const splitPrevName = splitFileTreePath(previousPath, options.showRootItem ?? false)
  // If the file has just been renamed inside the same directory we can shave off
  // the prefix for the previous path too. Otherwise we keep it unchanged.
  const sameParentDir =
    splitName.length === splitPrevName.length &&
    splitName.slice(0, nameDepth).join("/") === splitPrevName.slice(0, nameDepth).join("/")
  const prevName = sameParentDir ? splitPrevName.slice(nameDepth).join("/") : previousPath

  return `${prevName} → ${name}`
}

function appendRows<T>(
  node: FileTreeNode<T>,
  collapsedPaths: CollapsedPaths,
  // treeDepth is the depth of the node in the actual file tree. This differs from
  // visualDepth because some directory nodes are compressed, e.g. 'pkg/gui/blah'
  // takes up three tree depths but one visual depth. We track them separately
  // because indentation relies on visual depth whereas path truncation relies on
  // tree depth.
  treeDepth: number,
  visualDepth: number,
  options: FileTreeOptions<T>,
  out: FileTreeRow<T>[],
): void {
  const isRoot = treeDepth === -1
  const common = {
    path: nodePath(node),
    internalPath: node.path,
    name: fileNameAtDepth(node, treeDepth, options),
    treeDepth,
    visualDepth,
    indentation: "  ".repeat(Math.max(0, visualDepth)),
    node,
  }

  if (isFileNode(node)) {
    if (isRoot) return
    const payload = node.payload as T
    const status = options.getShortStatus?.(payload)
    out.push({
      ...common,
      id: `file:${node.path}`,
      kind: "file",
      collapsed: false,
      payload,
      ...(status !== undefined ? { status } : {}),
    })
    return
  }

  const collapsed = isPathCollapsed(collapsedPaths, node.path)
  if (!isRoot) {
    out.push({
      ...common,
      id: `dir:${node.path}`,
      kind: "directory",
      collapsed,
      arrow: collapsed ? COLLAPSED_ARROW : EXPANDED_ARROW,
    })
  }

  if (collapsed) return

  for (const child of node.children) {
    appendRows(child, collapsedPaths, treeDepth + 1 + node.compressionLevel, visualDepth + 1, options, out)
  }
}

export function renderFileTreeRows<T>(
  root: FileTreeNode<T>,
  collapsedPaths: CollapsedPaths,
  options: FileTreeOptions<T>,
): FileTreeRow<T>[] {
  const rows: FileTreeRow<T>[] = []
  appendRows(root, collapsedPaths, -1, -1, options, rows)
  return rows
}

// --- view model ---

/**
 * Immutable equivalent of lazygit's `FileTreeViewModel` minus the cursor: the
 * pane layer already tracks selection by row id through `ListState`.
 */
export type FileTreeState<T> = {
  readonly mode: FileTreeMode
  readonly items: readonly T[]
  readonly root: FileTreeNode<T>
  readonly collapsedPaths: CollapsedPaths
  readonly options: FileTreeOptions<T>
}

function buildRoot<T>(items: readonly T[], mode: FileTreeMode, options: FileTreeOptions<T>): FileTreeNode<T> {
  return mode === "tree" ? buildTreeFromFiles(items, options) : buildFlatTreeFromFiles(items, options)
}

export function createFileTreeState<T>(
  items: readonly T[],
  options: FileTreeOptions<T>,
  mode: FileTreeMode = "tree",
): FileTreeState<T> {
  return { mode, items, root: buildRoot(items, mode, options), collapsedPaths: emptyCollapsedPaths(), options }
}

/** Rebuilds the tree for a new set of items, keeping the mode and the collapsed paths. */
export function setFileTreeItems<T>(state: FileTreeState<T>, items: readonly T[]): FileTreeState<T> {
  return { ...state, items, root: buildRoot(items, state.mode, state.options) }
}

/** lazygit's `` ` `` binding. */
export function toggleFileTreeMode<T>(state: FileTreeState<T>): FileTreeState<T> {
  const mode: FileTreeMode = state.mode === "tree" ? "flat" : "tree"
  return { ...state, mode, root: buildRoot(state.items, mode, state.options) }
}

export function toggleFileTreeCollapsedPath<T>(state: FileTreeState<T>, internalPath: string): FileTreeState<T> {
  return { ...state, collapsedPaths: toggleCollapsedPath(state.collapsedPaths, internalPath) }
}

export function expandFileTreeToPath<T>(state: FileTreeState<T>, internalPath: string): FileTreeState<T> {
  return { ...state, collapsedPaths: expandToPath(state.collapsedPaths, internalPath) }
}

/** lazygit's `-` binding. */
export function collapseAllFileTree<T>(state: FileTreeState<T>): FileTreeState<T> {
  return { ...state, collapsedPaths: collapseAllPaths(state.root, state.collapsedPaths) }
}

/** lazygit's `=` binding. */
export function expandAllFileTree<T>(state: FileTreeState<T>): FileTreeState<T> {
  return { ...state, collapsedPaths: expandAllPaths() }
}

export function fileTreeRows<T>(state: FileTreeState<T>): FileTreeRow<T>[] {
  return renderFileTreeRows(state.root, state.collapsedPaths, state.options)
}
