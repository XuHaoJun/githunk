import type { PullRequest, PullRequestChecksState, PullRequestState } from "../domain/pull-request"
import {
  PR_CHECKS_FAILING_FG,
  PR_CHECKS_PASSING_FG,
  PR_CHECKS_PENDING_FG,
  PR_CLOSED_FG,
  PR_DRAFT_FG,
  PR_MERGED_FG,
  PR_OPEN_FG,
} from "./theme"

/**
 * The dot lazygit draws between a branch's recency and its name —
 * pkg/gui/presentation/branches.go:143-160.
 *
 *     prIcon = "●"                                   // no nerd-font icons configured
 *     coloredPrIcon = WithPrColor(pr.State, prIcon, false)
 *     if pr.State == "OPEN" { … checksStatePresentation overrides the icon … }
 *
 * so a merged pull request is a purple dot, and an open one with checks becomes the checks' own
 * glyph. githunk has no nerd-font mode, so the `●` branch is the only one.
 */

export type PullRequestIcon = {
  readonly text: string
  /** Absent for `EXPECTED` checks, whose `style.FgDefault` is the row's own colour. */
  readonly color?: string
}

const STATE_COLOR: Readonly<Record<PullRequestState, string>> = {
  OPEN: PR_OPEN_FG,
  CLOSED: PR_CLOSED_FG,
  MERGED: PR_MERGED_FG,
  DRAFT: PR_DRAFT_FG,
}

/** `checksStatePresentation` — pkg/gui/presentation/branches.go:344-359. */
const CHECKS_ICON: Readonly<Partial<Record<PullRequestChecksState, PullRequestIcon>>> = {
  SUCCESS: { text: "✓", color: PR_CHECKS_PASSING_FG },
  PENDING: { text: "●", color: PR_CHECKS_PENDING_FG },
  FAILURE: { text: "✗", color: PR_CHECKS_FAILING_FG },
  ERROR: { text: "!", color: PR_CHECKS_FAILING_FG },
  EXPECTED: { text: "○" },
}

export function pullRequestIcon(pullRequest: PullRequest): PullRequestIcon {
  if (pullRequest.state === "OPEN") {
    const checks = CHECKS_ICON[pullRequest.checksState]
    if (checks !== undefined) return checks
  }
  return { text: "●", color: STATE_COLOR[pullRequest.state] }
}
