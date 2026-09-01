import { basename, dirname } from "node:path/posix"
import { visibleReviewFiles } from "../../review/core/selectors"
import type { ReviewState } from "../../review/core/state"
import type { ReviewFile } from "../../review/core/types"

// Mirrors learn-projects/hunk/src/ui/lib/files.ts and terminalText.ts exactly

export type ReviewSidebarFileEntry = Readonly<{
  kind: "file"
  id: string
  name: string
  path: string
  previousPath?: string | undefined
  agentCommentsText: string | null
  additionsText: string | null
  deletionsText: string | null
  changeType: "new" | "deleted" | "rename-pure" | "rename-changed" | "change"
  isUntracked: boolean
}>

export type ReviewSidebarGroupEntry = Readonly<{
  kind: "group"
  id: string
  label: string
}>

export type ReviewSidebarEntry = ReviewSidebarFileEntry | ReviewSidebarGroupEntry

function normalizeDiffPath(p: string | undefined): string | undefined {
  return p?.replace(/[\r\n]+$/u, "")
}

function formatTerminalPath(path: string): string {
  let formatted = ""
  for (const character of path) {
    const codePoint = character.codePointAt(0)!

    if (character === "\\") {
      formatted += "\\\\"
    } else if (character === "\t") {
      formatted += "\\t"
    } else if (character === "\n") {
      formatted += "\\n"
    } else if (character === "\r") {
      formatted += "\\r"
    } else if (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f)) {
      formatted += `\\x${codePoint.toString(16).padStart(2, "0")}`
    } else {
      formatted += character
    }
  }
  return formatted
}

function sidebarFileName(file: { path: string; previousPath?: string }): string {
  const path = formatTerminalPath(normalizeDiffPath(file.path) ?? file.path)
  const previousPath = file.previousPath ? formatTerminalPath(normalizeDiffPath(file.previousPath) ?? file.previousPath) : undefined

  if (previousPath === undefined || previousPath === path) {
    return basename(path)
  }

  const previousName = basename(previousPath)
  const nextName = basename(path)
  return previousName === nextName ? nextName : `${previousName} -> ${nextName}`
}

function formatSidebarStat(prefix: "+" | "-", value: number | null | undefined, truncated = false): string | null {
  const n = typeof value === "number" ? value : 0
  if (value === null || value === undefined) return null
  return n > 0 ? `${prefix}${n}${truncated ? "+" : ""}` : null
}

export function sidebarEntryStats(
  entry: Pick<ReviewSidebarFileEntry, "agentCommentsText" | "additionsText" | "deletionsText">,
): Array<{ kind: "agent-comment" | "addition" | "deletion"; text: string }> {
  const stats: Array<{ kind: "agent-comment" | "addition" | "deletion"; text: string }> = []

  if (entry.agentCommentsText) {
    stats.push({ kind: "agent-comment", text: entry.agentCommentsText })
  }

  if (entry.additionsText) {
    stats.push({ kind: "addition", text: entry.additionsText })
  }

  if (entry.deletionsText) {
    stats.push({ kind: "deletion", text: entry.deletionsText })
  }

  return stats
}

export function sidebarEntryStatsWidth(
  entry: Pick<ReviewSidebarFileEntry, "agentCommentsText" | "additionsText" | "deletionsText">,
): number {
  return sidebarEntryStats(entry).reduce((width, stat, index) => width + stat.text.length + (index > 0 ? 1 : 0), 0)
}

function changeTypeForKind(kind: ReviewFile["kind"]): ReviewSidebarFileEntry["changeType"] {
  switch (kind) {
    case "added":
      return "new"
    case "deleted":
      return "deleted"
    case "renamed":
      return "rename-changed"
    case "copied":
      return "change"
    case "modified":
      return "change"
    case "binary":
      return "change"
    default:
      return "change"
  }
}

export function buildReviewSidebarEntries(state: ReviewState): readonly ReviewSidebarEntry[] {
  const visible = visibleReviewFiles(state)
  const feedbackByKey = new Map<string, number>()
  for (const fb of state.feedback) {
    const k = fb.anchor.fileKey
    feedbackByKey.set(k, (feedbackByKey.get(k) ?? 0) + 1)
  }

  const entries: ReviewSidebarEntry[] = []
  let activeGroup: string | undefined

  visible.forEach((file, index) => {
    const path = formatTerminalPath(normalizeDiffPath(file.path) ?? file.path)
    const group = dirname(path)

    if (group !== activeGroup) {
      activeGroup = group
      entries.push({
        kind: "group",
        id: `group:${group}:${index}`,
        label: group === "." ? "./" : `${group}/`,
      })
    }

    const agentCount = feedbackByKey.get(file.key) ?? 0
    const additions = file.stats.additions
    const deletions = file.stats.deletions

    const baseEntry: ReviewSidebarFileEntry = {
      kind: "file",
      id: file.key,
      name: sidebarFileName(file),
      path: file.path,
      agentCommentsText: agentCount > 0 ? `*${agentCount}` : null,
      additionsText: formatSidebarStat("+", additions, false),
      deletionsText: formatSidebarStat("-", deletions, false),
      changeType: changeTypeForKind(file.kind),
      isUntracked: false,
    }
    entries.push(file.previousPath === undefined ? baseEntry : { ...baseEntry, previousPath: file.previousPath })
  })

  return entries
}

// File-row id helper mirrors hunk's ids.ts:fileRowId
export function reviewFileRowId(fileKey: string): string {
  return `review-file-row:${fileKey}`
}

// Theme tokens mirroring hunk's ExtensionSidebarTheme / AppTheme panel slice
export const REVIEW_SIDEBAR_THEME = {
  panel: "#1e1e1e",
  panelAlt: "#2d2d30",
  text: "#cccccc",
  muted: "#858585",
  accent: "#007acc",
  badgeAdded: "#89d185",
  badgeRemoved: "#f85149",
  noteBorder: "#d7ba7d",
  fileNew: "#89d185",
  fileDeleted: "#f85149",
  fileRenamed: "#d7ba7d",
  fileModified: "#e5c07b",
  fileUntracked: "#858585",
} as const

export function getFileStateIcon(
  entry: ReviewSidebarFileEntry,
  theme: typeof REVIEW_SIDEBAR_THEME = REVIEW_SIDEBAR_THEME,
): { icon: string; color: string } {
  if (entry.isUntracked) {
    return { icon: "?", color: theme.fileUntracked }
  }

  switch (entry.changeType) {
    case "new":
      return { icon: "A", color: theme.fileNew }
    case "deleted":
      return { icon: "D", color: theme.fileDeleted }
    case "rename-pure":
    case "rename-changed":
      return { icon: "R", color: theme.fileRenamed }
    case "change":
      return { icon: "M", color: theme.fileModified }
    default:
      return { icon: "", color: theme.text }
  }
}
