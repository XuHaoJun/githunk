import { describe, expect, test } from "bun:test"
import { RGBA } from "@opentui/core"
import { parseAnsi } from "../../src/ui/ansi"

const ESC = "\u001b"

function expectIndexed(color: RGBA | undefined, slot: number): void {
  expect(color?.intent).toBe("indexed")
  expect(color?.slot).toBe(slot)
}

describe("parseAnsi", () => {
  test("plain text carries no spans", () => {
    expect(parseAnsi("commit abc\nAuthor: A")).toEqual({ text: "commit abc\nAuthor: A", spans: [] })
  })

  test("an SGR foreground keeps its terminal index and is dropped from the text", () => {
    const parsed = parseAnsi(`${ESC}[33mcommit abc1234${ESC}[m (HEAD)`)
    expect(parsed.text).toBe("commit abc1234 (HEAD)")
    expectIndexed(parsed.spans[0]?.fg, 3)
  })

  test("a run is split at every newline so spans stay row-local", () => {
    const parsed = parseAnsi(`${ESC}[31mred one\nred two${ESC}[m`)
    expect(parsed.text).toBe("red one\nred two")
    expect(parsed.spans).toHaveLength(2)
    expectIndexed(parsed.spans[0]?.fg, 1)
    expectIndexed(parsed.spans[1]?.fg, 1)
  })

  test("columns are counted from the start of the row, not the start of the input", () => {
    const parsed = parseAnsi(`plain\n  ${ESC}[36m| ${ESC}[m* rest`)
    expect(parsed.text).toBe("plain\n  | * rest")
    expect(parsed.spans[0]?.row).toBe(1)
    expect(parsed.spans[0]?.start).toBe(2)
    expect(parsed.spans[0]?.end).toBe(4)
    expectIndexed(parsed.spans[0]?.fg, 6)
  })

  test("bright colours, bold and dim are reported", () => {
    const parsed = parseAnsi(`${ESC}[1;91mA${ESC}[0m${ESC}[2mB${ESC}[m`)
    expect(parsed.text).toBe("AB")
    expectIndexed(parsed.spans[0]?.fg, 9)
    expect(parsed.spans[0]?.bold).toBe(true)
    expect(parsed.spans[1]?.fg).toBeUndefined()
    expect(parsed.spans[1]?.dim).toBe(true)
  })

  test("256-colour indexes stay indexed and truecolor stays RGB", () => {
    const indexed = parseAnsi(`${ESC}[38;5;12mA${ESC}[m`).spans[0]
    expectIndexed(indexed?.fg, 12)

    const truecolor = parseAnsi(`${ESC}[38;2;130;89;221mA${ESC}[m`).spans[0]?.fg
    expect(truecolor?.intent).toBe("rgb")
    expect(truecolor?.toInts()).toEqual([130, 89, 221, 255])
  })

  test("39 restores the default foreground and 22 clears bold and dim", () => {
    const parsed = parseAnsi(`${ESC}[32;1mA${ESC}[39mB${ESC}[22mC`)
    expect(parsed.text).toBe("ABC")
    expectIndexed(parsed.spans[0]?.fg, 2)
    expect(parsed.spans[0]?.bold).toBe(true)
    expect(parsed.spans[1]?.fg).toBeUndefined()
    expect(parsed.spans[1]?.bold).toBe(true)
  })
  test("reapplying the same indexed color keeps one span", () => {
    const parsed = parseAnsi(`${ESC}[31mA${ESC}[31mB${ESC}[m`)
    expect(parsed.spans).toHaveLength(1)
    expect(parsed.spans[0]?.start).toBe(0)
    expect(parsed.spans[0]?.end).toBe(2)
    expectIndexed(parsed.spans[0]?.fg, 1)
  })


  test("non-SGR escapes are stripped without producing spans", () => {
    expect(parseAnsi(`a${ESC}[Kb${ESC}]8;;http://x${ESC}\\c${ESC}(Bd`)).toEqual({ text: "abcd", spans: [] })
  })

  test("background-only SGR parameters are ignored", () => {
    expect(parseAnsi(`${ESC}[44mA${ESC}[m`)).toEqual({ text: "A", spans: [] })
  })
})
