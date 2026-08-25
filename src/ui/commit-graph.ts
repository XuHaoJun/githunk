import type { CommitSummary } from "../domain/commit"

/**
 * Port of lazygit `pkg/gui/presentation/graph/{graph,cell}.go`.
 *
 * Each commit row is rendered as a series of two-character cells — one per lane.
 * The first character is the lane glyph (commit/merge symbol or a box-drawing
 * connector) and the second is the horizontal filler that joins it to the lane
 * on its right. Rows therefore have varying natural widths; the list layout pads
 * the graph column so subjects still line up.
 */

export type GraphSegment = { readonly text: string; readonly color?: string | undefined }
export type CommitGraphRow = { readonly text: string; readonly segments: readonly GraphSegment[] }

type GraphCommit = Pick<CommitSummary, "oid" | "parentOids">

const TERMINATES = 0
const STARTS = 1
const CONTINUES = 2
type PipeKind = typeof TERMINATES | typeof STARTS | typeof CONTINUES

type Pipe = {
  readonly fromPos: number
  readonly toPos: number
  readonly fromHash: string
  readonly toHash: string
  readonly kind: PipeKind
  readonly color?: string | undefined
}

const COMMIT_SYMBOL = "○"
const MERGE_SYMBOL = "◎"
/** git's empty tree, used as the parent of a root commit (lazygit's `EmptyTreeCommitHash`). */
const EMPTY_TREE_HASH = "4b825dc642cb6eb9a060e54bf8d69288fbee4904"
const START_HASH = "START"

function left(pipe: Pipe): number {
  return Math.min(pipe.fromPos, pipe.toPos)
}

function right(pipe: Pipe): number {
  return Math.max(pipe.fromPos, pipe.toPos)
}

function getNextPipes(prevPipes: readonly Pipe[], commit: GraphCommit, color: string | undefined): Pipe[] {
  let maxPos = 0
  for (const pipe of prevPipes) {
    if (pipe.toPos > maxPos) maxPos = pipe.toPos
  }

  // A pipe that terminated on the previous line has no bearing on this one.
  const currentPipes = prevPipes.filter((pipe) => pipe.kind !== TERMINATES)

  const newPipes: Pipe[] = []
  // Assume a brand new commit unrelated to anything above it; it goes on the far end.
  let pos = maxPos + 1
  for (const pipe of currentPipes) {
    if (pipe.toHash === commit.oid) {
      pos = pipe.toPos
      break
    }
  }

  const takenSpots = new Set<number>()
  const traversedSpots = new Set<number>()

  const isFirstCommit = commit.parentOids.length === 0
  const isMerge = commit.parentOids.length > 1
  const toHash = isFirstCommit ? EMPTY_TREE_HASH : commit.parentOids[0]!
  newPipes.push({ fromPos: pos, toPos: pos, fromHash: commit.oid, toHash, kind: STARTS, color })

  const traversedSpotsForContinuingPipes = new Set<number>()
  for (const pipe of currentPipes) {
    if (pipe.toHash !== commit.oid) traversedSpotsForContinuingPipes.add(pipe.toPos)
  }

  const nextAvailablePosForContinuingPipe = (): number => {
    let i = 0
    while (traversedSpots.has(i)) i++
    return i
  }

  const nextAvailablePosForNewPipe = (): number => {
    let i = 0
    // A new pipe may not end on a taken spot, nor on one a continuing pipe traverses.
    while (takenSpots.has(i) || traversedSpotsForContinuingPipes.has(i)) i++
    return i
  }

  const traverse = (from: number, to: number): void => {
    const lo = Math.min(from, to)
    const hi = Math.max(from, to)
    for (let i = lo; i <= hi; i++) traversedSpots.add(i)
    takenSpots.add(to)
  }

  for (const pipe of currentPipes) {
    if (pipe.toHash === commit.oid) {
      newPipes.push({ fromPos: pipe.toPos, toPos: pos, fromHash: pipe.fromHash, toHash: pipe.toHash, kind: TERMINATES, color: pipe.color })
      traverse(pipe.toPos, pos)
    } else if (pipe.toPos < pos) {
      const availablePos = nextAvailablePosForContinuingPipe()
      newPipes.push({ fromPos: pipe.toPos, toPos: availablePos, fromHash: pipe.fromHash, toHash: pipe.toHash, kind: CONTINUES, color: pipe.color })
      traverse(pipe.toPos, availablePos)
    }
  }

  if (isMerge) {
    for (const parent of commit.parentOids.slice(1)) {
      const availablePos = nextAvailablePosForNewPipe()
      newPipes.push({ fromPos: pos, toPos: availablePos, fromHash: commit.oid, toHash: parent, kind: STARTS, color })
      takenSpots.add(availablePos)
    }
  }

  for (const pipe of currentPipes) {
    if (pipe.toHash !== commit.oid && pipe.toPos > pos) {
      // Continuing on, potentially moving left to fill in a blank spot.
      let last = pipe.toPos
      for (let i = pipe.toPos; i > pos; i--) {
        if (takenSpots.has(i) || traversedSpots.has(i)) break
        last = i
      }
      newPipes.push({ fromPos: pipe.toPos, toPos: last, fromHash: pipe.fromHash, toHash: pipe.toHash, kind: CONTINUES, color: pipe.color })
      traverse(pipe.toPos, last)
    }
  }

  newPipes.sort((a, b) => (a.toPos === b.toPos ? a.kind - b.kind : a.toPos - b.toPos))
  return newPipes
}

type Cell = {
  up: boolean
  down: boolean
  left: boolean
  right: boolean
  type: "connection" | "commit" | "merge"
  color?: string | undefined
  rightColor?: string | undefined
}

function newCell(): Cell {
  return { up: false, down: false, left: false, right: false, type: "connection" }
}

function setUp(cell: Cell, color: string | undefined): void {
  cell.up = true
  cell.color = color
}

function setDown(cell: Cell, color: string | undefined): void {
  cell.down = true
  cell.color = color
}

function setLeft(cell: Cell, color: string | undefined): void {
  cell.left = true
  // A vertical run owns the cell colour; horizontals only claim an otherwise idle cell.
  if (!cell.up && !cell.down) cell.color = color
}

function setRight(cell: Cell, color: string | undefined, override: boolean): void {
  cell.right = true
  if (cell.rightColor === undefined || override) cell.rightColor = color
}

/** Lazygit's `getBoxDrawingChars`: glyph plus the filler that joins it rightward. */
function boxDrawingChars(up: boolean, down: boolean, l: boolean, r: boolean): readonly [string, string] {
  if (up && down && l && r) return ["│", "─"]
  if (up && down && l && !r) return ["│", " "]
  if (up && down && !l && r) return ["│", "─"]
  if (up && down && !l && !r) return ["│", " "]
  if (up && !down && l && r) return ["┴", "─"]
  if (up && !down && l && !r) return ["╯", " "]
  if (up && !down && !l && r) return ["╰", "─"]
  if (up && !down && !l && !r) return ["╵", " "]
  if (!up && down && l && r) return ["┬", "─"]
  if (!up && down && l && !r) return ["╮", " "]
  if (!up && down && !l && r) return ["╭", "─"]
  if (!up && down && !l && !r) return ["╷", " "]
  if (!up && !down && l && r) return ["─", "─"]
  if (!up && !down && l && !r) return ["─", " "]
  if (!up && !down && !l && r) return ["╶", "─"]
  return [" ", " "]
}

function renderCell(cell: Cell): readonly GraphSegment[] {
  const [connector, filler] = boxDrawingChars(cell.up, cell.down, cell.left, cell.right)
  const glyph = cell.type === "commit" ? COMMIT_SYMBOL : cell.type === "merge" ? MERGE_SYMBOL : connector
  const rightColor = cell.rightColor ?? cell.color
  // A space carries no styling, matching lazygit so tests can assert on plain spaces.
  if (filler === " ") return [{ text: glyph, color: cell.color }, { text: " " }]
  return [{ text: glyph, color: cell.color }, { text: filler, color: rightColor }]
}

function renderPipeSet(pipes: readonly Pipe[]): CommitGraphRow {
  let maxPos = 0
  let commitPos = 0
  let startCount = 0
  for (const pipe of pipes) {
    if (pipe.kind === STARTS) {
      startCount++
      commitPos = pipe.fromPos
    } else if (pipe.kind === TERMINATES) {
      commitPos = pipe.toPos
    }
    if (right(pipe) > maxPos) maxPos = right(pipe)
  }
  const isMerge = startCount > 1

  const cells: Cell[] = Array.from({ length: maxPos + 1 }, newCell)

  const renderPipe = (pipe: Pipe, override: boolean): void => {
    const l = left(pipe)
    const r = right(pipe)
    if (l !== r) {
      for (let i = l + 1; i < r; i++) {
        setLeft(cells[i]!, pipe.color)
        setRight(cells[i]!, pipe.color, override)
      }
      setRight(cells[l]!, pipe.color, override)
      setLeft(cells[r]!, pipe.color)
    }
    if (pipe.kind === STARTS || pipe.kind === CONTINUES) setDown(cells[pipe.toPos]!, pipe.color)
    if (pipe.kind === TERMINATES || pipe.kind === CONTINUES) setUp(cells[pipe.fromPos]!, pipe.color)
  }

  // Starting pipes go down first so they own the horizontal colour; the rest layer on top.
  for (const pipe of pipes) {
    if (pipe.kind === STARTS) renderPipe(pipe, true)
  }
  for (const pipe of pipes) {
    if (pipe.kind === STARTS) continue
    if (pipe.kind === TERMINATES && pipe.fromPos === commitPos && pipe.toPos === commitPos) continue
    renderPipe(pipe, false)
  }

  cells[commitPos]!.type = isMerge ? "merge" : "commit"

  const segments: GraphSegment[] = []
  for (const cell of cells) segments.push(...renderCell(cell))
  return { text: segments.map((segment) => segment.text).join(""), segments }
}

/**
 * Builds one graph row per commit, in the order the commits were given
 * (newest first, as `git log` emits them).
 */
export function commitGraphRows(
  commits: readonly GraphCommit[],
  getColor?: (commit: GraphCommit, index: number) => string | undefined,
): readonly CommitGraphRow[] {
  if (commits.length === 0) return []
  let pipes: readonly Pipe[] = [
    { fromPos: 0, toPos: 0, fromHash: START_HASH, toHash: commits[0]!.oid, kind: STARTS, color: undefined },
  ]
  return commits.map((commit, index) => {
    pipes = getNextPipes(pipes, commit, getColor?.(commit, index))
    return renderPipeSet(pipes)
  })
}
