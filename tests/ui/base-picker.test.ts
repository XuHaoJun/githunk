import { describe, expect, test } from "bun:test"
import { basePickerOptions, renderBasePicker } from "../../src/ui/base-picker"

describe("base picker", () => {
  test("renders and exposes candidates beyond numeric shortcut range", () => {
    const picker = { kind: "choose" as const, candidates: Array.from({ length: 12 }, (_, index) => `branch-${index + 1}`), reason: "choose" }
    expect(basePickerOptions(picker)).toHaveLength(12)
    expect(renderBasePicker(picker)).toContain("12. branch-12")
  })
})
