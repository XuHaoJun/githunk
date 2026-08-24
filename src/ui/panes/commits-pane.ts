import type { CliRenderer } from "@opentui/core"
import type { AppModel } from "../../app/model"
import type { CommitSummary } from "../../domain/commit"
import { createPane, type PaneHandle } from "./common"

const cursors = new WeakMap<PaneHandle, number>()
const selectedOids = new WeakMap<PaneHandle, string>()
export function createCommitsPane(renderer: CliRenderer, model: AppModel): PaneHandle {
  const pane = createPane(renderer, "commits", "4 Commits", "No commit selected")
  updateCommitsPane(pane, model)
  return pane
}

export function getSelectedCommit(pane: PaneHandle, model: AppModel): CommitSummary | undefined {
  const commits = model.commits ?? []
  const selectedOid = selectedOids.get(pane)
  if (selectedOid !== undefined) return commits.find((commit) => commit.oid === selectedOid)
  return commits[cursors.get(pane) ?? 0]
}

export function moveCommitsCursor(pane: PaneHandle, model: AppModel, direction: "next" | "previous"): CommitSummary | undefined {
  const commits = model.commits ?? []
  if (commits.length === 0) return undefined
  const current = cursors.get(pane) ?? 0
  const next = Math.max(0, Math.min(commits.length - 1, current + (direction === "next" ? 1 : -1)))
  cursors.set(pane, next)
  selectedOids.set(pane, commits[next]!.oid)
  updateCommitsPane(pane, model)
  return commits[next]
}

export function updateCommitsPane(pane: PaneHandle, model: AppModel): void {
  const commits = model.commits ?? []
  const previous = selectedOids.get(pane)
  const preserved = previous === undefined ? -1 : commits.findIndex((commit) => commit.oid === previous)
  const index = preserved >= 0 ? preserved : Math.min(cursors.get(pane) ?? 0, Math.max(0, commits.length - 1))
  if (commits.length === 0) {
    cursors.delete(pane)
    selectedOids.delete(pane)
    pane.update(model.loading ? "Loading…" : "No commits")
    return
  }
  selectedOids.set(pane, commits[index]!.oid)
  cursors.set(pane, index)
  const lines = commits.map((commit, commitIndex) => `${commitIndex === index ? "▸" : " "} ${commit.shortOid} ${commit.subject}`)
  pane.update(lines.join("\n"))
  pane.box.bottomTitle = `${index + 1}/${commits.length}: ${commits[index]?.subject ?? "No commit selected"}`
}

export function commitsCursorIndex(pane: PaneHandle): number {
  return cursors.get(pane) ?? 0
}
