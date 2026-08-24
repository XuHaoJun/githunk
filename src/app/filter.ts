/** A text projection used to search an item. */
export type SearchableText<T> = (item: T) => string

/**
 * Normalizes user-facing search text without losing Unicode characters.
 * NFKC makes equivalent compatibility forms searchable and locale-independent
 * lower-casing handles non-ASCII letters (unlike ASCII-only regexes).
 */
export function normalizeSearchText(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase()
}

/**
 * Return matching items in their original order. An empty query deliberately
 * returns the original readonly collection, which keeps empty/zero-result
 * views deterministic and avoids an allocation on the common path.
 */
export function filterItems<T>(
  query: string,
  items: readonly T[],
  searchableText: SearchableText<T>,
): readonly T[] {
  const normalizedQuery = normalizeSearchText(query.trim())
  if (normalizedQuery.length === 0) return items
  return items.filter((item) => normalizeSearchText(searchableText(item)).includes(normalizedQuery))
}

/** Find the selected item by its stable identifier after a filter changes. */
export function indexForStableId<T>(
  items: readonly T[],
  stableId: string | undefined,
  getStableId: (item: T) => string,
  fallback = 0,
): number {
  if (items.length === 0) return 0
  if (stableId !== undefined) {
    const match = items.findIndex((item) => getStableId(item) === stableId)
    if (match >= 0) return match
  }
  return Math.max(0, Math.min(items.length - 1, fallback))
}

/**
 * Unicode-safe removal of the last user-perceived character. Array slicing by
 * UTF-16 code unit would leave surrogate pairs (or combining sequences) behind.
 */
export function removeLastSearchCharacter(value: string): string {
  const segments = [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(value)]
  segments.pop()
  return segments.map((segment) => segment.segment).join("")
}
