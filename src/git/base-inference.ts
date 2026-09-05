import { GitRunner } from "./runner"

export type ReviewBaseCandidate = {
  readonly ref: string
  readonly label: string
  readonly reason?: string
}

export type BaseInference = {
  readonly kind: "choose"
  readonly candidates: readonly ReviewBaseCandidate[]
  readonly reason: string
}

type CommandRunner = Pick<GitRunner, "run">

async function output(runner: CommandRunner, args: readonly string[]): Promise<string | undefined> {
  try {
    return (await runner.run(args, { readOnly: true })).stdout
  } catch {
    return undefined
  }
}

export async function resolveRefOid(runner: CommandRunner, ref: string): Promise<string | undefined> {
  const resolved = await output(runner, ["rev-parse", "--verify", `${ref}^{commit}`])
  const oid = resolved?.trim()
  return oid !== undefined && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(oid) ? oid : undefined
}
export async function currentBranchRef(runner: CommandRunner): Promise<string | undefined> {
  const ref = (await output(runner, ["symbolic-ref", "--quiet", "HEAD"]))?.trim()
  return ref?.startsWith("refs/heads/") ? ref : undefined
}

type BranchRef = {
  readonly ref: string
  readonly oid: string
  readonly symbolic: string
  readonly upstreamRemote: string
}

// Branch Review ranking is a githunk review extension, not lazygit inference parity.
// lazygit explicitly selects its diff ref (pkg/gui/controllers/diffing_menu_action.go:18-40)
// and confirms filters (pkg/gui/controllers/filtering_menu_action.go:60-83); suggestions
// here likewise never choose the comparison on the user's behalf.
export async function inferReviewBase(runner: CommandRunner, preferredRef?: string): Promise<BaseInference> {
  const [refResult, branchResult, headResult, remoteResult] = await Promise.all([
    runner.run([
      "for-each-ref", "--format=%(refname)%09%(objectname)%09%(objecttype)%09%(symref)%09%(upstream:remotename)",
      "refs/heads", "refs/remotes",
    ], { readOnly: true }),
    runner.run(["symbolic-ref", "--quiet", "HEAD"], { readOnly: true, acceptedExitCodes: [0, 1] }),
    runner.run(["rev-parse", "--verify", "--quiet", "HEAD^{commit}"], { readOnly: true, acceptedExitCodes: [0, 1] }),
    runner.run(["remote"], { readOnly: true }),
  ])
  const branchRef = branchResult.exitCode === 0 ? branchResult.stdout.trim() : undefined
  const headOid = headResult.exitCode === 0 ? headResult.stdout.trim() : undefined
  const branchName = branchRef?.startsWith("refs/heads/") ? branchRef.slice("refs/heads/".length) : undefined
  const refs: BranchRef[] = []
  for (const line of refResult.stdout.split(/\r?\n/)) {
    const [ref, oid, objectType, symbolic = "", upstreamRemote = ""] = line.split("\t")
    if (ref === undefined || oid === undefined || objectType !== "commit") continue
    refs.push({ ref, oid, symbolic, upstreamRemote })
  }
  const upstreamRemote = refs.find(({ ref }) => ref === branchRef)?.upstreamRemote
  const remoteNames = remoteResult.stdout.split(/\r?\n/).filter(Boolean)
    .sort((left, right) => right.length - left.length || (left < right ? -1 : left > right ? 1 : 0))
  const remoteOrder = (remote: string): number => remote === upstreamRemote ? 0 : remote === "origin" ? 1 : 2
  const defaults = refs.filter(({ ref, symbolic }) => ref.startsWith("refs/remotes/") && ref.endsWith("/HEAD") && symbolic !== "")
    .sort((left, right) => {
      const leftRemote = left.ref.slice("refs/remotes/".length, -"/HEAD".length)
      const rightRemote = right.ref.slice("refs/remotes/".length, -"/HEAD".length)
      return remoteOrder(leftRemote) - remoteOrder(rightRemote) || (left.ref < right.ref ? -1 : left.ref > right.ref ? 1 : 0)
    })
  const defaultRanks = new Map(defaults.map(({ symbolic }, index) => [symbolic, index]))
  const defaultRemotes = new Map(defaults.map(({ ref, symbolic }) => [symbolic, ref.slice("refs/remotes/".length, -"/HEAD".length)]))
  const branches = refs.filter(({ ref, symbolic }) => ref !== branchRef && symbolic === "" &&
    !(ref.startsWith("refs/remotes/") && ref.endsWith("/HEAD")))

  // One bounded first-parent walk finds stacked parent tips without a subprocess per
  // branch or an unbounded history scan. Older/diverged tips retain the other signals;
  // absence from this walk never claims that a branch is unrelated.
  const firstParentDistances = new Map<string, number>()
  if (headOid !== undefined && branches.length > 0) {
    const history = await runner.run(["rev-list", "--first-parent", "--max-count=2049", headOid, "--"], { readOnly: true })
    let distance = 0
    for (const oid of history.stdout.trim().split(/\r?\n/)) {
      if (oid !== "") firstParentDistances.set(oid, distance++)
    }
  }
  const ranked = branches.map(({ ref, oid }) => {
    const local = ref.startsWith("refs/heads/")
    const label = ref.slice(local ? "refs/heads/".length : "refs/remotes/".length)
    const remote = local ? undefined : remoteNames.find((name) => label.startsWith(`${name}/`))
    const shortName = local ? label : remote === undefined ? undefined : label.slice(remote.length + 1)
    const trackingHead = !local && branchName !== undefined && shortName === branchName
    const sameHead = headOid !== undefined && oid === headOid
    const distance = firstParentDistances.get(oid)
    const defaultRank = defaultRanks.get(ref)
    const defaultRemote = defaultRemotes.get(ref)
    const conventionalRank = shortName === "main" ? 0 : shortName === "master" ? 1 : shortName === "develop" ? 2 : 3
    const defaultReason = defaultRemote === undefined ? undefined :
      `Default branch of ${defaultRemote === upstreamRemote ? "upstream remote " : "remote "}${defaultRemote}`
    let priority: number
    let reason: string
    if (ref === preferredRef) {
      priority = 0
      reason = "Previously selected review base"
    } else if (trackingHead || sameHead) {
      priority = 5
      reason = trackingHead ? "Same-name remote branch for current HEAD" : "Points at current HEAD"
    } else if (distance !== undefined && distance > 0) {
      priority = 1
      reason = `Branch tip ${distance} first-parent ${distance === 1 ? "commit" : "commits"} behind HEAD`
      if (defaultReason !== undefined) reason += `; ${defaultReason}`
    } else if (defaultRank !== undefined) {
      priority = 2
      reason = defaultReason!
    } else if (conventionalRank < 3) {
      priority = 3
      reason = `Conventional ${shortName} base branch`
    } else {
      priority = 4
      reason = local ? "Local branch" : "Remote branch"
    }
    return {
      candidate: { ref, label, reason },
      priority,
      distance: priority === 1 ? distance! : 0,
      defaultRank: priority === 1 || priority === 2 ? defaultRank ?? defaults.length : 0,
      conventionalRank: priority === 1 || priority === 3 ? conventionalRank : 0,
    }
  })
  ranked.sort((left, right) => left.priority - right.priority || left.distance - right.distance ||
    left.defaultRank - right.defaultRank || left.conventionalRank - right.conventionalRank ||
    (left.candidate.ref < right.candidate.ref ? -1 : left.candidate.ref > right.candidate.ref ? 1 : 0))
  return {
    kind: "choose",
    candidates: ranked.map(({ candidate }) => candidate),
    reason: headOid === undefined ? "HEAD has no commit" : branchRef === undefined ? "HEAD is detached; choose a review base" :
      "Choose a review base; likely branches are listed first",
  }
}
