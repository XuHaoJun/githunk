import type { CliRenderer, StyledText } from "@opentui/core"
import type { AppModel } from "../../app/model"
import type { CommitSummary } from "../../domain/commit"
import { createPane, type PaneHandle } from "./common"
import { commitGraphRows } from "../commit-graph"
import { createListState, renderListRows, selectListRow, type ListState, type ListRow } from "../list-view"

const paneStates = new WeakMap<PaneHandle, ListState>()

function formatRelativeTime(authoredAt: string, now: Date): string {
  const then = new Date(authoredAt).getTime()
  if (Number.isNaN(then)) return ""
  const diffMs = now.getTime() - then
  const diffSec = Math.round(diffMs / 1000)
  const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" })
  const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ["year", 365 * 24 * 60 * 60],
    ["month", 30 * 24 * 60 * 60],
    ["week", 7 * 24 * 60 * 60],
    ["day", 24 * 60 * 60],
    ["hour", 60 * 60],
    ["minute", 60],
    ["second", 1],
  ]
  for (const [unit, secs] of units) {
    if (Math.abs(diffSec) >= secs || unit === "second") {
      const value = Math.round(diffSec / secs)
      return rtf.format(-value, unit)
    }
  }
  return rtf.format(0, "second")
}

function getCommitAuthorInitials(authorName: string): string {
  if (authorName.length === 0) return ""
  const parts = authorName.trim().split(/\s+/)
  if (parts.length === 1) return parts[0]!.slice(0, 2)
  return `${parts[0]![0] ?? ""}${parts[1]![0] ?? ""}`
}

function buildRows(commits: readonly CommitSummary[], now: Date): ListRow[] {
  const graphs = commitGraphRows(commits)
  return commits.map((commit, index) => {
    const graph = graphs[index] ?? ""
    const shortHash = commit.oid.length >= 8 ? commit.oid.slice(0, 8) : commit.shortOid
    const authorInitials = getCommitAuthorInitials(commit.authorName)
    const relative = formatRelativeTime(commit.authoredAt, now)
    return {
      id: commit.oid,
      columns: [
        { text: shortHash, priority: 1, style: "yellow" },
        { text: authorInitials, priority: 3, style: "cyan" },
        { text: graph, priority: 0, style: "dim" },
        { text: commit.subject, priority: 2 },
        { text: relative, priority: 4, style: "dim" },
      ],
    }
  })
}

export function renderCommitRows(
  commits: readonly CommitSummary[],
  options: { readonly selectedId?: string; readonly focused: boolean; readonly width: number; readonly now?: Date | number },
): { readonly content: StyledText; readonly plainText: string; readonly state: ListState } {
  const nowDate = options.now === undefined ? new Date() : options.now instanceof Date ? options.now : new Date(options.now)
  const rows = buildRows(commits, nowDate)
  let state = createListState(rows)
  if (options.selectedId !== undefined) {
    const next = selectListRow(state, options.selectedId)
    state = next
  }
  const content = renderListRows(state, options.focused, options.width)
  const plainText = content.chunks.map((c) => c.text).join("")
  return { content, plainText, state }
}

export function createCommitsPane(renderer: CliRenderer, model: AppModel): PaneHandle {
  const pane = createPane(renderer, "commits", "4 Commits", "No commit selected")
  updateCommitsPane(pane, model)
  return pane
}

export function getCommitsListState(pane: PaneHandle): ListState | undefined {
  return paneStates.get(pane)
}

export function getSelectedCommit(pane: PaneHandle, model: AppModel): CommitSummary | undefined {
  const commits = model.commits ?? []
  const state = paneStates.get(pane)
  if (state?.selectedId !== undefined) return commits.find((c) => c.oid === state.selectedId)
  // Fallback to first if state missing
  const index = state?.selectedIndex ?? 0
  return commits[index]
}

export function moveCommitsCursor(pane: PaneHandle, model: AppModel, direction: "next" | "previous"): CommitSummary | undefined {
  const commits = model.commits ?? []
  if (commits.length === 0) return undefined
  let state = paneStates.get(pane)
  if (state === undefined) {
    updateCommitsPane(pane, model)
    state = paneStates.get(pane)
    if (state === undefined) return commits[0]
  }
  const delta = direction === "next" ? 1 : -1
  const current = state.selectedIndex
  const nextIndex = Math.max(0, Math.min(commits.length - 1, current + delta))
  const nextId = commits[nextIndex]!.oid
  const nextState = selectListRow(state, nextId)
  paneStates.set(pane, nextState)
  const content = renderListRows(nextState, true, 80)
  pane.update(content)
  return commits[nextIndex]
}


export function updateCommitsPane(pane: PaneHandle, model: AppModel): void {
  const commits = model.commits ?? []
  if (commits.length === 0) {
    const empty = createListState([])
    paneStates.set(pane, empty)
    pane.update(model.loading ? "Loading…" : "No commits")
    return
  }
  const previous = paneStates.get(pane)
  const prevId = previous?.selectedId
  const rows = buildRows(commits, new Date())
  let state = createListState(rows)
  if (prevId !== undefined) {
    const withPrev = selectListRow(state, prevId)
    // selectListRow returns same state if not found; preserve fallback
    if (withPrev.selectedId === prevId) state = withPrev
  }
  paneStates.set(pane, state)
  // Render with a generous width; full-row highlight visible when caller renders with focused true
  const content = renderListRows(state, false, 80)
  pane.update(content)
  pane.box.bottomTitle = undefined
}

export function commitsCursorIndex(pane: PaneHandle): number {
  return paneStates.get(pane)?.selectedIndex ?? 0
}
