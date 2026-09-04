#!/usr/bin/env bun

import { readFileSync } from "node:fs"
import path from "node:path"

/** Fail unless the release tag names the current package version. */
function checkReleaseVersion(tag: string): void {
  const repoRoot = path.resolve(import.meta.dir, "..")
  const manifest = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8")) as { version?: unknown }
  const expected = `v${manifest.version}`
  if (tag !== expected) {
    throw new Error(`Release tag ${tag} does not match package version ${expected}`)
  }
}

if (import.meta.main) {
  const tag = process.argv[2]
  if (tag === undefined || tag === "") {
    throw new Error("Usage: check-release-version.ts <tag>")
  }
  checkReleaseVersion(tag)
  console.log(`Release tag ${tag} matches package.json`)
}
