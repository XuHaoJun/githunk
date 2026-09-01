#!/usr/bin/env node

import { spawn } from "node:child_process"
import { constants } from "node:os"
import { fileURLToPath } from "node:url"

const cliPath = fileURLToPath(new URL("../dist/githunk.js", import.meta.url))
const child = spawn(process.execPath, ["--experimental-ffi", cliPath, ...process.argv.slice(2)], {
  stdio: "inherit",
})

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
