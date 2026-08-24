import { describe, expect, test } from "bun:test"
import { CommitDialog, commitDialogKey, createCommitDialog, reduceCommitDialog } from "../../src/ui/commit-dialog"

describe("commit dialog", () => {
  test("accepts multiline and Unicode text only on Ctrl+Enter", () => {
    let state = createCommitDialog("commit")
    state = reduceCommitDialog(state, { kind: "insert", text: "subject Ω" }).state
    state = reduceCommitDialog(state, { kind: "newline" }).state
    state = reduceCommitDialog(state, { kind: "newline" }).state
    state = reduceCommitDialog(state, { kind: "insert", text: "body 中文" }).state
    expect(commitDialogKey(state, { name: "enter" }).state.message).toBe("subject Ω\n\nbody 中文\n")
    expect(commitDialogKey(state, { name: "enter", ctrl: true }).result).toEqual({ kind: "confirmed", message: "subject Ω\n\nbody 中文" })
  })

  test("rejects empty and whitespace-only messages", () => {
    const dialog = new CommitDialog("commit", " \n\t")
    expect(dialog.handleKey({ name: "enter", ctrl: true })).toBeUndefined()
    expect(dialog.state.error).toContain("empty")
  })

  test("Esc cancels without producing a message", () => {
    const dialog = new CommitDialog("amend", "existing\n")
    expect(dialog.handleKey({ name: "escape" })).toEqual({ kind: "cancelled" })
    expect(dialog.state.message).toBe("existing\n")
  })
})
