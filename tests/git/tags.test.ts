import { afterEach, describe, expect, test } from "bun:test"
import { GitRunner } from "../../src/git/runner"
import { listTags, loadTagPreview } from "../../src/git/tags"
import { createTempRepository, type TempRepository } from "../helpers/temp-repository"

describe("tag loaders", () => {
  let repository: TempRepository | undefined
  afterEach(async () => repository?.cleanup())

  test("distinguishes lightweight and annotated tags and loads annotated metadata", async () => {
    repository = await createTempRepository()
    await repository.write("a.txt", "a\n")
    await repository.git(["add", "."])
    await repository.git(["commit", "-m", "tag target"])
    await repository.git(["tag", "light"])
    await repository.git(["tag", "-a", "annotated", "-m", "release message"])
    const runner = new GitRunner(repository.path)
    const tags = await listTags(runner)
    expect(tags.map((tag) => [tag.name, tag.kind])).toEqual([
      ["annotated", "annotated"],
      ["light", "lightweight"],
    ])
    const preview = await loadTagPreview(runner, tags[0]!)
    expect(preview.message).toContain("release message")
    expect(preview.targetCommit.subject).toBe("tag target")
  })
})
