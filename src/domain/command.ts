export type CommandRecord = {
  readonly id: number
  readonly cwd: string
  readonly args: readonly string[]
  readonly startedAt: string
  readonly durationMs: number
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
}
