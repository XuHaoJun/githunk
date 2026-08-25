import type { GitRunner } from "./runner"

type CommandRunner = Pick<GitRunner, "run">

/**
 * A fingerprint of every local branch plus HEAD, cheap enough to poll.
 *
 * lazygit's `StatusCommands.RefsSnapshot` (pkg/commands/git_commands/status.go:90-108): the
 * `refs/heads` listing concatenated with a HEAD component. Polling it every couple of seconds is
 * how lazygit notices work done outside the app — a commit from another terminal, a rebase driven
 * by an editor — without watching the filesystem.
 *
 * The HEAD component exists because the branch listing alone cannot tell "detached at commit X"
 * from "on a branch pointing at X", and those differ at the end of a rebase: HEAD reattaches
 * without any hash changing (status.go:111-121). `git rev-parse HEAD --symbolic-full-name HEAD`
 * prints both halves in one process — the hash, then `refs/heads/<name>` when attached or the
 * literal `HEAD` when detached — so this costs two git reads, not three.
 *
 * lazygit reads `.git/HEAD` off disk instead of shelling out, which is faster but has to special
 * case the reftable backend's stub file and resolve the worktree's git dir first. The extra read
 * here happens once every couple of seconds; the git command is backend-agnostic for free.
 */
export async function loadRefsSnapshot(runner: CommandRunner): Promise<string> {
  const [refs, head] = await Promise.all([
    runner.run(["for-each-ref", "--format=%(objectname) %(refname)", "refs/heads"], { readOnly: true }),
    runner.run(["rev-parse", "HEAD", "--symbolic-full-name", "HEAD"], { readOnly: true, acceptedExitCodes: [0, 128] }),
  ])
  // A repo with no commits fails `rev-parse HEAD`; its stderr is stable for the same state, but
  // only the refs half is meaningful there, so the head half contributes nothing rather than noise.
  return `${refs.stdout}${head.exitCode === 0 ? head.stdout : ""}`
}
