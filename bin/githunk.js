#!/usr/bin/env node

// githunk launcher: prefer the prebuilt standalone binary installed as an
// optional platform package, and fall back to the Node bundle otherwise.
//
// npm installs only the optional dependency whose `os`/`cpu` matches this
// machine, so the binary usually lives at
// `<install-root>/node_modules/@xuhaojun/githunk-<os>-<arch>/bin/githunk`.
// The lookup walks up from this file (the hunk `findInstalledBinary` shape in
// `learn-projects/hunk/bin/hunk.cjs`), which keeps working no matter which
// Node version owns the invoking shell: the prebuilt binary embeds its own
// Bun runtime and takes no `--experimental-ffi` flag. `$GITHUNK_BIN_PATH`
// overrides everything for debugging and custom installs.

import { spawn } from "node:child_process"
import { existsSync, realpathSync } from "node:fs"
import { constants } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const PLATFORM_PACKAGES = [
  { packageName: "@xuhaojun/githunk-darwin-arm64", binary: "bin/githunk" },
  { packageName: "@xuhaojun/githunk-darwin-x64", binary: "bin/githunk" },
  { packageName: "@xuhaojun/githunk-linux-arm64", binary: "bin/githunk" },
  { packageName: "@xuhaojun/githunk-linux-x64", binary: "bin/githunk" },
  { packageName: "@xuhaojun/githunk-windows-x64", binary: "bin/githunk.exe" },
]

function hostCandidates() {
  const platformMap = {
    darwin: "darwin",
    linux: "linux",
    win32: "windows",
  }
  const archMap = {
    x64: "x64",
    arm64: "arm64",
  }
  const platform = platformMap[process.platform]
  const arch = archMap[process.arch]
  if (platform === undefined || arch === undefined) return []
  return PLATFORM_PACKAGES.filter((candidate) => candidate.packageName === `@xuhaojun/githunk-${platform}-${arch}`)
}

/** Find the prebuilt binary installed next to this package, walking up past nested installs. */
function findInstalledBinary(startDir) {
  let current = startDir
  for (;;) {
    const modulesDir = join(current, "node_modules")
    for (const candidate of hostCandidates()) {
      const resolved = join(modulesDir, ...candidate.packageName.split("/"), candidate.binary)
      if (existsSync(resolved)) return resolved
    }
    const parent = dirname(current)
    if (parent === current) return null
    current = parent
  }
}

function launch(target, args) {
  const child = spawn(target, args, { stdio: "inherit" })

  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT"]) {
    process.once(signal, () => { child.kill(signal) })
  }

  child.once("error", (error) => {
    process.stderr.write(`githunk: failed to start: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
  child.once("close", (exitCode, signal) => {
    const signalNumber = signal === null ? undefined : constants.signals[signal]
    process.exitCode = exitCode ?? (signalNumber === undefined ? 1 : 128 + signalNumber)
  })
}

const forwardedArgs = process.argv.slice(2)
const overrideBinary = process.env.GITHUNK_BIN_PATH
if (typeof overrideBinary === "string" && overrideBinary !== "") {
  launch(overrideBinary, forwardedArgs)
} else {
  let scriptDir = dirname(fileURLToPath(import.meta.url))
  try {
    scriptDir = realpathSync(scriptDir)
  } catch {
    // Unresolved symlinks just start the walk from the literal directory.
  }
  const prebuiltBinary = findInstalledBinary(scriptDir)
  if (prebuiltBinary !== null) {
    launch(prebuiltBinary, forwardedArgs)
  } else {
    const cliPath = fileURLToPath(new URL("../dist/githunk.js", import.meta.url))
    launch(process.execPath, ["--experimental-ffi", cliPath, ...forwardedArgs])
  }
}
