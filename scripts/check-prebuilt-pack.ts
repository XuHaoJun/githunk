#!/usr/bin/env bun

import { existsSync } from "node:fs"
import path from "node:path"
import { listStagedPackageDirs, releaseNpmDir } from "./prebuilt-package-helpers"

/** Verify every staged package packs cleanly and carries its payload. */
function checkDirectory(directory: string): void {
  if (!existsSync(path.join(directory, "package.json"))) {
    throw new Error(`Missing package.json in ${directory}`)
  }
  const proc = Bun.spawnSync(["npm", "pack", "--dry-run"], {
    cwd: directory,
    stdout: "pipe",
    stderr: "pipe",
  })
  if (proc.exitCode !== 0) {
    throw new Error(`npm pack --dry-run failed in ${directory}:\n${proc.stderr.toString()}`)
  }
}

const repoRoot = path.resolve(import.meta.dir, "..")
const releaseRoot = releaseNpmDir(repoRoot)

if (!existsSync(releaseRoot)) {
  throw new Error(`Missing staged npm release directory at ${releaseRoot}. Run \`bun run stage:prebuilt:release\` first.`)
}

const directories = listStagedPackageDirs(releaseRoot)
if (directories.length === 0) {
  throw new Error(`No staged packages found in ${releaseRoot}`)
}

for (const directory of directories) {
  checkDirectory(directory)
  console.log(`OK ${directory}`)
}
