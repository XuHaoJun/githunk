import type { CommitSummary } from "../domain/commit"

export function commitGraphRows(commits: readonly Pick<CommitSummary, "oid" | "parentOids">[]): readonly string[] {
  const lanes: string[] = []
  const rows: string[] = []
  let maxLen = 0

  for (const commit of commits) {
    let idx = lanes.indexOf(commit.oid)
    if (idx === -1) {
      lanes.push(commit.oid)
      idx = lanes.length - 1
    }

    // Build graph segment for this row before mutating lanes
    const chars: string[] = []
    for (let j = 0; j < lanes.length; j++) {
      chars.push(j === idx ? "●" : "│")
    }
    if (commit.parentOids.length > 1) {
      // Ensure merge row visibly branches
      if (idx + 1 < chars.length) {
        chars[idx + 1] = "┬"
      } else {
        chars.push("┬")
      }
    }

    const row = chars.join("")
    rows.push(row)
    maxLen = Math.max(maxLen, row.length, lanes.length + (commit.parentOids.length > 1 ? 1 : 0))

    // Update lanes: replace with parents, insert extras, remove empties
    if (commit.parentOids.length === 0) {
      lanes.splice(idx, 1)
    } else {
      lanes[idx] = commit.parentOids[0]!
      for (let k = 1; k < commit.parentOids.length; k++) {
        lanes.splice(idx + k, 0, commit.parentOids[k]!)
      }
      // Deduplicate convergence: keep first occurrence of each oid
      const seen = new Set<string>()
      let i = 0
      while (i < lanes.length) {
        const oid = lanes[i]!
        if (seen.has(oid)) {
          lanes.splice(i, 1)
        } else {
          seen.add(oid)
          i++
        }
      }
    }
    maxLen = Math.max(maxLen, lanes.length)
  }

  // Pad every segment to max width for this commit set
  const padded = rows.map((r) => r.padEnd(maxLen, " "))
  return padded
}
