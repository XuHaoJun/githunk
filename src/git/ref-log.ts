import type { GitRunner } from "./runner"

type CommandRunner = Pick<GitRunner, "run">

/**
 * The three ref kinds panel 3 can select. lazygit renders the same graph for all of them, from
 * `BranchCommands.GetGraphCmdObj(ref.FullRefName())` — branches_controller.go:207,
 * remote_branches_controller.go:122 and tags_controller.go:109.
 */
export type RefLogTarget = {
  readonly kind: "local-branch" | "remote-branch" | "tag"
  /** Short name as the panel shows it (`main`, `origin/feature`, `v1.0`), or an already-full ref. */
  readonly name: string
}

const PREFIXES: Readonly<Record<RefLogTarget["kind"], string>> = {
  "local-branch": "refs/heads/",
  "remote-branch": "refs/remotes/",
  tag: "refs/tags/",
}

/**
 * How many commits the graph reaches back.
 *
 * lazygit needs no limit: its main view runs the log as a streaming task and stops reading at
 * `linesToReadFromCmdTask` — a viewport's worth plus slack (pkg/gui/view_helpers.go:22). githunk's
 * main pane owns the whole text so that OpenTUI can scroll, wrap and select over it, so the depth
 * is bounded here instead. Deep enough that scrolling a branch's history feels unbounded, shallow
 * enough that a repo with 500k commits does not pay for them on every selection change.
 */
export const REF_LOG_DEPTH = 300

/** `refs/`-qualifies a panel selection, so `main` can never resolve to a tag of the same name. */
export function refLogFullName(target: RefLogTarget): string {
  return target.name.startsWith("refs/") ? target.name : `${PREFIXES[target.kind]}${target.name}`
}

/**
 * lazygit's default `git.branchLogCmd`:
 * `git log --graph --color=always --abbrev-commit --decorate --date=relative --pretty=medium
 * {{branchName}} --` (pkg/config/user_config.go:964).
 *
 * `--color=always` is kept: git's own colouring is what ../ui/ansi re-renders, and it carries the
 * per-lane graph colours that make the graph readable. `--end-of-options` is added because the ref
 * comes from a panel selection, and a branch may legally be named `--help`.
 */
export function refLogArgs(fullRefName: string, depth: number = REF_LOG_DEPTH): readonly string[] {
  return [
    "log",
    "--graph",
    "--color=always",
    "--abbrev-commit",
    "--decorate",
    "--date=relative",
    "--pretty=medium",
    "-n",
    String(depth),
    "--end-of-options",
    fullRefName,
    "--",
  ]
}

/** The raw, still-escaped output; ../ui/ansi turns it into text plus highlight spans. */
export async function loadRefLog(runner: CommandRunner, fullRefName: string, depth: number = REF_LOG_DEPTH): Promise<string> {
  const result = await runner.run(refLogArgs(fullRefName, depth), { readOnly: true })
  return result.stdout
}
