import { Command, CommanderError } from "commander"
import manifest from "../../package.json" with { type: "json" }

export type CliParseResult =
  | { readonly kind: "start"; readonly startDirectory?: string }
  | { readonly kind: "update"; readonly version?: string; readonly check: boolean }
  // The agent's read-only way in.
  | { readonly kind: "handoff"; readonly json: boolean; readonly startDirectory?: string }
  | { readonly kind: "handoff-reply"; readonly id: string; readonly body: string; readonly startDirectory?: string }
  | { readonly kind: "help"; readonly text: string }
  | { readonly kind: "version"; readonly text: string }
  | { readonly kind: "error"; readonly message: string; readonly exitCode: number }

/** Package version embedded at bundle time, so `bun build --compile` binaries report the real version. */
const cliVersion = typeof manifest.version === "string" && manifest.version !== "" ? manifest.version : "0.0.0-dev"

export function parseCliArgs(argv: readonly string[]): CliParseResult {
  let stdout = ""
  let stderr = ""
  let update: { readonly version?: string; readonly check: boolean } | undefined
  let handoff: { readonly json: boolean } | undefined
  let handoffReply: { readonly id: string; readonly body: string } | undefined
  const program = new Command()
  program
    .name("githunk")
    .description("A review-first Git TUI combining lazygit's everyday Git workflow with focused hunk review.")
    .version(cliVersion, "-V, --version", "output the version number")
    .option("-p, --path <dir>", "path to the Git repository to open")
    .argument("[path]", "path to the Git repository to open")
    .exitOverride()
    // A program-level action keeps bare `githunk` (and `[path]`) working once
    // subcommands exist; without it commander rejects missing commands. The real
    // dispatch reads opts/args below, so this intentionally does nothing.
    .action(() => {})
    .configureOutput({
      writeOut: (text: string) => {
        stdout += text
      },
      writeErr: (text: string) => {
        stderr += text
      },
    })
  program
    .command("update")
    .description("update githunk to the newest (or a given) release")
    .argument("[version]", "version to install; the newest release when omitted")
    .option("--check", "report the installed and available versions without installing")
    .action((version: string | undefined, options: { check?: boolean }) => {
      update = {
        ...(version === undefined ? {} : { version }),
        check: options.check ?? false,
      }
    })

  const handoffCommand = program
    .command("handoff")
    .description("print the open review objections githunk last handed off")
    .option("--json", "print the raw mailbox JSON instead of markdown")
    .action((options: { json?: boolean }) => {
      handoff = { json: options.json ?? false }
    })
  handoffCommand
    .command("reply")
    .description("answer one objection; githunk shows it but the verdict stays its own")
    .requiredOption("--id <id>", "objection id from the mailbox")
    .requiredOption("--body <text>", "what to tell the reviewer")
    .action((options: { id: string; body: string }) => {
      handoffReply = { id: options.id, body: options.body }
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
  const startDirectory = options.path ?? (
    update === undefined && handoff === undefined && handoffReply === undefined ? positional : undefined
  )
  if (update !== undefined) return { kind: "update", ...update }
  if (handoffReply !== undefined) {
    if (handoffReply.id.trim() === "" || handoffReply.body.trim() === "") {
      return { kind: "error", message: "handoff reply requires a non-empty id and body", exitCode: 1 }
    }
    return {
      kind: "handoff-reply",
      ...handoffReply,
      ...(startDirectory === undefined ? {} : { startDirectory }),
    }
  }
  if (handoff !== undefined) {
    return {
      kind: "handoff",
      ...handoff,
      ...(startDirectory === undefined ? {} : { startDirectory }),
    }
  }
  return startDirectory === undefined ? { kind: "start" } : { kind: "start", startDirectory }
}
