import { cleanLastNewline } from "@pierre/diffs"

export type HastNode = HastTextNode | HastElementNode

interface HastTextNode {
  type: "text"
  value: string
}

interface HastElementNode {
  type: "element"
  tagName: string
  properties?: Record<string, unknown>
  children?: HastNode[]
}

export interface HastHighlightRun {
  text: string
  fg?: string
  wordDiff: boolean
}

const EMPTY_STYLE_VALUES = new Map<string, string>()
const parsedStyleValueCache = new Map<string, Map<string, string>>()

function parseStyleValue(styleValue: unknown) {
  if (typeof styleValue !== "string") return EMPTY_STYLE_VALUES
  const cached = parsedStyleValueCache.get(styleValue)
  if (cached) return cached
  const styles = new Map<string, string>()
  for (const segment of styleValue.split(";")) {
    const trimmed = segment.trim()
    if (!trimmed) continue
    const colon = trimmed.indexOf(":")
    if (colon === -1) continue
    const key = trimmed.slice(0, colon).trim()
    const value = trimmed.slice(colon + 1).trim()
    if (key && value) styles.set(key, value)
  }
  parsedStyleValueCache.set(styleValue, styles)
  return styles
}

function appendRun(target: HastHighlightRun[], next: HastHighlightRun) {
  const last = target[target.length - 1]
  if (last && last.fg === next.fg && last.wordDiff === next.wordDiff) {
    last.text += next.text
    return
  }
  target.push(next)
}

export function collectHastHighlightRuns(node: HastNode | undefined, appearance: "dark" | "light"): HastHighlightRun[] {
  if (!node) return []
  const runs: HastHighlightRun[] = []
  const stack: Array<{ node: HastNode; fg?: string; wordDiff: boolean }> = [{ node, wordDiff: false }]
  while (stack.length > 0) {
    const { node: cur, fg, wordDiff } = stack.pop()!
    if (cur.type === "text") {
      if (cur.value) {
        if (fg) appendRun(runs, { text: cur.value, fg, wordDiff })
        else appendRun(runs, { text: cur.value, wordDiff })
      }
      continue
    }
    // element
    const props = cur.properties ?? {}
    const style = parseStyleValue((props as Record<string, unknown>)["style"])
    const color = style.get("color")
    const bg = style.get("background-color")
    // wordDiff detection: if background present and not theme background, mark wordDiff (simplified)
    const isWordDiff = bg !== undefined && bg !== "transparent"
    const nextFg = color ?? fg
    const nextWordDiff = wordDiff || isWordDiff
    const pushFg = nextFg as string | undefined
    const children = cur.children ?? []
    // push reverse to preserve order
    for (let i = children.length - 1; i >= 0; i--) {
      const entry: { node: HastNode; fg?: string; wordDiff: boolean } = { node: children[i]!, wordDiff: nextWordDiff }
      if (pushFg) entry.fg = pushFg
      stack.push(entry)
    }
  }
  // reverse because we popped LIFO? Actually we pushed reverse so order correct
  // but runs were appended in DFS order already; no need to reverse.
  return runs
}

export function hastLinesToTokens(lines: Array<HastNode | undefined>, appearance: "dark" | "light"): Array<readonly { text: string; fg?: string }[] | null> {
  return lines.map((node) => {
    if (!node) return null
    const runs = collectHastHighlightRuns(node, appearance)
    if (runs.length === 0) return []
    return runs.map((r) => (r.fg ? { text: r.text, fg: r.fg } : { text: r.text }))
  })
}
