import type { CliRenderer, StyledText } from "@opentui/core"
import type { AppModel } from "../../app/model"
import type { CommitStatus, CommitSummary } from "../../domain/commit"
import type { TagSummary } from "../../domain/tag"
import { filterItems } from "../../app/filter"
import { createPane, type PaneHandle } from "./common"
import { commitGraphRows } from "../commit-graph"
import { AUTHOR_COLUMN_WIDTH, authorColor, authorInitials } from "../author-style"
import { createListState, renderListRows, selectListRow, type ListColumnSegment, type ListState, type ListRow } from "../list-view"
import { installListText, releaseListText } from "./list-text"
import { COMMITS_JUMP_KEY, COMMITS_TABS } from "./reflog-pane"
import { COMMIT_HASH_DEFAULT_FG, COMMIT_HASH_MERGED_FG, COMMIT_HASH_PUSHED_FG, COMMIT_HASH_UNPUSHED_FG, COMMIT_TAG_FG } from "../theme"

const paneStates = new WeakMap<PaneHandle, ListState>()

/**
 * Cursor index past which the full history loads. lazygit's
 * `COMMIT_THRESHOLD = 200` (pkg/gui/controllers/local_commits_controller.go:22):
 * past this point the user is browsing deep enough that the 300-cap must go.
 */
export const COMMIT_THRESHOLD = 200

export function formatRelativeTime(authoredAt: string, now: Date): string {
  const date = new Date(authoredAt)
  if (Number.isNaN(date.getTime())) return ""
  const diffMs = now.getTime() - date.getTime()
  const seconds = Math.floor(diffMs / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days}d`
  const months = Math.floor(days / 30)
  if (months < 12) return `${months}mo`
  return `${Math.floor(months / 12)}y`
}

/**
 * lazygit's `getHashColor` switch on `models.CommitStatus`
 * (pkg/gui/presentation/commits.go:575-587): the hash is coloured by whether the commit has
 * been pushed, is merged into the main branch, or is still local-only.
 */
function commitHashColor(status: CommitStatus | undefined) {
  switch (status) {
    case "unpushed":
      return COMMIT_HASH_UNPUSHED_FG
    case "pushed":
      return COMMIT_HASH_PUSHED_FG
    case "merged":
      return COMMIT_HASH_MERGED_FG
    default:
      return COMMIT_HASH_DEFAULT_FG
  }
}

/**
 * Commit oid → the tags pointing at it, from the repository's tag list. `listTags` peels annotated
 * tags (`%(*objectname)`), so `targetOid` is the tagged commit for both kinds. lazygit reads the
 * same association out of `git log`'s `%D` decorations, taking every `tag: <name>` field of a
 * commit line as one of its tags (`commit_loader.go:625` format, `parseCommitLine` at 222-232).
 */
export function tagNamesByCommit(tags: readonly TagSummary[] | undefined): Readonly<Record<string, readonly string[]>> {
  const byOid: Record<string, string[]> = {}
  for (const tag of tags ?? []) {
    const names = byOid[tag.targetOid]
    if (names === undefined) byOid[tag.targetOid] = [tag.name]
    else names.push(tag.name)
  }
  return byOid
}

/**
 * Lazygit column order (`pkg/gui/presentation/commits.go:displayCommit`):
 * hash → author initials → graph+tags+subject as one trailing column, with the
 * relative time trailing (githunk extension — lazygit has no time column).
 * The graph, tags and subject share one flex column exactly because lazygit's
 * `getPaddedDisplayStrings` (`pkg/utils/formatting.go:134-155`) pads every
 * column except the last: `graphLine+mark+tag+name` is a single unpadded
 * string, so a narrow lane never pads out to the widest lane's width. A
 * separate graph column padded to the max lane is where the blank gap came
 * from on complex graphs. The flex truncates the subject tail first; time
 * (priority 0) is the last column ever shed, so it survives narrow widths.
 * The graph's pipe colour is the author colour, exactly as lazygit's
 * `loadPipesets` derives it, so a lane and its author read as one thing.
 *
 * Tags sit between the graph and the subject (`presentation/commits.go:481-489`): `tag1 tag2 `
 * in `DiffTerminalColor` (magenta) bold, the separating space uncoloured.
 */
export function buildCommitRows(commits: readonly CommitSummary[], now: Date, filter = "", tags?: readonly TagSummary[]): ListRow[] {
  const graphs = commitGraphRows(commits, (_commit, index) => authorColor(commits[index]!.authorName))
  const tagsByOid = tagNamesByCommit(tags)
  const rows = commits.map((commit, index) => {
    const graph = graphs[index]
    const shortHash = commit.oid.length >= 8 ? commit.oid.slice(0, 8) : commit.shortOid
    const initials = authorInitials(commit.authorName).padEnd(AUTHOR_COLUMN_WIDTH, " ")
    const relative = formatRelativeTime(commit.authoredAt, now)
    const graphText = graph?.text ?? ""
    const graphSegments = graph?.segments ?? []
    const subjectSegments = commit.subject.length === 0 ? [] : [{ text: commit.subject } as const]
    const tagLabel = tagsByOid[commit.oid]?.join(" ") ?? ""
    const tagSegments: ListColumnSegment[] = tagLabel.length === 0 ? [] : [{ text: tagLabel, color: COMMIT_TAG_FG, bold: true }, { text: " " }]
    return {
      id: commit.oid,
      columns: [
        { text: shortHash, priority: 1, color: commitHashColor(commit.status) },
        { text: initials, priority: 2, color: authorColor(commit.authorName) },
        { text: `${graphText}${tagLabel.length === 0 ? "" : `${tagLabel} `}${commit.subject}`, priority: 2, flex: true, segments: [...graphSegments, ...tagSegments, ...subjectSegments] },
        { text: relative, priority: 0, style: "dim" as const }
      ]
    }
  })
  if (filter.length === 0) return rows
  return [...filterItems(filter, rows, (row) => `${row.columns[0]?.text ?? ""} ${row.columns[2]?.text ?? row.id}`)]
}

export function renderCommitRows(
  commits: readonly CommitSummary[],
  options: { readonly selectedId?: string; readonly focused: boolean; readonly width: number; readonly now?: Date | number; readonly tags?: readonly TagSummary[] }
): { readonly content: StyledText; readonly plainText: string; readonly state: ListState } {
  const nowDate = options.now === undefined ? new Date() : options.now instanceof Date ? options.now : new Date(options.now)
  const rows = buildCommitRows(commits, nowDate, "", options.tags)
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
  const pane = createPane(renderer, "commits", "", "No commit selected", false, {
    tabs: { jumpKey: COMMITS_JUMP_KEY, tabs: COMMITS_TABS }
  })
  updateCommitsPane(pane, model)
  return pane
}

export function getCommitsListState(pane: PaneHandle): ListState | undefined {
  return paneStates.get(pane)
}

export function getSelectedCommit(pane: PaneHandle, model: AppModel): CommitSummary | undefined {
  const commits = model.commits ?? []
  const state = paneStates.get(pane)
  if (state === undefined || state.selectedId === undefined) return undefined
  return commits.find((commit) => commit.oid === state.selectedId)
}

export function moveCommitsCursor(pane: PaneHandle, model: AppModel, direction: "next" | "previous"): CommitSummary | undefined {
  const commits = model.commits ?? []
  if (commits.length === 0) return undefined
  const state = paneStates.get(pane)
  if (state === undefined) return undefined
  const currentIndex = state.selectedIndex
  const delta = direction === "next" ? 1 : -1
  const nextIndex = Math.max(0, Math.min(commits.length - 1, currentIndex + delta))
  if (nextIndex === currentIndex) return commits[currentIndex]
  const nextState = selectListRow(state, commits[nextIndex]!.oid)
  paneStates.set(pane, nextState)
  const width = 80
  installListText(pane.text, { state: nextState, width, focused: true })
  return commits[nextIndex]
}

export function updateCommitsPane(pane: PaneHandle, model: AppModel): void {
  const commits = model.commits ?? []
  if (commits.length === 0) {
    const empty = createListState([])
    paneStates.set(pane, empty)
    releaseListText(pane.text)
    pane.update(model.loading ? "Loading…" : "No commits")
    return
  }
  const previous = paneStates.get(pane)
  const prevId = previous?.selectedId
  const rows = buildCommitRows(commits, new Date(), "", model.tags)
  let state = createListState(rows)
  if (prevId !== undefined) {
    const withPrev = selectListRow(state, prevId)
    if (withPrev.selectedId === prevId) state = withPrev
  }
  paneStates.set(pane, state)
  installListText(pane.text, { state, width: 80, focused: false })
  pane.box.bottomTitle = undefined
}

export function commitsCursorIndex(pane: PaneHandle): number {
  return paneStates.get(pane)?.selectedIndex ?? 0
}
