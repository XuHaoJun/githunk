import { Command, CommanderError } from "commander"
import manifest from "../../package.json" with { type: "json" }

export type CliParseResult =
  | { readonly kind: "start"; readonly startDirectory?: string }
  | { readonly kind: "help"; readonly text: string }
  | { readonly kind: "version"; readonly text: string }
  | { readonly kind: "error"; readonly message: string; readonly exitCode: number }

/** Package version embedded at bundle time, so `bun build --compile` binaries report the real version. */
const cliVersion = typeof manifest.version === "string" && manifest.version !== "" ? manifest.version : "0.0.0-dev"

export function parseCliArgs(argv: readonly string[]): CliParseResult {
  let stdout = ""
  let stderr = ""
  const program = new Command()
  program
    .name("githunk")
    .description("A review-first Git TUI combining lazygit's everyday Git workflow with focused hunk review.")
    .version(cliVersion, "-V, --version", "output the version number")
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
