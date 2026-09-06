import { GitCommandError } from "./runner"

/**
 * The one-line banner text for a failed operation: git's own stderr when a command failed, the
 * error message otherwise. Every controller banner is built from this so the wording cannot
 * drift between call sites.
 */
export function describeGitError(error: unknown): string {
  if (error instanceof GitCommandError) return error.record.stderr || error.message
  if (error instanceof Error) return error.message
  return String(error)
}
