import { describe, expect, test } from "bun:test"
import type { LocalBranch } from "../../src/domain/branch"
import { branchStatus, formatRecency } from "../../src/ui/branch-status"
import { SPINNER_FRAMES, SPINNER_RATE_MS, loaderFrame } from "../../src/ui/loader"
import {
  BRANCH_DIVERGED_FG,
  BRANCH_ITEM_OPERATION_FG,
  BRANCH_MATCHES_UPSTREAM_FG,
  BRANCH_UPSTREAM_GONE_FG,
  BRANCH_UPSTREAM_NOT_LOCAL_FG,
} from "../../src/ui/theme"

function branch(overrides: Partial<LocalBranch> = {}): LocalBranch {
  return { name: "feature", isCurrent: false, ...overrides }
}

describe("loaderFrame", () => {
  test("cycles lazygit's spinner frames at its configured rate", () => {
    expect(SPINNER_FRAMES).toEqual(["●∙∙", "∙●∙", "∙∙●", "∙●∙"])
    expect(SPINNER_RATE_MS).toBe(180)
    expect(loaderFrame(0)).toBe("●∙∙")
    expect(loaderFrame(SPINNER_RATE_MS)).toBe("∙●∙")
    expect(loaderFrame(SPINNER_RATE_MS * 2)).toBe("∙∙●")
    expect(loaderFrame(SPINNER_RATE_MS * 3)).toBe("∙●∙")
    expect(loaderFrame(SPINNER_RATE_MS * 4)).toBe("●∙∙")
    // Within one frame's window the frame does not move.
    expect(loaderFrame(SPINNER_RATE_MS + 179)).toBe("∙●∙")
  })
})

describe("formatRecency", () => {
  const now = 1_700_000_000
  test("matches lazygit's one-unit, one-letter form", () => {
    expect(formatRecency(String(now - 5), now)).toBe("5s")
    expect(formatRecency(String(now - 90), now)).toBe("1m")
    expect(formatRecency(String(now - 3 * 3600), now)).toBe("3h")
    expect(formatRecency(String(now - 2 * 86400), now)).toBe("2d")
    expect(formatRecency(String(now - 3 * 604800), now)).toBe("3w")
    expect(formatRecency(String(now - 5 * 2628000), now)).toBe("5M")
    expect(formatRecency(String(now - 2 * 31536000), now)).toBe("2y")
  })

  test("an absent or unparseable timestamp reads as blank, never NaN", () => {
    expect(formatRecency(undefined, now)).toBe("")
    expect(formatRecency("", now)).toBe("")
    expect(formatRecency("not-a-number", now)).toBe("")
  })
})

describe("branchStatus", () => {
  const now = 0

  test("a branch that tracks nothing has no status", () => {
    expect(branchStatus(branch(), undefined, now)).toBeUndefined()
  })

  test("an in-flight operation replaces the status with its label and the spinner", () => {
    const status = branchStatus(branch({ upstreamRemote: "origin" }), "pulling", SPINNER_RATE_MS)
    expect(status).toEqual({ text: "Pulling ∙●∙", color: BRANCH_ITEM_OPERATION_FG })
  })

  test("an operation wins over whatever the tracking state would have shown", () => {
    const matching = branch({ upstreamRemote: "origin", aheadForPull: "0", behindForPull: "0" })
    expect(branchStatus(matching, undefined, now)?.text).toBe("✓")
    expect(branchStatus(matching, "pushing", now)?.text).toBe("Pushing ●∙∙")
  })

  test("a deleted upstream reads as lazygit's (upstream gone)", () => {
    const status = branchStatus(branch({ upstreamRemote: "origin", upstreamGone: true, aheadForPull: "?", behindForPull: "?" }), undefined, now)
    expect(status).toEqual({ text: "(upstream gone)", color: BRANCH_UPSTREAM_GONE_FG })
  })

  test("matching the upstream reads as a green tick", () => {
    const status = branchStatus(branch({ upstreamRemote: "origin", aheadForPull: "0", behindForPull: "0" }), undefined, now)
    expect(status).toEqual({ text: "✓", color: BRANCH_MATCHES_UPSTREAM_FG })
  })

  test("an upstream whose ref is not stored locally reads as a magenta question mark", () => {
    const status = branchStatus(branch({ upstreamRemote: "origin", aheadForPull: "?", behindForPull: "?" }), undefined, now)
    expect(status).toEqual({ text: "?", color: BRANCH_UPSTREAM_NOT_LOCAL_FG })
  })

  test("divergence reads as behind-then-ahead arrows", () => {
    expect(branchStatus(branch({ upstreamRemote: "origin", aheadForPull: "3", behindForPull: "7" }), undefined, now))
      .toEqual({ text: "↓7↑3", color: BRANCH_DIVERGED_FG })
    expect(branchStatus(branch({ upstreamRemote: "origin", aheadForPull: "0", behindForPull: "7" }), undefined, now))
      .toEqual({ text: "↓7", color: BRANCH_DIVERGED_FG })
    expect(branchStatus(branch({ upstreamRemote: "origin", aheadForPull: "3", behindForPull: "0" }), undefined, now))
      .toEqual({ text: "↑3", color: BRANCH_DIVERGED_FG })
  })
})
