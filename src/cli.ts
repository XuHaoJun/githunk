import { parseCliArgs } from "./cli/args"
import { startApp } from "./main"

const result = parseCliArgs(process.argv.slice(2))

if (result.kind === "help" || result.kind === "version") {
  process.stdout.write(result.text.endsWith("\n") ? result.text : `${result.text}\n`)
  process.exitCode = 0
} else if (result.kind === "error") {
  process.stderr.write(result.message.endsWith("\n") ? result.message : `${result.message}\n`)
  process.exitCode = result.exitCode
} else {
  process.exitCode = await startApp(
    result.startDirectory === undefined ? {} : { startDirectory: result.startDirectory },
  )
}
