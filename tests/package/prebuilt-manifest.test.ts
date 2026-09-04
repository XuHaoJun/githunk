import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  binaryFilenameForSpec,
  buildOptionalDependencyMap,
  buildPlatformPackageManifest,
  getHostPlatformPackageSpec,
  getPlatformPackageSpecByName,
  getPlatformPackageSpecForHost,
  listStagedPackageDirs,
  PLATFORM_PACKAGE_MATRIX,
} from "../../scripts/prebuilt-package-helpers"

describe("prebuilt platform matrix", () => {
  test("covers exactly the five shipped platform packages", () => {
    expect(PLATFORM_PACKAGE_MATRIX.map((spec) => spec.packageName)).toEqual([
      "@xuhaojun/githunk-darwin-arm64",
      "@xuhaojun/githunk-darwin-x64",
      "@xuhaojun/githunk-linux-arm64",
      "@xuhaojun/githunk-linux-x64",
      "@xuhaojun/githunk-windows-x64",
    ])
  })

  test("resolves the host spec from the current platform", () => {
    expect(getHostPlatformPackageSpec()).toEqual(
      getPlatformPackageSpecForHost(process.platform, process.arch),
    )
  })

  test("returns undefined for unknown package names", () => {
    expect(getPlatformPackageSpecByName("@xuhaojun/githunk-plan9-mips")).toBeUndefined()
  })

  test("maps windows to the win32 os token in the published manifest", () => {
    const root = { version: "0.2.0", description: "githunk", license: "MIT" }
    const windows = getPlatformPackageSpecByName("@xuhaojun/githunk-windows-x64")
    if (windows === undefined) throw new Error("matrix incomplete")
    const manifest = buildPlatformPackageManifest(root, windows)
    expect(manifest).toMatchObject({
      name: "@xuhaojun/githunk-windows-x64",
      version: "0.2.0",
      os: ["win32"],
      cpu: ["x64"],
    })
  })

  test("pins every platform package to the release version", () => {
    expect(buildOptionalDependencyMap("0.2.0")).toEqual({
      "@xuhaojun/githunk-darwin-arm64": "0.2.0",
      "@xuhaojun/githunk-darwin-x64": "0.2.0",
      "@xuhaojun/githunk-linux-arm64": "0.2.0",
      "@xuhaojun/githunk-linux-x64": "0.2.0",
      "@xuhaojun/githunk-windows-x64": "0.2.0",
    })
  })

  test("uses the exe suffix only on windows", () => {
    const linux = getPlatformPackageSpecByName("@xuhaojun/githunk-linux-x64")
    const windows = getPlatformPackageSpecByName("@xuhaojun/githunk-windows-x64")
    if (linux === undefined || windows === undefined) throw new Error("matrix incomplete")
    expect(binaryFilenameForSpec(linux)).toBe("githunk")
    expect(binaryFilenameForSpec(windows)).toBe("githunk.exe")
  })

  test("lists staged packages through scope directories", async () => {
    const root = await mkdtemp(join(tmpdir(), "githunk-stage-"))
    try {
      await mkdir(join(root, "@xuhaojun", "githunk-linux-x64"), { recursive: true })
      await mkdir(join(root, "@xuhaojun", "githunk"), { recursive: true })
      expect(listStagedPackageDirs(root).sort()).toEqual([
        join(root, "@xuhaojun", "githunk"),
        join(root, "@xuhaojun", "githunk-linux-x64"),
      ])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
