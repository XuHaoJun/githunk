import { afterEach, describe, expect, test } from "bun:test"
import { createShellHarness, type ShellHarness } from "../helpers/shell-harness"
import { createTempRepository, type TempRepository } from "../helpers/temp-repository"

/**
 * lazygit's extras-view autoscroll, at the seams the pure `autoscrollAfter` transition
 * (tests/ui/command-log-scroll.test.ts) cannot reach: a real wheel event travelling through
 * OpenTUI's mouse dispatch into `RootView`, and a real mutation's log writes travelling through
 * `CommandLog` → `AppModel` → `RootView.update` → the pane.
 */
describe("command log autoscroll", () => {
  let harness: ShellHarness | undefined
  let remoteBare: TempRepository | undefined

  afterEach(async () => {
    await harness?.cleanup()
    harness = undefined
    await remoteBare?.cleanup()
    remoteBare = undefined
  })

  /**
   * A pull is the cheapest mutation that logs *both* kinds of write: `git pull` is logged as a
   * command (lazygit's `LogCommand`, an arming write) and its "Already up to date." is logged as
   * output by the per-command writer (never an arming write). Reads are not logged at all
   * (src/git/runner.ts:88), so a plain refresh cannot produce log lines.
   */
  async function harnessWithUpstream(): Promise<ShellHarness> {
    const created = await createShellHarness({ commits: ["base commit"] })
    remoteBare = await createTempRepository()
    await remoteBare.git(["config", "core.bare", "true"])
    await created.repository.git(["remote", "add", "origin", remoteBare.path])
    await created.repository.git(["push", "-u", "origin", "HEAD"])
    await created.app.refresh()
    return created
  }

  async function pull(target: ShellHarness): Promise<void> {
    await target.pressKey("3")
    await target.pressKey("p")
    await target.settle()
  }

  /**
   * A genuine `type: "scroll"` mouse event, not the programmatic `pane.scrollBy(...)` that every
   * other wheel test drives. The distinction is the whole point: OpenTUI 0.5.6's
   * `TextBufferRenderable.onMouseEvent` scrolls the view itself on a wheel event
   * (node_modules/@opentui/core/chunk-bun-da1keqyp.js:2814-2833) *without* consulting
   * `defaultPrevented`, and then `processMouseEvent` bubbles the same event up to
   * `RootView`'s own dispatcher (`:1259-1266`). A pane that does not suppress its local default
   * therefore applies two independent scrolls per tick, only one of which goes through the
   * autoscroll transition. lazygit binds the wheel over the extras view to the same
   * `scrollUpExtra`/`scrollDownExtra` handlers as `,`/`.` (pkg/gui/keybindings.go:248-258), and
   * both assign `Autoscroll = false` (pkg/gui/extras_panel.go:49,57).
   */
  test("wheel over the log scrolls it once, at every other pane's rate, and clears autoscroll", async () => {
    harness = await harnessWithUpstream()
    const view = harness.app.view!
    await harness.pressKey("@")
    await harness.flush()
    // Three pulls' worth of log lines, so the log overflows its window with room to scroll up in:
    // one mutation (-2 rows) is only distinguishable from two (-3) with headroom for three.
    await pull(harness)
    await pull(harness)
    await pull(harness)
    const logBox = view.paneTextGeometry("command-log")
    if (!logBox) throw new Error("the command log window is not laid out")
    // Armed at startup (pkg/gui/views.go:149), so the viewport sits pinned at the bottom.
    expect(view.commandLogAutoscroll).toBe(true)
    const before = view.paneScrollY("command-log")
    expect(before).toBeGreaterThanOrEqual(3)

    await harness.mockMouse.scroll(logBox.screenX + 1, logBox.screenY + 1, "up")
    await harness.flush()

    // The same two rows per tick every other pane gets from RootView's dispatch — see
    // tests/ui/mouse-parity.integration.test.ts's "wheel scrolls only the pane under the pointer",
    // which asserts exactly `before + 2`.
    expect(view.paneScrollY("command-log")).toBe(before - 2)
    expect(view.commandLogAutoscroll).toBe(false)
  })

  /**
   * The regression finding 2 describes. lazygit arms autoscroll inside `LogCommand` itself
   * (pkg/gui/command_log_panel.go:62) — at write time — and the per-command output writer that runs
   * straight afterwards never touches the flag (pkg/gui/extras_panel.go:109-119). githunk's view
   * cannot see writes, only the `AppModel` a controller action ends with (`view.update` fires once
   * per controller call, src/app/create-app.ts:244), so a mutation that logs its command and then
   * its output must still arm — the output being the batch's last write is not information the view
   * is allowed to lose.
   */
  test("a mutation re-arms autoscroll even though its output was the batch's last write", async () => {
    harness = await harnessWithUpstream()
    const view = harness.app.view!
    await harness.pressKey("@")
    await harness.flush()
    // Enough log to be scrollable, so the disarmed state is a real scrolled-up viewport.
    await pull(harness)
    await pull(harness)
    const logBox = view.paneTextGeometry("command-log")
    if (!logBox) throw new Error("the command log window is not laid out")
    await harness.mockMouse.scroll(logBox.screenX + 1, logBox.screenY + 1, "up")
    await harness.flush()
    expect(view.commandLogAutoscroll).toBe(false)
    expect(view.paneScrollY("command-log")).toBeLessThan(view.commandLogMaxScrollY())

    await pull(harness)

    expect(view.commandLogAutoscroll).toBe(true)
    expect(view.paneScrollY("command-log")).toBe(view.commandLogMaxScrollY())
  })
})
