import type { TagPreview, TagSummary } from "../domain/tag"
import { GitRunner } from "./runner"
import { listCommits } from "./commits"
import { parseNulFields } from "./parse"

type CommandRunner = Pick<GitRunner, "run">

export async function listTags(runner: CommandRunner): Promise<readonly TagSummary[]> {
  const result = await runner.run(
    [
      "for-each-ref",
      "--sort=refname",
      "--format=%(refname:short)%00%(refname)%00%(objecttype)%00%(objectname)%00%(*objectname)%00%(subject)%00%(taggername)%00%(taggerdate:iso-strict)%00%(contents)%00",
      "refs/tags",
    ],
    { readOnly: true },
  )
  const records = parseNulFields(result.stdout, 9)
  return records.map((fields) => {
    const name = fields[0] ?? ""
    const ref = fields[1] ?? ""
    const objecttype = fields[2] ?? ""
    const objectOid = fields[3] ?? ""
    const starObjectName = fields[4] ?? ""
    const subject = fields[5] ?? ""
    const taggerName = fields[6] ?? ""
    const taggedAt = fields[7] ?? ""
    const contents = fields[8] ?? ""
    const kind: TagSummary["kind"] = objecttype === "tag" ? "annotated" : "lightweight"
    const targetOid = kind === "annotated" && starObjectName.length > 0 ? starObjectName : objectOid
    const summary: TagSummary = {
      name,
      ref,
      kind,
      objectOid,
      targetOid,
      subject,
      ...(taggerName.length === 0 ? {} : { taggerName }),
      ...(taggedAt.length === 0 ? {} : { taggedAt }),
      ...(contents.length === 0 ? {} : { message: contents }),
    }
    return summary
  })
}

export async function loadTagPreview(runner: CommandRunner, tag: TagSummary): Promise<TagPreview> {
  const commits = await listCommits(runner, `${tag.targetOid}^!`)
  if (commits.length !== 1) throw new Error(`tag target not found: ${tag.targetOid}`)
  return {
    ...tag,
    targetCommit: commits[0]!,
  }
}
