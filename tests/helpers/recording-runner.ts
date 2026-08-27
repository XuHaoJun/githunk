import type { GitRunner } from "../../src/git/runner"

export type RecordingRunner = Pick<GitRunner, "run"> & {
  /** Every `run()` call's argv, in call order — `.length` counts spawned processes. */
  readonly calls: readonly (readonly string[])[]
}

/**
 * Wraps a runner (or anything shaped like `Pick<GitRunner, "run">`, which is what loaders accept)
 * to record each `run()` call's argv while delegating to the real implementation.
 *
 * `readOnly` implies `dontLog` (runner.ts's `shouldLog` rule), so a read-only loader's calls no
 * longer show up in `CommandLog` — the log stopped being a faithful proxy for "a command ran."
 * Tests that used it as an instrumentation channel (counting spawned processes, or reading back an
 * exact argv) spy on `run()` directly instead.
 */
export function recordingRunner(runner: Pick<GitRunner, "run">): RecordingRunner {
  const calls: (readonly string[])[] = []
  return {
    calls,
    run: (args, options) => {
      calls.push([...args])
      return runner.run(args, options)
    },
  }
}
