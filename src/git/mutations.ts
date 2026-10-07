import { stat } from "node:fs/promises"
import { join } from "node:path"
import type { DiffDocument } from "../domain/diff/document"
import { buildPartialPatch, type PartialPatchOptions } from "../domain/diff/transform"
import { submoduleFullPath, type SubmoduleConfig } from "../domain/submodule"
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
    this.refresh = typeof options === "function" ? options : (options?.refresh ?? (async () => undefined))
  }
  private runBatch(paths: readonly string[], mutate: (path: string) => Promise<void>): Promise<void> {
    if (paths.length === 0) return Promise.resolve()
    return this.queue.run(async () => {
      try {
        for (const path of paths) {
          await mutate(path)
        }
      } catch (error) {
        try {
          await this.refresh()
        } catch {
          // Preserve the original mutation error.
        }
        throw error
      }
      await this.refresh()
    })
  }

  async stageFile(path: string): Promise<void> {
    return this.queue.run(async () => {
      await this.runner.run(["add", "--", path])
      await this.refresh()
    })
  }

  async stageFiles(paths: readonly string[]): Promise<void> {
    return this.runBatch(paths, async (path) => {
      await this.runner.run(["add", "--", path])
    })
  }

  async unstageFiles(paths: readonly string[]): Promise<void> {
    return this.runBatch(paths, async (path) => {
      await this.runner.run(["restore", "--staged", "--", path])
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
      // git clean refuses untracked nested git repositories (a directory with a
      // .git subdirectory) unless given a second -f (git-clean docs, --force).
      // lazygit deletes untracked files straight from disk instead
      // (pkg/commands/git_commands/working_tree.go:175-177 via
      // pkg/commands/oscommands/os.go:50,186-187 os.RemoveAll), so a single -f
      // silently no-ops where lazygit discards.
      await this.runner.run(["clean", "-ff", "-d", "--", path])
      await this.refresh()
    })
  }

  /**
   * Mirrors lazygit's FilesController.ResetSubmodule (files_controller.go:1804-1824):
   * unstage the gitlink, stash the child worktree, then force it to the parent module's recorded
   * commit (submodule.go:185-207).
   */
  async resetSubmodule(submodule: SubmoduleConfig): Promise<void> {
    return this.queue.run(async () => {
      const fullPath = submoduleFullPath(submodule)
      await this.runner.run(["restore", "--staged", "--", fullPath], { acceptedExitCodes: [0, 1] })

      let worktreeExists = true
      try {
        await stat(join(this.runner.cwd, fullPath))
      } catch (error) {
        if (error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT") {
          worktreeExists = false
        } else {
          throw error
        }
      }
      if (worktreeExists) {
        await this.runner.run(["-C", fullPath, "stash", "--include-untracked"])
      }

      const updateArgs = ["submodule", "update", "--init", "--force", "--", submodule.path]
      const parentPath = submodule.parentModule === undefined ? undefined : submoduleFullPath(submodule.parentModule)
      if (parentPath === undefined) {
        await this.runner.run(updateArgs)
      } else {
        await this.runner.run(["-C", parentPath, ...updateArgs])
      }
      await this.refresh()
    })
  }

  async discardFiles(paths: readonly string[], mode: DiscardFileMode): Promise<void> {
    return this.runBatch(paths, async (path) => {
      if (mode === "all") {
        await this.runner.run(["restore", "--staged", "--", path], { acceptedExitCodes: [0, 1] })
      }
      await this.runner.run(["restore", "--", path], { acceptedExitCodes: [0, 1] })
      // Same second -f as discardFile above: single -f refuses nested git repos.
      await this.runner.run(["clean", "-ff", "-d", "--", path])
    })
  }

  /**
   * Selecting every change of a file says "this file", so it is staged or unstaged as a file
   * rather than as a patch (lazygit pkg/gui/controllers/working_tree_diff_actions.go:302-313): a deleted file's diff
   * applied line by line to the index leaves an empty file there (`MD`) instead of the deletion,
   * and an added file's diff taken back out leaves it tracked and empty instead of untracked.
   */
  async applySelection(
    document: DiffDocument,
    includedLineIndexes: readonly number[],

    options: SelectionMutationOptions = { reverse: false, wholeFile: false }
  ): Promise<void> {
    return this.queue.run(async () => {
      const whole = options.wholeFile || options.pathOverride !== undefined ? { files: [], remaining: includedLineIndexes } : splitWholeFileSelection(document, includedLineIndexes)
      const patch = buildPartialPatch(document, whole.remaining, options)
      if (patch.length === 0 && whole.files.length === 0) return
      if (!options.wholeFile && document.files.length > 0 && document.files.every((file) => file.hunks.length === 0)) {
        throw new MutationSelectionError("Binary or conflicted files do not support line selection")
      }
      for (const file of whole.files) {
        await this.runner.run(options.reverse ? file.unstage : file.stage)
      }
      if (patch.length > 0) {
        const args = options.reverse ? ["apply", "--cached", "--reverse", "-"] : ["apply", "--cached", "-"]
        await this.runner.run(args, { stdin: patch })
      }
      await this.refresh()
    })
  }

  async discardSelection(document: DiffDocument, includedLineIndexes: readonly number[], options: Omit<SelectionMutationOptions, "reverse"> & { readonly reverse?: false } = { wholeFile: false }): Promise<void> {
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

/** A file the whole of whose diff is selected, and the git command that acts on it as a file. */
type WholeFileAction = {
  readonly stage: readonly string[]
  readonly unstage: readonly string[]
}

/**
 * Separates the files whose every change line is selected from the rest of a selection. Only
 * files with hunks qualify: a binary or conflicted file has no lines to select. Unstaging goes the
 * way lazygit's `UnStageFile` does (pkg/commands/git_commands/working_tree.go:72-85): `reset`
 * for a file HEAD has, `rm --cached --force` for an added one, which also works before the first
 * commit, where there is no HEAD to reset to.
 */
function splitWholeFileSelection(document: DiffDocument, includedLineIndexes: readonly number[]): { readonly files: readonly WholeFileAction[]; readonly remaining: readonly number[] } {
  const included = new Set(includedLineIndexes)
  const changes = new Map<number, number>()
  const selected = new Map<number, number>()
  document.lines.forEach((line, index) => {
    if (line.kind !== "addition" && line.kind !== "deletion") return
    changes.set(line.fileIndex, (changes.get(line.fileIndex) ?? 0) + 1)
    if (included.has(index)) selected.set(line.fileIndex, (selected.get(line.fileIndex) ?? 0) + 1)
  })
  const wholeFileIndexes = new Set<number>()
  const files: WholeFileAction[] = []
  for (const file of document.files) {
    const count = changes.get(file.fileIndex) ?? 0
    if (file.hunks.length === 0 || count === 0 || selected.get(file.fileIndex) !== count) continue
    const oldPath = file.oldPath === "/dev/null" ? undefined : file.oldPath
    const newPath = file.newPath === "/dev/null" ? undefined : file.newPath
    const path = newPath ?? oldPath
    if (path === undefined) continue
    wholeFileIndexes.add(file.fileIndex)
    files.push({
      stage: ["add", "--", path],
      unstage: oldPath === undefined ? ["rm", "--cached", "--force", "--quiet", "--", path] : ["reset", "--quiet", "HEAD", "--", ...new Set([oldPath, path])]
    })
  }
  return { files, remaining: includedLineIndexes.filter((index) => !wholeFileIndexes.has(document.lines[index]?.fileIndex ?? -1)) }
}
