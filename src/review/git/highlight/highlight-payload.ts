export type HighlightToken = Readonly<{ text: string; fg?: string }>

export type HighlightedLine = readonly HighlightToken[] | null

export type HighlightPayload = Readonly<{
  readonly fileKey: string
  readonly language?: string
  readonly deletionLines: readonly HighlightedLine[]
  readonly additionLines: readonly HighlightedLine[]
  readonly theme: "dark" | "light"
}>

export const MAX_HIGHLIGHTED_DIFF_LINES = 10_000
