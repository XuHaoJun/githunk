export type RawDiffEntry = {
  readonly oldMode: string
  readonly newMode: string
  readonly oldBlobOid: string
  readonly newBlobOid: string
  readonly status: string
  readonly score: number | undefined
  readonly path: string
  readonly previousPath?: string
}

function normalizeDiffPath(p: string | undefined): string | undefined {
  return p?.replace(/[\r\n]+$/u, "")
}

/**
 * Parse `git diff --raw -z` NUL-framed output into per-file raw entries.
 * Each metadata record starts with `:` and contains `oldMode newMode oldOid newOid status[score]`.
 * For renames/copies (R/C) two paths follow; otherwise one path.
 */
export function parseRawDiffZ(raw: string): readonly RawDiffEntry[] {
  if (raw.length === 0) return []
  const parts = raw.split("\0")
  const entries: RawDiffEntry[] = []

  for (let i = 0; i < parts.length; ) {
    const meta = parts[i]
    if (meta === undefined || meta.length === 0) {
      i++
      continue
    }
    if (!meta.startsWith(":")) {
      // stray path without metadata – skip
      i++
      continue
    }
    // Expected: :oldMode newMode oldOid newOid status
    // Modes are numbers (e.g. 100644), OIDs are hex (40 or 64). Status is letter + optional score digits.
    const m = meta.match(/^:(\d+) (\d+) ([0-9a-f]+) ([0-9a-f]+) ([A-Za-z])(\d*)$/)
    if (!m) {
      throw new Error(`invalid raw diff metadata: ${JSON.stringify(meta)}`)
    }
    const [, oldMode, newMode, oldBlobOid, newBlobOid, statusLetter, scoreStr] = m
    const score = scoreStr ? Number.parseInt(scoreStr, 10) : undefined
    const status = statusLetter + (scoreStr ?? "")
    const isRenameOrCopy = statusLetter === "R" || statusLetter === "C"

    if (isRenameOrCopy) {
      const previousPath = normalizeDiffPath(parts[i + 1])
      const path = normalizeDiffPath(parts[i + 2])
      if (previousPath === undefined || path === undefined) {
        throw new Error(`missing paths for rename/copy raw entry at index ${i}`)
      }
      entries.push({
        oldMode: oldMode!,
        newMode: newMode!,
        oldBlobOid: oldBlobOid!,
        newBlobOid: newBlobOid!,
        status,
        score,
        path,
        previousPath,
      })
      i += 3
    } else {
      const path = normalizeDiffPath(parts[i + 1])
      if (path === undefined) {
        throw new Error(`missing path for raw entry at index ${i}`)
      }
      entries.push({
        oldMode: oldMode!,
        newMode: newMode!,
        oldBlobOid: oldBlobOid!,
        newBlobOid: newBlobOid!,
        status,
        score,
        path,
      })
      i += 2
    }
  }

  return entries
}

export type NumstatEntry = {
  readonly path: string
  readonly previousPath?: string
  readonly additions: number | null
  readonly deletions: number | null
}

function countOrNull(value: string): number | null {
  if (value === "-") return null
  const n = Number.parseInt(value, 10)
  return Number.isFinite(n) && n >= 0 ? n : null
}

/**
 * Parse `git diff --numstat -z` NUL-framed output.
 * Uses same rename handling as src/git/diff.ts but maps "-" to null for binary.
 */
export function parseNumstatZ(raw: string): readonly NumstatEntry[] {
  if (raw.length === 0) return []
  const records = raw.split("\0")
  const entries: NumstatEntry[] = []
  for (let i = 0; i < records.length; i++) {
    const record = records[i] ?? ""
    if (record.length === 0) continue
    const firstTab = record.indexOf("\t")
    const secondTab = firstTab < 0 ? -1 : record.indexOf("\t", firstTab + 1)
    if (firstTab < 0 || secondTab < 0) continue
    const additions = countOrNull(record.slice(0, firstTab))
    const deletions = countOrNull(record.slice(firstTab + 1, secondTab))
    const path = record.slice(secondTab + 1)
    if (path.length === 0 && records[i + 1] !== undefined && records[i + 2] !== undefined) {
      const previousPath = records[i + 1] ?? ""
      const currentPath = records[i + 2] ?? ""
      entries.push({ path: currentPath, previousPath, additions, deletions })
      i += 2
    } else {
      entries.push({ path, additions, deletions })
    }
  }
  return entries
}
