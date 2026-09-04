#!/usr/bin/env bun

import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  binaryFilenameForSpec,
  getHostPlatformPackageSpec,
  releaseNpmDir,
} from "./prebuilt-package-helpers"

function run(command: string[], cwd?: string): { stdout: string; stderr: string } {
  const proc = Bun.spawnSync(command, {
    ...(cwd === undefined ? {} : { cwd }),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  const stdout = Buffer.from(proc.stdout).toString("utf8")
  const stderr = Buffer.from(proc.stderr).toString("utf8")
  if (proc.exitCode !== 0) {
    throw new Error(`Command failed: ${command.join(" ")}\n${stdout}\n${stderr}`)
  }
  return { stdout, stderr }
}

function singleTarball(directory: string): string {
  const tarballs = readdirSync(directory).filter((entry) => entry.endsWith(".tgz"))
  if (tarballs.length !== 1 || tarballs[0] === undefined) {
    throw new Error(`Expected exactly one tarball in ${directory}, found ${tarballs.length}`)
  }
  return path.join(directory, tarballs[0])
}

const repoRoot = path.resolve(import.meta.dir, "..")
const packageVersion = (JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8")) as { version: string })
  .version
const releaseRoot = releaseNpmDir(repoRoot)
const hostSpec = getHostPlatformPackageSpec()
const tempRoot = mkdtempSync(path.join(tmpdir(), "githunk-prebuilt-smoke-"))

try {
  // Artifact transfer normalizes file modes before the publish job. Reproduce
  // that boundary so this test proves npm restores execution from the platform
  // package's `bin` declaration rather than relying on the staged mode.
  const smokePlatformDir = path.join(tempRoot, "platform", hostSpec.packageName)
  cpSync(path.join(releaseRoot, hostSpec.packageName), smokePlatformDir, { recursive: true })
  if (process.platform !== "win32") {
    chmodSync(path.join(smokePlatformDir, "bin", binaryFilenameForSpec(hostSpec)), 0o644)
  }

  const packageDir = path.join(tempRoot, "tarballs")
  mkdirSync(packageDir, { recursive: true })
  const platformPackDir = path.join(tempRoot, "tarballs", "platform")
  mkdirSync(platformPackDir, { recursive: true })
  run(["npm", "pack", "--pack-destination", platformPackDir], smokePlatformDir)
  const platformTarball = singleTarball(platformPackDir)

  const smokeMetaDir = path.join(tempRoot, "meta", "@xuhaojun", "githunk")
  cpSync(path.join(releaseRoot, "@xuhaojun", "githunk"), smokeMetaDir, { recursive: true })
  const smokeManifestPath = path.join(smokeMetaDir, "package.json")
  const smokeManifest = JSON.parse(readFileSync(smokeManifestPath, "utf8")) as {
    optionalDependencies?: Record<string, string>
  }
  smokeManifest.optionalDependencies = {
    ...smokeManifest.optionalDependencies,
    [hostSpec.packageName]: `file:${platformTarball}`,
  }
  writeFileSync(smokeManifestPath, `${JSON.stringify(smokeManifest, null, 2)}\n`)
  const metaPackDir = path.join(tempRoot, "tarballs", "meta")
  mkdirSync(metaPackDir, { recursive: true })
  run(["npm", "pack", "--pack-destination", metaPackDir], smokeMetaDir)
  const metaTarball = singleTarball(metaPackDir)

  const installDir = path.join(tempRoot, "install")
  mkdirSync(installDir, { recursive: true })
  run(["npm", "install", "--global", "--prefix", installDir, metaTarball])

  const installedBinDir = process.platform === "win32" ? installDir : path.join(installDir, "bin")
  const installedPackageRoot =
    process.platform === "win32"
      ? path.join(installDir, "node_modules", "@xuhaojun", "githunk")
      : path.join(installDir, "lib", "node_modules", "@xuhaojun", "githunk")
  const installedLauncher = path.join(installedBinDir, process.platform === "win32" ? "githunk.cmd" : "githunk")
  const installedPlatformBinary = path.join(
    installedPackageRoot,
    "node_modules",
    ...hostSpec.packageName.split("/"),
    "bin",
    binaryFilenameForSpec(hostSpec),
  )

  if (process.platform !== "win32") {
    const installedBinaryMode = statSync(installedPlatformBinary).mode & 0o777
    if ((installedBinaryMode & 0o111) === 0) {
      throw new Error(
        `Expected installed platform binary to keep execute bits, got mode ${installedBinaryMode.toString(8)} at ${installedPlatformBinary}`,
      )
    }
  }

  const version = run([installedLauncher, "--version"])
  if (version.stdout !== `${packageVersion}\n`) {
    throw new Error(`Expected installed githunk --version to print ${packageVersion}.\n${version.stdout}`)
  }
  if (version.stderr !== "") {
    throw new Error(
      `Expected the prebuilt binary to stay silent on stderr (the Node fallback always warns about experimental FFI).\n${version.stderr}`,
    )
  }

  const help = run([installedLauncher, "--help"])
  if (!help.stdout.includes("Usage:")) {
    throw new Error(`Expected help output to include 'Usage:'.\n${help.stdout}`)
  }

  console.log(`Verified prebuilt npm install smoke test with ${hostSpec.packageName}`)
} finally {
  rmSync(tempRoot, { recursive: true, force: true })
}
