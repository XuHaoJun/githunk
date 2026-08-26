import { describe, expect, test } from "bun:test"
import { autoscrollAfter, type CommandLogScrollInput } from "../../src/ui/panes/command-log-scroll"

/**
 * lazygit's `view.Autoscroll` for the extras view. The surprising half is that scrolling *down*
 * clears it too (`scrollDownExtra`, pkg/gui/extras_panel.go:56-61), so holding `j` to the bottom
 * does not re-arm it — only `>` and losing focus do.
 */
describe("autoscrollAfter", () => {
  const clears: readonly CommandLogScrollInput[] = ["scroll-up", "scroll-down", "page-up", "page-down", "goto-top", "scrollbar"]
  const arms: readonly CommandLogScrollInput[] = ["append-entry", "goto-bottom", "focus-lost"]
  const leaves: readonly CommandLogScrollInput[] = ["append-output", "append-header", "resize"]

  for (const input of clears) {
    test(`${input} clears autoscroll`, () => {
      expect(autoscrollAfter(true, input)).toBe(false)
      expect(autoscrollAfter(false, input)).toBe(false)
    })
  }

  for (const input of arms) {
    test(`${input} arms autoscroll`, () => {
      expect(autoscrollAfter(false, input)).toBe(true)
      expect(autoscrollAfter(true, input)).toBe(true)
    })
  }

  for (const input of leaves) {
    test(`${input} leaves autoscroll alone`, () => {
      expect(autoscrollAfter(false, input)).toBe(false)
      expect(autoscrollAfter(true, input)).toBe(true)
    })
  }

  test("scrolling up then a new command re-arms it, because LogAction assigns true", () => {
    let state = autoscrollAfter(true, "scroll-up")
    expect(state).toBe(false)
    state = autoscrollAfter(state, "append-entry")
    expect(state).toBe(true)
  })

  test("holding j to the bottom leaves it off, unlike goto-bottom", () => {
    let state = true
    for (let index = 0; index < 5; index++) state = autoscrollAfter(state, "scroll-down")
    expect(state).toBe(false)
    expect(autoscrollAfter(state, "goto-bottom")).toBe(true)
  })
})
