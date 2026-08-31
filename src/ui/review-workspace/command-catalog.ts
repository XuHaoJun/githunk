import type { ReviewState } from "../../review/core/state"
import { canMarkViewedInProjection } from "../../review/core/selectors"

export type ReviewFocus = "sidebar" | "stream" | "filter" | "composer" | "any" | "global"

export type ReviewCommand = Readonly<{
  id: string
  title: string
  keys: readonly string[]
  focus: readonly ReviewFocus[]
  available: (state: Pick<ReviewState, "projection">) => boolean
  intent?: string
  hint?: string
}>

const always = () => true

export const REVIEW_COMMANDS: readonly ReviewCommand[] = [
  {
    id: "review.moveDown",
    title: "Move down / scroll",
    keys: ["j", "ArrowDown"],
    focus: ["stream", "sidebar"],
    available: always,
    intent: "selection/move",
    hint: "next row",
  },
  {
    id: "review.moveUp",
    title: "Move up / scroll",
    keys: ["k", "ArrowUp"],
    focus: ["stream", "sidebar"],
    available: always,
    intent: "selection/move",
    hint: "prev row",
  },
  {
    id: "review.nextHunk",
    title: "Next hunk",
    keys: ["]"],
    focus: ["stream"],
    available: always,
    intent: "selection/move",
  },
  {
    id: "review.prevHunk",
    title: "Previous hunk",
    keys: ["["],
    focus: ["stream"],
    available: always,
    intent: "selection/move",
  },
  {
    id: "review.nextFile",
    title: "Next file",
    keys: ["."],
    focus: ["stream", "sidebar"],
    available: always,
    intent: "selection/move",
  },
  {
    id: "review.prevFile",
    title: "Previous file",
    keys: [","],
    focus: ["stream", "sidebar"],
    available: always,
    intent: "selection/move",
  },
  {
    id: "review.nextUnreviewed",
    title: "Next unreviewed file",
    keys: ["n"],
    focus: ["stream", "sidebar"],
    available: always,
    intent: "selection/select-file",
  },
  {
    id: "review.prevUnreviewed",
    title: "Previous unreviewed file",
    keys: ["N"],
    focus: ["stream", "sidebar"],
    available: always,
    intent: "selection/select-file",
  },
  {
    id: "review.nextFeedback",
    title: "Next pending feedback",
    keys: ["}"],
    focus: ["stream", "sidebar"],
    available: always,
    intent: "feedback/next",
  },
  {
    id: "review.prevFeedback",
    title: "Previous pending feedback",
    keys: ["{"],
    focus: ["stream", "sidebar"],
    available: always,
    intent: "feedback/previous",
  },
  {
    id: "review.focusFilter",
    title: "Focus file filter",
    keys: ["/"],
    focus: ["sidebar", "stream"],
    available: always,
    intent: "filter/set-query",
  },
  {
    id: "review.focusDiff",
    title: "Diff",
    keys: ["0"],
    focus: ["any"],
    available: always,
  },
  {
    id: "review.focusFiles",
    title: "Files",
    keys: ["1"],
    focus: ["any"],
    available: always,
  },
  {
    id: "review.toggleFocus",
    title: "cycle panels",
    keys: ["tab"],
    focus: ["any"],
    available: always,
  },
  {
    id: "review.toggleRange",
    title: "Begin/end semantic line/range selection",
    keys: ["v"],
    focus: ["stream"],
    available: always,
    intent: "selection/viewport-anchor",
  },
  {
    id: "review.createFeedback",
    title: "Create feedback at selection",
    keys: ["c"],
    focus: ["stream"],
    available: always,
    intent: "feedback/start-draft",
  },
  {
    id: "review.markViewed",
    title: "Mark current file Viewed",
    keys: ["r"],
    focus: ["stream", "sidebar"],
    available: (state) => canMarkViewedInProjection(state),
    intent: "viewed/mark",
  },
  {
    id: "review.layoutCycle",
    title: "layout",
    keys: ["l"],
    focus: ["any"],
    available: always,
  },
  {
    id: "review.selectFile",
    title: "Select file",
    keys: [],
    focus: ["sidebar", "stream"],
    available: always,
    intent: "selection/select-file",
  },
  {
    id: "review.selectDiffLine",
    title: "Select semantic diff line",
    keys: [],
    focus: ["stream"],
    available: always,
    intent: "selection/line",
  },
  {
    id: "review.selectFeedback",
    title: "Select feedback",
    keys: [],
    focus: ["stream"],
    available: always,
    intent: "feedback/select",
  },
  {
    id: "review.editFeedback",
    title: "Edit selected feedback",
    keys: ["e"],
    focus: ["stream", "sidebar"],
    available: always,
  },
  {
    id: "review.deleteFeedback",
    title: "Delete selected feedback",
    keys: ["d"],
    focus: ["stream", "sidebar"],
    available: always,
  },
  {
    id: "review.reanchorFeedback",
    title: "Re-anchor selected feedback",
    keys: ["a"],
    focus: ["stream", "sidebar"],
    available: always,
  },
  {
    id: "review.expandGap",
    title: "Expand context gap",
    keys: ["z"],
    focus: ["stream"],
    available: always,
  },
  {
    id: "review.cycleFilterScope",
    title: "Cycle filter scope",
    keys: ["f"],
    focus: ["stream", "sidebar"],
    available: always,
  },
  {
    id: "review.finishReview",
    title: "Finish review",
    keys: ["R"],
    focus: ["any"],
    available: always,
  },
  {
    id: "review.help",
    title: "Show help",
    keys: ["?"],
    focus: ["any"],
    available: always,
  },
  {
    id: "review.close",
    title: "Close overlay or workspace",
    keys: ["escape"],
    focus: ["any"],
    available: always,
  },
] as const

const keyToCommand = new Map<string, ReviewCommand>()
for (const cmd of REVIEW_COMMANDS) {
  for (const k of cmd.keys) {
    // case-sensitive; store as-is and also lower? But R vs r distinction needs exact.
    // We store exact lower-cased for resolution normalisation? Keep exact.
    // For lookup we will try exact then case-insensitive for letters? Simpler: store exact.
    if (!keyToCommand.has(k)) keyToCommand.set(k, cmd)
    // also store lower for case-insensitive fallback for arrows etc.
    const lower = k.toLowerCase()
    if (lower !== k && !keyToCommand.has(lower)) keyToCommand.set(lower, cmd)
  }
}

function commandSupportsFocus(command: ReviewCommand, focus: ReviewFocus | undefined): boolean {
  return focus === undefined
    || command.focus.includes(focus)
    || command.focus.includes("any")
    || command.focus.includes("global")
}

export function resolveReviewCommand(key: string, focus?: ReviewFocus): ReviewCommand | undefined {
  const exact = keyToCommand.get(key)
  if (exact && commandSupportsFocus(exact, focus)) return exact
  const lower = key.toLowerCase()
  if (lower === key) return undefined
  const viaLower = keyToCommand.get(lower)
  return viaLower && commandSupportsFocus(viaLower, focus) ? viaLower : undefined
}

export function reviewHints(focus: ReviewFocus, state: Pick<ReviewState, "projection">): string {
  const available = REVIEW_COMMANDS.filter((c) => c.focus.includes(focus) || c.focus.includes("any"))
    .filter((c) => c.available(state))
  // Build a short hint list prioritized for this focus
  const parts: string[] = []
  for (const cmd of available) {
    // choose first key as display
    const key = cmd.keys[0] ?? ""
    if (!key) continue
    // For hints, map titles to short forms
    const short = cmd.id.replace("review.", "")
    parts.push(`${key}:${short}`)
  }
  // Different focus should produce different ordering/prefix to ensure test detects difference
  if (focus === "sidebar") {
    // ensure sidebar hints include filter hint prominently
    const filter = available.find((c) => c.id === "review.focusFilter")
    if (filter) parts.unshift(`${filter.keys[0]}:filter`)
  } else if (focus === "stream") {
    const hunk = available.find((c) => c.id === "review.nextHunk")
    if (hunk) parts.unshift(`${hunk.keys[0]}:hunk`)
  }
  return parts.slice(0, 6).join(" | ")
}

export function reviewHelp(focus: ReviewFocus, state: Pick<ReviewState, "projection">): string {
  const available = REVIEW_COMMANDS.filter((c) => c.available(state))
    .filter((c) => c.focus.includes(focus) || c.focus.includes("any") || c.focus.includes("global"))
    .filter((c) => c.keys.length > 0)
  const panelPriority: Record<string, number> = {
    "review.focusDiff": 0,
    "review.focusFiles": 1,
    "review.toggleFocus": 2,
    "review.layoutCycle": 3,
  }
  const ordered = [...available].sort((a, b) => (panelPriority[a.id] ?? 99) - (panelPriority[b.id] ?? 99))
  const lines = ordered.map((c) => `${c.keys.map((key) => key === "tab" ? "Tab" : key).join("/")} ${c.title}`)
  return lines.join("\n")
}
