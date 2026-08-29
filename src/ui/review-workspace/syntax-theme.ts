export type HighlightAppearance = "dark" | "light"

export function syntaxThemeForAppearance(appearance: HighlightAppearance): string {
  return appearance === "light" ? "github-light-default" : "github-dark-default"
}

/**
 * Resolve effective appearance from terminal. For now default to dark;
 * future: read terminal palette or renderer background.
 * Keeping simple to satisfy spec without coupling to @opentui/core internals.
 */
export function getEffectiveHighlightAppearance(): HighlightAppearance {
  // Check env var for light mode (e.g., GH_LIGHT)
  const bg = (typeof process !== "undefined" ? process.env["GH_LIGHT_BG"] : undefined) as string | undefined
  if (bg === "light") return "light"
  return "dark"
}

export function syntaxHighlightThemeName(appearance: HighlightAppearance): string {
  return syntaxThemeForAppearance(appearance)
}
