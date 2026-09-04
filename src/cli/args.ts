import { Command, CommanderError } from "commander"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

export type CliParseResult =
  | { readonly kind: "start"; readonly startDirectory?: string }
  | { readonly kind: "help"; readonly text: string }
  | { readonly kind: "version"; readonly text: string }
  | { readonly kind: "error"; readonly message: string; readonly exitCode: number }

let cachedVersion: string | undefined

/** Reads the package version by walking up to the githunk package root. Works both from `src/cli/` in dev and from `dist/` in the bundled executable. */
export function getCliVersion(): string {
  if (cachedVersion !== undefined) return cachedVersion
  let directory = dirname(fileURLToPath(import.meta.url))
  for (let level = 0; level < 4; level += 1) {
    try {
      const manifest = JSON.parse(readFileSync(join(directory, "package.json"), "utf8")) as {
        name?: unknown
        version?: unknown
      }
      if (manifest.name === "@xuhaojun/githunk" && typeof manifest.version === "string") {
        cachedVersion = manifest.version
        return cachedVersion
      }
    } catch {
      // Not this directory — keep walking up.
    }
    const parent = dirname(directory)
    if (parent === directory) break
    directory = parent
  }
  cachedVersion = "0.0.0-dev"
  return cachedVersion
}

export function parseCliArgs(argv: readonly string[]): CliParseResult {
  let stdout = ""
  let stderr = ""
  const program = new Command()
  program
    .name("githunk")
    .description("A review-first Git TUI combining lazygit's everyday Git workflow with focused hunk review.")
    .version(getCliVersion(), "-V, --version", "output the version number")
    .option("-p, --path <dir>", "path to the Git repository to open")
    .argument("[path]", "path to the Git repository to open")
    .exitOverride()
    .configureOutput({
      writeOut: (text: string) => {
        stdout += text
      },
      writeErr: (text: string) => {
        stderr += text
      },
    })

  try {
    program.parse([...argv], { from: "user" })
  } catch (error) {
    if (error instanceof CommanderError) {
      if (error.code === "commander.helpDisplayed") return { kind: "help", text: stdout }
      if (error.code === "commander.version") return { kind: "version", text: stdout }
      const message = stderr.trim() === "" ? error.message : stderr.trim()
      return { kind: "error", message, exitCode: error.exitCode }
    }
    throw error
  }

  const options = program.opts<{ path?: string }>()
  const positional = program.args[0]
  const startDirectory = options.path ?? positional
  return startDirectory === undefined ? { kind: "start" } : { kind: "start", startDirectory }
}
