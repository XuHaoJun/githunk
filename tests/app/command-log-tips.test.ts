import { describe, expect, test } from "bun:test"
import { CommandLog } from "../../src/app/command-log"
import {
  COMMAND_LOG_HEADER,
  COMMAND_LOG_TIPS,
  COMMAND_LOG_TIP_KEYS,
  RANDOM_TIP_LABEL,
  randomTip,
  seedCommandLog,
} from "../../src/app/command-log-tips"
import { BindingRegistry, GITHUNK_BINDINGS } from "../../src/ui/bindings"

function texts(log: CommandLog): readonly string[] {
  return log.lines().map((line) => line.spans.map((span) => span.text).join(""))
}

describe("command log header", () => {
  /** `CommandLogHeader` formatted with `Universal.ExtrasMenu` (english.go:1951, user_config.go:1072). */
  test("names the key that hides and focuses the panel", () => {
    expect(COMMAND_LOG_HEADER).toBe("You can hide/focus this panel by pressing '@'")
  })

  test("seeds the intro, its blank line, and a tip", () => {
    const log = new CommandLog()
    seedCommandLog(log, { showRandomTip: true, pick: () => 0 })
    expect(texts(log)).toEqual([COMMAND_LOG_HEADER, "", `${RANDOM_TIP_LABEL}: ${COMMAND_LOG_TIPS[0]}`])
  })

  /** `Gui.ShowRandomTip` (user_config.go:909) is on by default but can be off. */
  test("omits the tip when tips are off", () => {
    const log = new CommandLog()
    seedCommandLog(log, { showRandomTip: false })
    expect(texts(log)).toEqual([COMMAND_LOG_HEADER, ""])
  })

  /**
   * lazygit assigns `Autoscroll = true` only inside `LogAction`/`LogCommand`
   * (command_log_panel.go:38,62), never in the header (`:70-85`) or `logTip`/`logIntro` which back
   * it — so seeding at startup must not arm autoscroll. `CommandLog` exposes this as a monotonic
   * `autoscrollArms()` counter (src/app/command-log.ts:32-48), not a "last write kind": a batch of
   * writes can end on a non-arming write yet still have armed earlier in the same batch, which is
   * why the counter — not the tail — is what `RootView` compares against.
   */
  test("the seeded header does not arm autoscroll", () => {
    const log = new CommandLog()
    seedCommandLog(log, { showRandomTip: true, pick: () => 0 })
    expect(log.autoscrollArms()).toBe(0)
  })
})

describe("random tips", () => {
  test("picks within range and returns a tip", () => {
    expect(randomTip(() => 0)).toBe(COMMAND_LOG_TIPS[0]!)
    expect(COMMAND_LOG_TIPS).toContain(randomTip())
  })

  test("has no empty or duplicated tips", () => {
    expect(new Set(COMMAND_LOG_TIPS).size).toBe(COMMAND_LOG_TIPS.length)
    for (const tip of COMMAND_LOG_TIPS) expect(tip.trim().length).toBeGreaterThan(0)
  })

  /**
   * `Math.min(Math.max(0, NaN), n)` is `NaN`, which survives the old clamp and indexes to
   * `undefined` — rendering a bare "Random tip: ". Non-finite picks (`NaN`, `Infinity`) are treated
   * as `0` before clamping instead. A finite but out-of-range pick still clamps to the last tip, as
   * before.
   */
  test("a non-finite pick does not render a bare 'Random tip: '", () => {
    expect(randomTip(() => NaN)).toBe(COMMAND_LOG_TIPS[0]!)
    expect(randomTip(() => Number.POSITIVE_INFINITY)).toBe(COMMAND_LOG_TIPS[0]!)
    expect(randomTip(() => Number.NEGATIVE_INFINITY)).toBe(COMMAND_LOG_TIPS[0]!)
    expect(randomTip(() => COMMAND_LOG_TIPS.length + 100)).toBe(COMMAND_LOG_TIPS.at(-1)!)
  })

  /**
   * The catalogue is the subset of lazygit's (command_log_panel.go:90-199) whose feature *and*
   * keybinding exist in githunk — a tip naming a key githunk does not bind would tell the user to
   * press nothing. This test is what keeps that true: rebinding a key breaks it rather than
   * silently making a tip lie.
   */
  test("every key a tip names is still bound to the action the tip describes", () => {
    const registry = new BindingRegistry(GITHUNK_BINDINGS)
    for (const expected of Object.values(COMMAND_LOG_TIP_KEYS)) {
      const bound = registry.bindings.some((binding) => binding.action === expected.action && binding.keys.includes(expected.key))
      expect(bound).toBe(true)
      // This only proves the label isn't orphaned *somewhere* in the catalogue, not that the tip
      // describing `expected.action` is the one carrying it: two entries can share a label
      // ("enter" names both stashInspect and enterDirectory), so they are mutually satisfiable and
      // this assertion cannot catch a mislabelled pair. The `bound` check above is what actually
      // ties each entry to its action; this is a weaker "no dangling key" sanity check on top.
      expect(COMMAND_LOG_TIPS.some((tip) => tip.includes(`'${expected.label}'`))).toBe(true)
    }
    // Every pinned key must actually be referenced by a tip; an orphan entry means a tip was
    // dropped without its key, and the loop above would not notice.
    expect(Object.keys(COMMAND_LOG_TIP_KEYS)).toHaveLength(10)
  })
})
