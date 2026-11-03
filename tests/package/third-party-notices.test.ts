import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { copyThirdPartyNotices, REQUIRED_THIRD_PARTY_NOTICES, THIRD_PARTY_NOTICES_RELATIVE_PATH } from "../../scripts/prebuilt-package-helpers"

describe("copyThirdPartyNotices", () => {
  const temporaryDirectories: string[] = []

  afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
  })

  async function fixture(): Promise<{ source: string; destination: string }> {
    const source = await mkdtemp(join(tmpdir(), "githunk-notices-source-"))
    const destination = await mkdtemp(join(tmpdir(), "githunk-notices-destination-"))
    temporaryDirectories.push(source, destination)
    await mkdir(join(source, THIRD_PARTY_NOTICES_RELATIVE_PATH), { recursive: true })
    await mkdir(join(source, "third-party", "other"), { recursive: true })
    for (const filename of REQUIRED_THIRD_PARTY_NOTICES) {
      await writeFile(join(source, THIRD_PARTY_NOTICES_RELATIVE_PATH, filename), `${filename}\n`)
    }
    await writeFile(join(source, "third-party", "other", "NOTICE"), "unrelated\n")
    return { source, destination }
  }

  test("copies the OpenTUI notices into a release payload", async () => {
    const { source, destination } = await fixture()

    copyThirdPartyNotices(source, destination)

    for (const filename of REQUIRED_THIRD_PARTY_NOTICES) {
      expect(await Bun.file(join(destination, THIRD_PARTY_NOTICES_RELATIVE_PATH, filename)).text()).toBe(`${filename}\n`)
    }
    expect(await Bun.file(join(destination, "third-party", "other", "NOTICE")).exists()).toBe(false)
  })

  test("rejects a payload source without the FFmpeg notices", async () => {
    const { source, destination } = await fixture()
    await rm(join(source, THIRD_PARTY_NOTICES_RELATIVE_PATH, "FFMPEG-SOURCE.md"))

    expect(() => copyThirdPartyNotices(source, destination)).toThrow(/FFMPEG-SOURCE\.md/)
  })
})
