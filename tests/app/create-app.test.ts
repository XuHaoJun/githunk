import { describe, expect, test } from "bun:test"
import { createApp } from "../../src/app/create-app"
import { GitRunner } from "../../src/git/runner"
import { COMMAND_LOG_HEADER } from "../../src/app/command-log-tips"

describe("createApp seeds the command log before the controller is built", () => {
  /**
   * `printCommandLogHeader` runs at lazygit startup (pkg/gui/command_log_panel.go:70-85), before
   * the gui's first render. `createApp` (src/app/create-app.ts:85) seeds the header immediately
   * before `new AppController(...)` (:89) specifically so the controller's very first `AppModel` —
   * captured at construction time (`controller.ts:242`, `commandLog: runner?.log.lines() ?? []`) —
   * already carries it, in the headless path (no `renderer`) as much as the full one.
   *
   * This test never calls `app.refresh()` or dispatches any action, so it fails on exactly the
   * regression this ordering guards against: delete the `seedCommandLog` call (or move it after
   * `new AppController(...)` in a way that only reaches the log on some later path, e.g. behind
   * `renderer !== undefined`), and `controller.state.commandLog` is `[]` here rather than merely
   * "eventually populated once something refreshes." Presence *and* immediacy are both pinned.
   */
  test("the header is present in the very first AppModel snapshot, before any refresh", () => {
    const app = createApp({ repositoryRoot: "/tmp/does-not-exist", runner: new GitRunner("/tmp/does-not-exist") })
    const texts = app.controller.state.commandLog.map((line) => line.spans.map((span) => span.text).join(""))
    expect(texts[0]).toBe(COMMAND_LOG_HEADER)
  })
})
