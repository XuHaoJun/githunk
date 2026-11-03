import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { stagePrebuiltArtifact } from "../../scripts/build-prebuilt-artifact"
import { binaryFilenameForSpec, getHostPlatformPackageSpec } from "../../scripts/prebuilt-package-helpers"

describe("stagePrebuiltArtifact", () => {
  const temporaryDirectories: string[] = []

  afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
  })

  test("places only the public handoff skill beside the standalone binary", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "githunk-artifact-source-"))
    const outputRoot = await mkdtemp(join(tmpdir(), "githunk-artifact-output-"))
    temporaryDirectories.push(repoRoot, outputRoot)
    const spec = getHostPlatformPackageSpec()
    await mkdir(join(repoRoot, "dist"), { recursive: true })
    await mkdir(join(repoRoot, "skills", "githunk-handoff"), { recursive: true })
    await mkdir(join(repoRoot, "skills", "githunk-release"), { recursive: true })
    await mkdir(join(repoRoot, "third-party", "opentui"), { recursive: true })
    await writeFile(join(repoRoot, "dist", binaryFilenameForSpec(spec)), "binary")
    await writeFile(join(repoRoot, "skills", "githunk-handoff", "SKILL.md"), "agent skill\n")
    await writeFile(join(repoRoot, "skills", "githunk-release", "SKILL.md"), "maintainer skill\n")
    await writeFile(join(repoRoot, "third-party", "opentui", "LICENSE"), "mit\n")
    await writeFile(join(repoRoot, "third-party", "opentui", "LICENSE-FFMPEG"), "lgpl\n")
    await writeFile(join(repoRoot, "third-party", "opentui", "FFMPEG-SOURCE.md"), "source offer\n")

    const output = stagePrebuiltArtifact({ repoRoot, outputRoot, expectedPackage: spec.packageName })

    expect(await Bun.file(join(output, "skills", "githunk-handoff", "SKILL.md")).text()).toBe("agent skill\n")
    expect(await Bun.file(join(output, "skills", "githunk-release", "SKILL.md")).exists()).toBe(false)
    expect(await Bun.file(join(output, "third-party", "opentui", "LICENSE-FFMPEG")).text()).toBe("lgpl\n")
    expect(await Bun.file(join(output, "third-party", "opentui", "FFMPEG-SOURCE.md")).text()).toBe("source offer\n")
  })

  test("refuses to stage an artifact without the FFmpeg notices", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "githunk-artifact-missing-notices-"))
    const outputRoot = await mkdtemp(join(tmpdir(), "githunk-artifact-output-"))
    temporaryDirectories.push(repoRoot, outputRoot)
    const spec = getHostPlatformPackageSpec()
    await mkdir(join(repoRoot, "dist"), { recursive: true })
    await mkdir(join(repoRoot, "skills", "githunk-handoff"), { recursive: true })
    await writeFile(join(repoRoot, "dist", binaryFilenameForSpec(spec)), "binary")
    await writeFile(join(repoRoot, "skills", "githunk-handoff", "SKILL.md"), "agent skill\n")

    expect(() => stagePrebuiltArtifact({ repoRoot, outputRoot, expectedPackage: spec.packageName })).toThrow(/third-party notice/i)
  })
})
