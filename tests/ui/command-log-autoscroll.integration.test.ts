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
  async function harnessWithUpstream(height?: number): Promise<ShellHarness> {
    const created = await createShellHarness({ commits: ["base commit"], ...(height === undefined ? {} : { height }) })
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
    // `@` opens the command-log menu (pkg/gui/extras_panel.go:12-38); `t` toggles it shown
    // without moving focus, the same as its "show, don't focus" half in the old direct cycle.
    await harness.pressKey("@")
    await harness.pressKey("t")
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
    await harness.pressKey("t")
    await harness.flush()
    // Enough log to be scrollable, so the disarmed state is a real scrolled-up viewport. Three
    // pulls, not two: DEFAULT_LOG_HEIGHT's content area is 8 rows now (window_arrangement_helper.go
    // :415-417's frame made it 10 total), one row taller than before Task 9.
    await pull(harness)
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

  /**
   * lazygit binds these on the extras view (pkg/gui/keybindings.go:249-289): PrevItem/NextItem
   * (j/k), PrevPage/NextPage (,/.) and GotoTop/GotoBottom (</>). Before this task none of them
   * reached the command log at all — `,`/`.`/`</`>` fell through to the global bindings and moved
   * whichever pane the fallthrough resolved to, and j/k had no `command-log` handling in
   * `actionMoveCursor` — so this exercises real, previously-absent keyboard behaviour, not just a
   * binding table lookup.
   */
  test("j/k step the log one line and clear autoscroll, the same as the wheel", async () => {
    // A shorter terminal than the module default: a focused log now fills the available space
    // (getExtrasWindowSize's baseSize 1000 branch, window_arrangement_helper.go:404-406), so a
    // full-height 40-row terminal gives it ~28 content rows — too tall for three pulls' worth of
    // log lines to overflow. Shrinking the terminal keeps the same pull count meaningful.
    harness = await harnessWithUpstream(20)
    // `@` opens the command-log menu (pkg/gui/extras_panel.go:12-38); `f` forces it visible and
    // focused in one step, the same as the old direct cycle's "show, then focus" pair of presses.
    await harness.pressKey("@")
    await harness.pressKey("f")
    await harness.flush()
    const view = harness.app.view!
    await pull(harness)
    await pull(harness)
    await pull(harness)
    // The three pulls above ran while focus kept bouncing to "branches" (pull() presses "3"), so
    // refocus the log before driving it by keyboard.
    await harness.pressKey("@")
    await harness.pressKey("f")
    await harness.flush()
    expect(view.focusManager.active).toBe("command-log")
    expect(view.commandLogAutoscroll).toBe(true)
    const bottom = view.paneScrollY("command-log")
    expect(bottom).toBeGreaterThan(0)

    await harness.pressKey("k")
    await harness.flush()
    expect(view.paneScrollY("command-log")).toBe(bottom - 1)
    expect(view.commandLogAutoscroll).toBe(false)

    await harness.pressKey("j")
    await harness.flush()
    expect(view.paneScrollY("command-log")).toBe(bottom)
    // Scrolling back down to the very bottom by hand still leaves autoscroll off — only `>`
    // (goToExtrasPanelBottom) arms it (pkg/gui/extras_panel.go:56-61,89).
    expect(view.commandLogAutoscroll).toBe(false)
  })

  test("`<`, `.`, `,` and `>` jump and page the log through the matching autoscroll transition", async () => {
    // See the j/k test above: a focused log now fills the available space, so the module default
    // of 40 rows leaves ~28 content rows — too tall for the six pulls below to overflow.
    harness = await harnessWithUpstream(20)
    await harness.pressKey("@")
    await harness.pressKey("f")
    await harness.flush()
    // More than the wheel test needs: a page is the pane's visible height, so the scrollable
    // extent has to clear that by a comfortable margin for "a page lands short of the bottom" to
    // be a meaningful assertion rather than a coincidence of a small log.
    for (let i = 0; i < 6; i += 1) await pull(harness)
    const view = harness.app.view!
    await harness.pressKey("@")
    await harness.pressKey("f")
    await harness.flush()
    expect(view.focusManager.active).toBe("command-log")
    expect(view.commandLogAutoscroll).toBe(true)
    const maxScrollY = view.commandLogMaxScrollY()
    expect(maxScrollY).toBeGreaterThan(0)

    await harness.pressKey("<")
    await harness.flush()
    expect(view.paneScrollY("command-log")).toBe(0)
    expect(view.commandLogAutoscroll).toBe(false)

    await harness.pressKey(".")
    await harness.flush()
    const afterPageDown = view.paneScrollY("command-log")
    // PageDelta() is the pane's visible height (pkg/gui/context/view_trait.go:87-96), so a page
    // from the top lands short of the bottom rather than jumping straight there — a wrong step
    // size (e.g. one line, or the whole extent) would fail one side of this bound or the other.
    expect(afterPageDown).toBeGreaterThan(0)
    expect(afterPageDown).toBeLessThan(maxScrollY)
    expect(view.commandLogAutoscroll).toBe(false)

    await harness.pressKey(",")
    await harness.flush()
    // A direction flip here (`,` paging down instead of up) would leave this unchanged or larger.
    expect(view.paneScrollY("command-log")).toBeLessThan(afterPageDown)
    expect(view.commandLogAutoscroll).toBe(false)

    await harness.pressKey(">")
    await harness.flush()
    expect(view.paneScrollY("command-log")).toBe(view.commandLogMaxScrollY())
    // The one key in this group that arms the flag (pkg/gui/extras_panel.go:89) — if `>` cleared
    // it like every other key here, this is the assertion that would catch it.
    expect(view.commandLogAutoscroll).toBe(true)
  })

  /**
   * Carried item 1 from task 5's review: lazygit has no scrollbar over the extras view (the
   * draggable one here is one of githunk's three documented review extensions,
   * docs/lazygit-compatibility-v0.1.md), so there is no parity behaviour to copy. It is still
   * wired through `applyScrollInput` by analogy — an explicit user scroll clears the flag — so
   * that the next logged command does not yank a manually positioned scrollbar back down.
   */
  test("dragging or clicking the command log's scrollbar clears autoscroll", async () => {
    harness = await harnessWithUpstream()
    await harness.pressKey("@")
    await harness.pressKey("t")
    await harness.flush()
    await pull(harness)
    await pull(harness)
    await pull(harness)
    const view = harness.app.view!
    const win = view.geometry.windows.log!
    expect(view.commandLogAutoscroll).toBe(true)
    const barX = win.x1 - 1
    const barY = win.y0 + 1

    await harness.mockMouse.click(barX, barY)
    await harness.flush()
    expect(view.commandLogAutoscroll).toBe(false)

    // Re-arm with another logged command, then confirm the drag site (not just mouse-down) clears
    // it too — the fix touches three separate call sites in root-view.ts.
    await pull(harness)
    expect(view.commandLogAutoscroll).toBe(true)
    const topY = win.y0 + 1
    const bottomY = win.y1 - 1
    await harness.mockMouse.drag(barX, topY, barX, bottomY)
    await harness.flush()
    expect(view.paneScrollY("command-log")).toBe(view.commandLogMaxScrollY())
    // Landing exactly at the bottom does not re-arm it: a scrollbar drag always clears the flag
    // regardless of which way it moved, unlike `>`. This is the assertion that would fail if the
    // scrollbar site were wired to arm on reaching the bottom instead.
    expect(view.commandLogAutoscroll).toBe(false)
  })

  /**
   * Carried item 2 from task 5's review: `FocusManager`'s visibility-toggle `onChange` handler
   * used to call `commandLog.update(...)` directly, skipping the arm-count comparison
   * `update(model)` uses.
   *
   * The scenario the review described — wheel-scrolled without focus, then hidden while a
   * mutation logs output — turns out not to reach the bug through the keyboard: closing the log
   * requires it to be focused first (`FocusManager.handleKey`'s close branch guards on
   * `active === "command-log"`), and losing that focus is exactly what `applyFocus` arms on
   * (`RootView`'s own `"focus-lost"` wiring, root-view.ts:3539-3546, pkg/gui/controllers/
   * command_log_controller.go:29-33). So on every keyboard-driven close the pane's own flag is
   * already forced back to armed before the fixed and unfixed code could ever disagree — I
   * confirmed this by reverting the fix locally and re-running a keyboard-driven version of this
   * test, which still passed. Reaching the actual precondition needs `logVisible` to go false
   * without that focus transition, which nothing in the current UI does; `applyPersistedGeometry`
   * (root-view.ts:3500-3505) sets it directly but only once, at startup. So this test sets
   * `focusManager.logVisible` directly to isolate the reopen path's comparison from the (correct,
   * unrelated) focus-lost mechanism — confirmed to fail against the unfixed `onChange` handler.
   */
  test("reopening the log after a hidden mutation re-pins to the bottom immediately", async () => {
    harness = await harnessWithUpstream()
    await harness.pressKey("@")
    await harness.pressKey("t")
    await harness.flush()
    // Three pulls, not two — see the "re-arms" test above for why DEFAULT_LOG_HEIGHT's content
    // area needs one more pull's worth of lines to overflow since Task 9.
    await pull(harness)
    await pull(harness)
    await pull(harness)
    const view = harness.app.view!
    const logBox = view.paneTextGeometry("command-log")
    if (!logBox) throw new Error("the command log window is not laid out")
    await harness.mockMouse.scroll(logBox.screenX + 1, logBox.screenY + 1, "up")
    await harness.flush()
    expect(view.commandLogAutoscroll).toBe(false)
    expect(view.paneScrollY("command-log")).toBeLessThan(view.commandLogMaxScrollY())
    expect(view.focusManager.active).not.toBe("command-log")

    // Hide it without ever focusing it — see the block comment above for why the keyboard cannot
    // produce this precondition on its own.
    view.focusManager.logVisible = false

    // A mutation that logs a command while the log is hidden. `update(model)` skips
    // `refreshCommandLog` for a hidden log, so the arm count grows on `this.model` without being
    // consumed — exactly the gap the bug left for the reopen path to paper over incorrectly.
    await pull(harness)

    await harness.pressKey("@")
    await harness.pressKey("t")
    await harness.flush()
    expect(view.focusManager.logVisible).toBe(true)
    expect(view.commandLogAutoscroll).toBe(true)
    expect(view.paneScrollY("command-log")).toBe(view.commandLogMaxScrollY())
  })

  /**
   * Task 9 review, finding 1: `resize()`'s autoscroll pin is exact when the log *grows* (a
   * focus gain), because the `scrollY` setter's own clamp uses the same stale `text.height`
   * getter as the pin's target computation, and for growing the correct target is always ≤
   * that stale bound. Shrinking (a focus loss) is the opposite — the correct target *exceeds*
   * the stale bound, so the setter's clamp caps the pin short by `H_old - H_new` rows —
   * findable only by inspecting scrollY immediately after the shrink, before any later content
   * update's own (unclamped-by-the-bug) `text.scrollY = text.maxScrollY` assignment in
   * `update()` gets a chance to paper over it once the getter has caught up on its own. This is
   * that isolated check: it builds content first (so pull()'s own focus-changing "3" press
   * isn't the transition under test), then focuses the log (a grow, already exact pre-fix) and
   * defocuses it with nothing after but the defocus keypress itself.
   */
  test("losing focus shrinks the log and the autoscroll pin lands exactly at the new bottom", async () => {
    harness = await harnessWithUpstream(20)
    await harness.pressKey("@")
    await harness.pressKey("t")
    await harness.flush()
    // Six pulls' worth of log lines: comfortably more than the largest content height this
    // scenario ever shows (8 rows, focused, at this 20-row terminal — see below), so scrollY
    // has real room to be wrong in.
    for (let i = 0; i < 6; i += 1) await pull(harness)
    const view = harness.app.view!

    // Focus the log: getExtrasWindowSize's baseSize-1000 branch fills it to logCapacity (10
    // total / 8 content rows at height 20 — bodyHeight=19, logCapacity=19-1-8=10). Growing is
    // exact even pre-fix, so this step is not itself what the test is proving.
    await harness.pressKey("@")
    await harness.pressKey("f")
    expect(view.focusManager.active).toBe("command-log")
    expect(view.commandLogAutoscroll).toBe(true)

    // Defocus with nothing else after it. Height 20 is under MIN_HEIGHT_FOR_FULL_LOG (40), so
    // an unfocused-but-shown log takes the short-terminal branch regardless of the configured
    // size: MIN_LOG_HEIGHT=3 total / 1 content row — a 7-row shrink (8 -> 1), chosen to be
    // unmistakable rather than an off-by-one. Losing focus re-arms autoscroll (root-view.ts's
    // "focus-lost" wiring, pkg/gui/controllers/command_log_controller.go:29-33), so resize()'s
    // pin actually runs on this transition.
    await harness.pressKey("3")

    // commandLogMaxScrollY() is read after flush() (inside pressKey) has let frames elapse, so
    // it reflects the genuinely fresh post-shrink height. Pre-fix, the setter's clamp used
    // `text.height` from before this resize (8, not 1), capping the pin 7 rows short of this
    // value; the fix's `box.onSizeChange` + `queueMicrotask` correction closes that gap.
    expect(view.focusManager.active).not.toBe("command-log")
    expect(view.commandLogAutoscroll).toBe(true)
    expect(view.paneScrollY("command-log")).toBe(view.commandLogMaxScrollY())
  })
})
