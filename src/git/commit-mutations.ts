import { MutationQueue } from "../app/mutation-queue"
import { GitCommandError, GitRunner } from "./runner"

export type CommitMutationOptions = {
  readonly refresh?: () => Promise<void>
}

export class EmptyCommitMessageError extends Error {
  constructor() {
    super("Commit message cannot be empty")
    this.name = "EmptyCommitMessageError"
  }
}

/** Safe commit and amend operations. Message text is always sent over stdin. */
export class CommitMutations {
  readonly runner: GitRunner
  private readonly refresh: () => Promise<void>
  private readonly queue = new MutationQueue()

  constructor(runner: GitRunner, options: CommitMutationOptions = {}) {
    this.runner = runner
    this.refresh = options.refresh ?? (async () => undefined)
  }

  async commit(message: string): Promise<void> {
    return this.queue.run(async () => {
      validateMessage(message)
      await this.runner.run(["commit", "-F", "-"], { stdin: message })
      await this.refresh()
    })
  }

  async amend(message: string): Promise<void> {
    return this.queue.run(async () => {
      validateMessage(message)
      await this.runner.run(["commit", "--amend", "-F", "-"], { stdin: message })
      await this.refresh()
    })
  }

  async currentMessage(): Promise<string> {
    return (await this.runner.run(["log", "-1", "--format=%B"], { readOnly: true })).stdout
  }

  async amendMessage(): Promise<string> {
    return this.currentMessage()
  }
}

export class GitCommitMutations extends CommitMutations {}

export async function commit(runner: GitRunner, message: string): Promise<void> {
  return new CommitMutations(runner).commit(message)
}

export async function amend(runner: GitRunner, message: string): Promise<void> {
  return new CommitMutations(runner).amend(message)
}

function validateMessage(message: string): void {
  if (message.trim().length === 0) throw new EmptyCommitMessageError()
}

export function commitMutationErrorMessage(error: unknown): string {
  if (error instanceof GitCommandError) return error.record.stderr || error.message
  return error instanceof Error ? error.message : String(error)
}
