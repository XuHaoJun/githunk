import { spawn, type ChildProcess } from "node:child_process"

export type ProcessOptions = {
  readonly cwd: string
  readonly env?: NodeJS.ProcessEnv
  readonly stdin?: string
  readonly signal?: AbortSignal
}

export type ProcessResult = {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
}

export function runProcess(command: string, args: readonly string[], options: ProcessOptions): Promise<ProcessResult> {
  return new Promise((resolve) => {
    let child: ChildProcess
    try {
      child = spawn(command, [...args], {
        cwd: options.cwd,
        stdio: ["pipe", "pipe", "pipe"],
        ...(options.env === undefined ? {} : { env: options.env }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      })
    } catch (error) {
      resolve({
        exitCode: -1,
        stdout: "",
        stderr: error instanceof Error ? error.message : String(error),
      })
      return
    }

    const stdin = child.stdin
    const stdoutStream = child.stdout
    const stderrStream = child.stderr
    if (stdin === null || stdoutStream === null || stderrStream === null) {
      try { child.kill() } catch {}
      resolve({ exitCode: -1, stdout: "", stderr: "child process did not expose piped standard streams" })
      return
    }

    let stdout = ""
    let stderr = ""
    let settled = false
    const finish = (exitCode: number, error?: unknown): void => {
      if (settled) return
      settled = true
      resolve({
        exitCode,
        stdout,
        stderr: error === undefined ? stderr : error instanceof Error ? error.message : String(error),
      })
    }

    stdoutStream.setEncoding("utf8")
    stderrStream.setEncoding("utf8")
    stdoutStream.on("data", (chunk: string) => { stdout += chunk })
    stderrStream.on("data", (chunk: string) => { stderr += chunk })
    child.once("error", (error) => finish(-1, error))
    child.once("close", (exitCode) => finish(exitCode ?? -1))
    stdin.once("error", () => {})
    if (options.stdin !== undefined) stdin.write(options.stdin)
    stdin.end()
  })
}

export type InteractiveProcessOptions = {
  readonly cwd: string
  readonly env?: NodeJS.ProcessEnv
}

export function runInteractiveProcess(
  command: string,
  args: readonly string[],
  options: InteractiveProcessOptions,
): Promise<number> {
  return new Promise((resolve, reject) => {
    let child: ChildProcess
    try {
      child = spawn(command, [...args], {
        cwd: options.cwd,
        stdio: "inherit",
        ...(options.env === undefined ? {} : { env: options.env }),
      })
    } catch (error) {
      reject(error)
      return
    }
    child.once("error", reject)
    child.once("close", (exitCode) => resolve(exitCode ?? -1))
  })
}
