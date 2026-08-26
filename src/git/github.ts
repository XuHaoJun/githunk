import type { PullRequest, PullRequestChecksState, PullRequestState } from "../domain/pull-request"

/**
 * Pull requests via the `gh` CLI.
 *
 * lazygit talks to GitHub's GraphQL API itself, discovering a token from `gh`'s hosts.yml or the
 * environment (pkg/commands/git_commands/github.go, refresh_helper.go:1694-1726). githunk shells
 * out to `gh` instead, which is the same shape as everything else it does and inherits `gh`'s own
 * authentication, host configuration and enterprise support rather than re-deriving them. The
 * consequence is that a repo without `gh` on PATH, or without `gh auth login`, simply shows no
 * dots — which is also what lazygit does when it finds no token.
 */

/** How many pull requests one call fetches, newest first. */
export const PULL_REQUEST_LIMIT = 100

const JSON_FIELDS = "number,title,state,isDraft,url,headRefName,headRepositoryOwner,statusCheckRollup"

export const PULL_REQUEST_LIST_ARGS: readonly string[] = [
  "pr",
  "list",
  // Closed and merged PRs are the point: a merged PR is what colours the dot purple.
  "--state",
  "all",
  "--limit",
  String(PULL_REQUEST_LIMIT),
  "--json",
  JSON_FIELDS,
]

export type ProcessResult = {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
}

export type GhRunner = (args: readonly string[]) => Promise<ProcessResult>

type RawCheck = { readonly state?: unknown; readonly conclusion?: unknown; readonly status?: unknown }

/**
 * `gh pr list --json statusCheckRollup` returns each PR's individual check runs, not the single
 * rollup state lazygit reads off GraphQL's `statusCheckRollup.state`, so the rollup is folded here
 * with GitHub's own precedence: any failure fails the rollup, then anything still running pends,
 * then all-success succeeds.
 */
function rollupChecksState(checks: unknown): PullRequestChecksState {
  if (!Array.isArray(checks) || checks.length === 0) return ""
  let sawPending = false
  let sawSuccess = false
  for (const check of checks as readonly RawCheck[]) {
    const state = String(check.conclusion ?? check.state ?? "").toUpperCase()
    const status = String(check.status ?? "").toUpperCase()
    if (state === "FAILURE" || state === "TIMED_OUT" || state === "CANCELLED" || state === "STARTUP_FAILURE") return "FAILURE"
    if (state === "ACTION_REQUIRED" || state === "STALE") return "ERROR"
    if (state === "ERROR") return "ERROR"
    if (state === "" || status === "IN_PROGRESS" || status === "QUEUED" || status === "PENDING" || state === "PENDING") {
      sawPending = true
      continue
    }
    if (state === "SUCCESS" || state === "NEUTRAL" || state === "SKIPPED") sawSuccess = true
  }
  if (sawPending) return "PENDING"
  return sawSuccess ? "SUCCESS" : ""
}

function asState(state: unknown, isDraft: unknown): PullRequestState {
  const value = String(state ?? "").toUpperCase()
  const base: PullRequestState = value === "MERGED" || value === "CLOSED" || value === "OPEN" ? value : "OPEN"
  // github.go:317 — a draft that has not been closed reports as DRAFT.
  return isDraft === true && base !== "CLOSED" ? "DRAFT" : base
}

/**
 * `gh` emits a JSON array. Anything malformed yields no pull requests rather than an error: the
 * dots are decoration, and losing them must never take the branches panel with them.
 */
export function parsePullRequests(json: string): readonly PullRequest[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  return parsed.flatMap((entry): readonly PullRequest[] => {
    if (typeof entry !== "object" || entry === null) return []
    const record = entry as Record<string, unknown>
    const headRefName = typeof record.headRefName === "string" ? record.headRefName : ""
    if (headRefName.length === 0) return []
    const owner = record.headRepositoryOwner
    const login = typeof owner === "object" && owner !== null && typeof (owner as Record<string, unknown>).login === "string"
      ? (owner as Record<string, string>).login!
      : ""
    return [{
      number: typeof record.number === "number" ? record.number : 0,
      title: typeof record.title === "string" ? record.title : "",
      state: asState(record.state, record.isDraft),
      checksState: rollupChecksState(record.statusCheckRollup),
      url: typeof record.url === "string" ? record.url : "",
      headRefName,
      headRepositoryOwner: login,
    }]
  })
}

/** Thrown when `gh` is absent or refuses; callers treat it as "no pull requests to show". */
export class PullRequestsUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "PullRequestsUnavailableError"
  }
}

export async function loadPullRequests(runner: GhRunner): Promise<readonly PullRequest[]> {
  const result = await runner(PULL_REQUEST_LIST_ARGS)
  if (result.exitCode !== 0) {
    throw new PullRequestsUnavailableError(result.stderr.trim() || `gh exited with code ${result.exitCode}`)
  }
  return parsePullRequests(result.stdout)
}

/**
 * A `gh` runner. `gh pr list` is a background query — only the background refresh drives it — and
 * lazygit keeps queries out of the command log entirely (76 `DontLog()` call sites, e.g.
 * pkg/commands/git_commands/status.go:98). So this deliberately does not log, and the log stays
 * what lazygit's is: the user's own actions.
 */
export function createGhRunner(cwd: string): GhRunner {
  return async (args: readonly string[]): Promise<ProcessResult> => {
    let stdout = ""
    let stderr = ""
    let exitCode = -1
    try {
      const proc = Bun.spawn(["gh", ...args], {
        cwd,
        env: { ...process.env, GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1" },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      })
      ;[stdout, stderr, exitCode] = await Promise.all([
        Bun.readableStreamToText(proc.stdout),
        Bun.readableStreamToText(proc.stderr),
        proc.exited,
      ])
    } catch (error) {
      stderr = error instanceof Error ? error.message : String(error)
    }
    return { exitCode, stdout, stderr }
  }
}
