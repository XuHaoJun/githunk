import type { ChangedFile, ReviewTarget } from "../domain/review-target"
import type { PatchSection } from "../domain/repository"
import { parseNumstat } from "./diff"
import { GitRunner } from "./runner"
import { resolveRefOid } from "./base-inference"

export type BranchReviewSnapshot = {
  readonly repositoryRoot: string
  readonly branch: string
  readonly baseRef: string
  readonly baseOid: string
  readonly headOid: string
  readonly mergeBaseOid: string
  readonly commitCount: number
  readonly reviewTarget: Extract<ReviewTarget, { readonly kind: "branch" }>
  readonly files: readonly ChangedFile[]
  readonly patches: readonly PatchSection[]
}

type CommandRunner = Pick<GitRunner, "run"> & { readonly cwd: string }

export async function loadBranchReview(runner: CommandRunner, baseRef: string): Promise<BranchReviewSnapshot> {
  const baseOid = await resolveRefOid(runner, baseRef)
  if (baseOid === undefined) throw new Error(`base ref does not resolve to a commit: ${baseRef}`)
  const headOid = await resolveRefOid(runner, "HEAD")
  if (headOid === undefined) throw new Error("HEAD does not resolve to a commit")

  const mergeBaseOid = (await runner.run(["merge-base", baseRef, "HEAD"], { readOnly: true })).stdout.trim()
  const patchText = (await runner.run(["diff", "--no-ext-diff", "--no-color", "--find-renames", "--binary", `${baseRef}...HEAD`, "--"], { readOnly: true })).stdout
  const numstatText = (await runner.run(["diff", "--no-ext-diff", "--no-color", "--find-renames", "--numstat", "-z", `${baseRef}...HEAD`, "--"], { readOnly: true })).stdout
  const commitCountRaw = (await runner.run(["rev-list", "--count", `${baseRef}..HEAD`], { readOnly: true })).stdout.trim()
  const parsedCount = Number.parseInt(commitCountRaw, 10)
  const commitCount = Number.isFinite(parsedCount) && parsedCount >= 0 ? parsedCount : 0
  const stats = parseNumstat(numstatText)
  const files: ChangedFile[] = stats.map((stat) => ({
    path: stat.path,
    ...(stat.previousPath === undefined ? {} : { previousPath: stat.previousPath }),
    indexStatus: ".",
    worktreeStatus: "M",
    untracked: false,
    conflicted: false,
    additions: stat.additions,
    deletions: stat.deletions,
  }))
  const branch = (await runner.run(["symbolic-ref", "--quiet", "--short", "HEAD"], { readOnly: true })).stdout.trim()
  const reviewTarget = { kind: "branch" as const, baseRef, baseOid, headOid }
  return {
    repositoryRoot: runner.cwd,
    branch,
    baseRef,
    baseOid,
    headOid,
    mergeBaseOid,
    commitCount,
    reviewTarget,
    files,
    patches: [{ label: "BRANCH", text: patchText }],
  }
}
