#!/usr/bin/env bun

import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import { listStagedPackageDirs, releaseNpmDir } from "./prebuilt-package-helpers"

type PackageJson = {
  readonly name: string
  readonly version: string
}

function parseArgs(argv: readonly string[]): { dryRun: boolean; npmTag: string } {
  let dryRun = false
  let npmTag = "latest"

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === "--dry-run") {
      dryRun = true
    } else if (arg === "--tag") {
      const value = argv[index + 1]
      if (value === undefined || value === "") throw new Error("Missing value for --tag")
      npmTag = value
      index += 1
    } else {
      throw new Error(`Unknown argument: ${arg}`)
    }
  }

  return { dryRun, npmTag }
}

function npmViewExists(name: string, version: string): boolean {
  const proc = Bun.spawnSync(["npm", "view", `${name}@${version}`, "version"], {
    stdout: "ignore",
    stderr: "ignore",
  })
  return proc.exitCode === 0
}

function publishDirectory(directory: string, dryRun: boolean, npmTag: string): void {
  const packageJson = JSON.parse(readFileSync(path.join(directory, "package.json"), "utf8")) as PackageJson

  if (npmViewExists(packageJson.name, packageJson.version)) {
    console.log(
      dryRun
        ? `Skipping npm publish dry-run for ${packageJson.name}@${packageJson.version}; that version already exists on npm.`
        : `Skipping ${packageJson.name}@${packageJson.version}; already published.`,
    )
    return
  }

  const args = ["publish", "--access", "public", "--tag", npmTag]
  if (dryRun) {
    args.push("--dry-run")
  }

  const proc = Bun.spawnSync(["npm", ...args], {
    cwd: directory,
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
    env: process.env,
  })

  if (proc.exitCode !== 0) {
    throw new Error(`npm publish failed for ${packageJson.name}@${packageJson.version}`)
  }
}

const repoRoot = path.resolve(import.meta.dir, "..")
const releaseRoot = releaseNpmDir(repoRoot)
const options = parseArgs(process.argv.slice(2))

if (!existsSync(releaseRoot)) {
  throw new Error(`Missing staged npm release directory at ${releaseRoot}`)
}

const rootPackage = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8")) as PackageJson
const directories = listStagedPackageDirs(releaseRoot).sort((left, right) => {
  const leftBase = path.basename(left)
  const rightBase = path.basename(right)
  if (leftBase === rootPackage.name) return 1
  if (rightBase === rootPackage.name) return -1
  return left.localeCompare(right)
})

if (directories.length === 0) {
  throw new Error(`No staged packages found in ${releaseRoot}`)
}

for (const directory of directories) {
  publishDirectory(directory, options.dryRun, options.npmTag)
}

console.log(
  options.dryRun
    ? `Completed npm publish dry-run for staged prebuilt packages with dist-tag "${options.npmTag}".`
    : `Published staged prebuilt packages to npm with dist-tag "${options.npmTag}".`,
)
