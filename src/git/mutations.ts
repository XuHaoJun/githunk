import type { DiffDocument } from "../domain/diff/document"
import { buildPartialPatch, type PartialPatchOptions } from "../domain/diff/transform"
import type { DiscardFileMode } from "../domain/review-target"
import { MutationQueue } from "../app/mutation-queue"
import { GitRunner } from "./runner"
export type MutationRefresh = () => Promise<void>

export type SelectionMutationOptions = PartialPatchOptions & {
  readonly refresh?: MutationRefresh
}

export class MutationSelectionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "MutationSelectionError"
  }
}

export type GitMutationsOptions = {
  readonly refresh?: MutationRefresh
}

export class GitMutations {
  readonly runner: GitRunner
  private readonly refresh: MutationRefresh
  private readonly queue = new MutationQueue()

  constructor(runner: GitRunner, options?: GitMutationsOptions | MutationRefresh) {
    this.runner = runner
    this.refresh = typeof options === "function" ? options : options?.refresh ?? (async () => undefined)
  }

  async stageFile(path: string): Promise<void> {
    return this.queue.run(async () => {
      await this.runner.run(["add", "--", path])
      await this.refresh()
    })
  }

  async unstageFile(path: string): Promise<void> {
    return this.queue.run(async () => {
      await this.runner.run(["restore", "--staged", "--", path])
      await this.refresh()
    })
  }

  async discardFile(path: string, mode: DiscardFileMode = "unstaged"): Promise<void> {
    return this.queue.run(async () => {
      if (mode === "all") {
        await this.runner.run(["restore", "--staged", "--", path], { acceptedExitCodes: [0, 1] })
      }
      await this.runner.run(["restore", "--", path], { acceptedExitCodes: [0, 1] })
      await this.runner.run(["clean", "-f", "-d", "--", path])
      await this.refresh()
    })
  }

  async applySelection(
    document: DiffDocument,
    includedLineIndexes: readonly number[],
    options: SelectionMutationOptions = { reverse: false, wholeFile: false },
  ): Promise<void> {
    return this.queue.run(async () => {
      const patch = buildPartialPatch(document, includedLineIndexes, options)
      if (patch.length === 0) return
      if (!options.wholeFile && document.files.length > 0 && document.files.every((file) => file.hunks.length === 0)) {
        throw new MutationSelectionError("Binary or conflicted files do not support line selection")
      }
      const args = options.reverse ? ["apply", "--cached", "--reverse", "-"] : ["apply", "--cached", "-"]
      await this.runner.run(args, { stdin: patch })
      await this.refresh()
    })
  }

  async discardSelection(
    document: DiffDocument,
    includedLineIndexes: readonly number[],
    options: Omit<SelectionMutationOptions, "reverse"> & { readonly reverse?: false } = { wholeFile: false },
  ): Promise<void> {
    return this.queue.run(async () => {
      const patch = buildPartialPatch(document, includedLineIndexes, { ...options, reverse: false })
      if (patch.length === 0) return
      if (!options.wholeFile && document.files.length > 0 && document.files.every((file) => file.hunks.length === 0)) {
        throw new MutationSelectionError("Binary or conflicted files do not support line selection")
      }
      await this.runner.run(["apply", "--reverse", "-"], { stdin: patch })
      await this.refresh()
    })
  }
}
