export type Direction = "row" | "column"

export type Dimensions = {
  readonly x0: number
  readonly y0: number
  readonly x1: number
  readonly y1: number
}

export type Box = {
  readonly window?: string
  readonly direction?: Direction
  readonly conditionalDirection?: (width: number, height: number) => Direction
  /** Dynamic share of whatever the statically sized siblings leave behind. Mutually exclusive with size. */
  readonly weight?: number
  /** Static extent along the parent's direction. Mutually exclusive with weight. */
  readonly size?: number
  readonly children?: readonly Box[]
  readonly conditionalChildren?: (width: number, height: number) => readonly Box[]
}

function isStatic(box: Box): boolean {
  return (box.size ?? 0) > 0
}

function factorsOf(value: number): number[] {
  const factors: number[] = []
  for (let candidate = 2; candidate <= value; candidate += 1) {
    if (value % candidate === 0) factors.push(candidate)
  }
  return factors
}

/**
 * Divides weights by their lowest common factor, so 2,4,4 becomes 1,2,2. The
 * remainder loop in calcSizes walks the normalized weights, so skipping this
 * step yields different cell allocations than lazygit's.
 */
export function normalizeWeights(weights: readonly number[]): readonly number[] {
  if (weights.length === 0) return []
  if (weights.some((weight) => weight === 1)) return weights

  const positive = weights.filter((weight) => weight > 0)
  if (positive.length === 0) return weights

  let common = factorsOf(positive[0]!)
  for (const weight of positive) {
    const factors = new Set(factorsOf(weight))
    common = common.filter((factor) => factors.has(factor))
  }
  if (common.length === 0) return weights

  return normalizeWeights(weights.map((weight) => Math.floor(weight / common[0]!)))
}

export function calcSizes(boxes: readonly Box[], availableSpace: number): readonly number[] {
  const weights = [...normalizeWeights(boxes.map((box) => box.weight ?? 0))]

  let totalWeight = 0
  let reservedSpace = 0
  for (const [index, box] of boxes.entries()) {
    if (isStatic(box)) reservedSpace += box.size ?? 0
    else totalWeight += weights[index] ?? 0
  }

  const dynamicSpace = Math.max(0, availableSpace - reservedSpace)
  const unitSize = totalWeight > 0 ? Math.floor(dynamicSpace / totalWeight) : 0
  let extraSpace = totalWeight > 0 ? dynamicSpace % totalWeight : 0

  const result = boxes.map((box, index) =>
    isStatic(box)
      ? Math.min(availableSpace, box.size ?? 0)
      : unitSize * (weights[index] ?? 0),
  )

  // Deal the remainder out one cell at a time, decrementing the weight each
  // time a box is served, so wider boxes take proportionally more of it.
  while (extraSpace > 0) {
    let served = false
    for (const [index, weight] of weights.entries()) {
      if (weight <= 0) continue
      result[index] = (result[index] ?? 0) + 1
      weights[index] = weight - 1
      extraSpace -= 1
      served = true
      if (extraSpace === 0) break
    }
    if (!served) break
  }

  return result
}

export function arrangeWindows(
  root: Box,
  x0: number,
  y0: number,
  width: number,
  height: number,
): Readonly<Record<string, Dimensions>> {
  const children = root.conditionalChildren?.(width, height) ?? root.children ?? []
  if (children.length === 0) {
    if (root.window === undefined || root.window === "") return {}
    return { [root.window]: { x0, y0, x1: x0 + width - 1, y1: y0 + height - 1 } }
  }

  const direction = root.conditionalDirection?.(width, height) ?? root.direction ?? "row"
  const sizes = calcSizes(children, direction === "column" ? width : height)

  const result: Record<string, Dimensions> = {}
  let offset = 0
  for (const [index, child] of children.entries()) {
    const boxSize = sizes[index] ?? 0
    const arranged = direction === "column"
      ? arrangeWindows(child, x0 + offset, y0, boxSize, height)
      : arrangeWindows(child, x0, y0 + offset, width, boxSize)
    Object.assign(result, arranged)
    offset += boxSize
  }
  return result
}
