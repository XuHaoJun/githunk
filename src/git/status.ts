import type { ChangedFile } from "../domain/review-target"

export type RepositoryStatus = {
  readonly branch: string
  readonly upstream?: string
  readonly files: readonly ChangedFile[]
}

function statusPair(value: string): { indexStatus: string; worktreeStatus: string } {
  return {
    indexStatus: value[0] ?? ".",
    worktreeStatus: value[1] ?? ".",
  }
}

function parseEntry(record: string, records: readonly string[], index: number): { file?: ChangedFile; consumed: number } {
  if (record.startsWith("? ")) {
    return {
      file: {
        path: record.slice(2),
        indexStatus: ".",
        worktreeStatus: "?",
        untracked: true,
        conflicted: false,
        additions: 0,
        deletions: 0,
      },
      consumed: 0,
    }
  }

  if (record.startsWith("1 ")) {
    const fields = record.split(" ")
    if (fields.length < 9) return { consumed: 0 }
    const statuses = statusPair(fields[1] ?? "..")
    return {
      file: {
        path: fields.slice(8).join(" "),
        ...statuses,
        untracked: false,
        conflicted: statuses.indexStatus === "U" || statuses.worktreeStatus === "U",
        additions: 0,
        deletions: 0,
      },
      consumed: 0,
    }
  }

  if (record.startsWith("2 ")) {
    const fields = record.split(" ")
    if (fields.length < 10) return { consumed: 0 }
    const statuses = statusPair(fields[1] ?? "..")
    const base: ChangedFile = {
      path: fields.slice(9).join(" "),
      ...statuses,
      untracked: false,
      conflicted: statuses.indexStatus === "U" || statuses.worktreeStatus === "U",
      additions: 0,
      deletions: 0,
    }
    const previousPath = records[index + 1]
    const file: ChangedFile = previousPath === undefined ? base : { ...base, previousPath }
    return { file, consumed: previousPath === undefined ? 0 : 1 }
  }

  if (record.startsWith("u ")) {
    const fields = record.split(" ")
    if (fields.length < 11) return { consumed: 0 }
    const statuses = statusPair(fields[1] ?? "UU")
    return {
      file: {
        path: fields.slice(10).join(" "),
        ...statuses,
        untracked: false,
        conflicted: true,
        additions: 0,
        deletions: 0,
      },
      consumed: 0,
    }
  }

  return { consumed: 0 }
}

/** Parse `git status --porcelain=v2 --branch -z` without normalizing paths. */
export function parsePorcelainV2(raw: string): RepositoryStatus {
  let branch = "HEAD"
  let upstream: string | undefined
  const files: ChangedFile[] = []
  const records = raw.split("\0")

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index] ?? ""
    if (record.length === 0) continue
    if (record.startsWith("# branch.head ")) {
      branch = record.slice("# branch.head ".length).replace(/\n$/, "")
      continue
    }
    if (record.startsWith("# branch.upstream ")) {
      upstream = record.slice("# branch.upstream ".length).replace(/\n$/, "")
      continue
    }
    if (record.startsWith("# ")) continue

    const parsed = parseEntry(record, records, index)
    if (parsed.file !== undefined) files.push(parsed.file)
    index += parsed.consumed
  }

  return upstream === undefined ? { branch, files } : { branch, upstream, files }
}
