import type { ColorInput } from "@opentui/core"

import type { LocalBranch } from "../domain/branch"
import { itemOperationLabel, type ItemOperation } from "../domain/item-operation"
import { loaderFrame } from "./loader"
import {
  BRANCH_DIVERGED_FG,
  BRANCH_ITEM_OPERATION_FG,
  BRANCH_MATCHES_UPSTREAM_FG,
  BRANCH_UPSTREAM_GONE_FG,
  BRANCH_UPSTREAM_NOT_LOCAL_FG,
} from "./theme"

/**
 * The cell lazygit draws right of a branch's name, and the recency cell left of it.
 *
 * `BranchStatus` — pkg/gui/presentation/branches.go:219-249 — with the same precedence: an
 * in-flight operation on the item wins over every tracking state, so a row that is being pushed
 * says `Pushing ●∙∙` rather than its now-stale ahead/behind counts.
 */

export type BranchStatusCell = {
  readonly text: string
  readonly color: ColorInput
}

/** lazygit's `tr.UpstreamGone` — pkg/i18n/english.go:2007. */
const UPSTREAM_GONE = "(upstream gone)"

/**
 * `utils.UnixToTimeAgo` → `formatSecondsAgo` (pkg/utils/date.go:8-56): the largest unit whose
 * period the age has not yet reached, as one integer and one letter — `5s`, `1m`, `3h`, `2d`,
 * `3w`, `5M`, `2y`. lazygit stores this on the branch as `Recency` whenever branches are sorted by
 * date, which is the default (`git.localBranchSortOrder: "date"`, pkg/config/user_config.go:954).
 */
const PERIODS: readonly (readonly [string, number])[] = [
  ["s", 1],
  ["m", 60],
  ["h", 3600],
  ["d", 86400],
  ["w", 604800],
  ["M", 31536000 / 12],
  ["y", 31536000],
]

export function formatRecency(committedAtUnix: string | undefined, nowUnix: number): string {
  if (committedAtUnix === undefined || committedAtUnix.length === 0) return ""
  const then = Number(committedAtUnix)
  if (!Number.isFinite(then)) return ""
  const secondsAgo = Math.max(0, nowUnix - then)
  for (let index = 1; index < PERIODS.length; index++) {
    if (secondsAgo < PERIODS[index]![1]) {
      const [label, seconds] = PERIODS[index - 1]!
      return `${Math.floor(secondsAgo / seconds)}${label}`
    }
  }
  const [label, seconds] = PERIODS[PERIODS.length - 1]!
  return `${Math.floor(secondsAgo / seconds)}${label}`
}

/**
 * `IsTrackingRemote()` is `UpstreamRemote != ""` (pkg/commands/models/branch.go:85) — the
 * *configured* upstream, not a resolvable ref, which is why a branch whose remote-tracking ref is
 * missing locally still gets a status (the magenta `?`) rather than none.
 */
function isTrackingRemote(branch: LocalBranch): boolean {
  return branch.upstreamRemote !== undefined && branch.upstreamRemote.length > 0
}

function remoteBranchStoredLocally(branch: LocalBranch): boolean {
  return isTrackingRemote(branch) && branch.aheadForPull !== "?" && branch.behindForPull !== "?"
}

export function branchStatus(branch: LocalBranch, operation: ItemOperation | undefined, nowMs: number): BranchStatusCell | undefined {
  if (operation !== undefined) {
    return { text: `${itemOperationLabel(operation)} ${loaderFrame(nowMs)}`, color: BRANCH_ITEM_OPERATION_FG }
  }
  if (!isTrackingRemote(branch)) return undefined
  if (branch.upstreamGone === true) return { text: UPSTREAM_GONE, color: BRANCH_UPSTREAM_GONE_FG }
  const storedLocally = remoteBranchStoredLocally(branch)
  if (!storedLocally) return { text: "?", color: BRANCH_UPSTREAM_NOT_LOCAL_FG }
  const ahead = branch.aheadForPull ?? "0"
  const behind = branch.behindForPull ?? "0"
  if (ahead === "0" && behind === "0") return { text: "✓", color: BRANCH_MATCHES_UPSTREAM_FG }
  if (behind !== "0" && ahead !== "0") return { text: `↓${behind}↑${ahead}`, color: BRANCH_DIVERGED_FG }
  if (behind !== "0") return { text: `↓${behind}`, color: BRANCH_DIVERGED_FG }
  return { text: `↑${ahead}`, color: BRANCH_DIVERGED_FG }
}
