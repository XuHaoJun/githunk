import { describe, expect, test } from "bun:test"
import { arrangeWindows, calcSizes, normalizeWeights } from "../../src/ui/boxlayout"

describe("normalizeWeights", () => {
  test("divides weights by their lowest common factor", () => {
    expect(normalizeWeights([2, 4, 4])).toEqual([1, 2, 2])
    expect(normalizeWeights([3, 6, 9])).toEqual([1, 2, 3])
  })

  test("returns weights unchanged when any weight is already 1", () => {
    expect(normalizeWeights([1, 2, 2])).toEqual([1, 2, 2])
  })

  test("returns weights unchanged when there is no common factor", () => {
    expect(normalizeWeights([2, 3])).toEqual([2, 3])
  })

  test("ignores zero weights when finding the common factor", () => {
    expect(normalizeWeights([0, 4, 4])).toEqual([0, 1, 1])
  })

  test("handles the empty list", () => {
    expect(normalizeWeights([])).toEqual([])
  })
})

describe("calcSizes", () => {
  test("serves static sizes first, then splits the rest by weight", () => {
    expect(calcSizes([{ size: 3 }, { weight: 1 }, { weight: 1 }], 13)).toEqual([3, 5, 5])
  })

  test("distributes the remainder one cell at a time across weighted boxes", () => {
    expect(calcSizes([{ weight: 1 }, { weight: 1 }, { weight: 1 }], 10)).toEqual([4, 3, 3])
  })

  test("splits proportionally when weights differ", () => {
    expect(calcSizes([{ weight: 1 }, { weight: 2 }], 12)).toEqual([4, 8])
  })

  test("crops a static box larger than the available space", () => {
    expect(calcSizes([{ size: 40 }], 10)).toEqual([10])
  })

  test("gives weighted boxes nothing when static boxes consume everything", () => {
    expect(calcSizes([{ size: 10 }, { weight: 1 }], 10)).toEqual([10, 0])
  })
})

describe("arrangeWindows", () => {
  test("maps a leaf window to the full region, inclusive of both ends", () => {
    expect(arrangeWindows({ window: "main" }, 0, 0, 10, 4)).toEqual({
      main: { x0: 0, y0: 0, x1: 9, y1: 3 },
    })
  })

  test("returns nothing for a leaf with no window name", () => {
    expect(arrangeWindows({}, 0, 0, 10, 4)).toEqual({})
  })

  test("stacks row children vertically", () => {
    expect(arrangeWindows({
      direction: "row",
      children: [{ window: "top", size: 1 }, { window: "bottom", weight: 1 }],
    }, 0, 0, 8, 4)).toEqual({
      top: { x0: 0, y0: 0, x1: 7, y1: 0 },
      bottom: { x0: 0, y0: 1, x1: 7, y1: 3 },
    })
  })

  test("places column children side by side", () => {
    expect(arrangeWindows({
      direction: "column",
      children: [{ window: "left", size: 3 }, { window: "right", weight: 1 }],
    }, 0, 0, 8, 2)).toEqual({
      left: { x0: 0, y0: 0, x1: 2, y1: 1 },
      right: { x0: 3, y0: 0, x1: 7, y1: 1 },
    })
  })

  test("arranges nested boxes and merges their windows", () => {
    const result = arrangeWindows({
      direction: "column",
      children: [
        { window: "side", size: 2 },
        {
          direction: "row",
          weight: 1,
          children: [{ window: "main", weight: 1 }, { window: "log", size: 1 }],
        },
      ],
    }, 0, 0, 6, 3)
    expect(result).toEqual({
      side: { x0: 0, y0: 0, x1: 1, y1: 2 },
      main: { x0: 2, y0: 0, x1: 5, y1: 1 },
      log: { x0: 2, y0: 2, x1: 5, y1: 2 },
    })
  })

  test("resolves conditionalChildren with the region it was given", () => {
    const result = arrangeWindows({
      direction: "row",
      conditionalChildren: (_width, height) =>
        height >= 4 ? [{ window: "tall", weight: 1 }] : [{ window: "short", weight: 1 }],
    }, 0, 0, 5, 2)
    expect(Object.keys(result)).toEqual(["short"])
  })

  test("resolves conditionalDirection with the region it was given", () => {
    const box = {
      conditionalDirection: (width: number) => (width >= 10 ? "column" as const : "row" as const),
      children: [{ window: "a", weight: 1 }, { window: "b", weight: 1 }],
    }
    expect(arrangeWindows(box, 0, 0, 4, 4).a).toEqual({ x0: 0, y0: 0, x1: 3, y1: 1 })
    expect(arrangeWindows(box, 0, 0, 10, 4).a).toEqual({ x0: 0, y0: 0, x1: 4, y1: 3 })
  })

  test("gives a zero-sized child an empty region without going negative", () => {
    const result = arrangeWindows({
      direction: "column",
      children: [{ window: "hidden", size: 0, weight: 0 }, { window: "shown", weight: 1 }],
    }, 0, 0, 6, 1)
    expect(result.hidden).toEqual({ x0: 0, y0: 0, x1: -1, y1: 0 })
    expect(result.shown).toEqual({ x0: 0, y0: 0, x1: 5, y1: 0 })
  })
})
