import { describe, expect, test } from "bun:test"
import { parseAnsi } from "../../src/ui/ansi"

const ESC = "\u001b"

describe("parseAnsi", () => {
  test("plain text carries no spans", () => {
    expect(parseAnsi("commit abc\nAuthor: A")).toEqual({ text: "commit abc\nAuthor: A", spans: [] })
  })

  test("an SGR foreground colours the run it opens and is dropped from the text", () => {
    const parsed = parseAnsi(`${ESC}[33mcommit abc1234${ESC}[m (HEAD)`)
    expect(parsed.text).toBe("commit abc1234 (HEAD)")
    expect(parsed.spans).toEqual([{ row: 0, start: 0, end: 14, fg: "#808000" }])
  })

  test("a run is split at every newline so spans stay row-local", () => {
    const parsed = parseAnsi(`${ESC}[31mred one\nred two${ESC}[m`)
    expect(parsed.text).toBe("red one\nred two")
    expect(parsed.spans).toEqual([
      { row: 0, start: 0, end: 7, fg: "#800000" },
      { row: 1, start: 0, end: 7, fg: "#800000" },
    ])
  })

  test("columns are counted from the start of the row, not the start of the input", () => {
    const parsed = parseAnsi(`plain\n  ${ESC}[36m| ${ESC}[m* rest`)
    expect(parsed.text).toBe("plain\n  | * rest")
    expect(parsed.spans).toEqual([{ row: 1, start: 2, end: 4, fg: "#008080" }])
  })

  test("bright colours, bold and dim are reported", () => {
    const parsed = parseAnsi(`${ESC}[1;91mA${ESC}[0m${ESC}[2mB${ESC}[m`)
    expect(parsed.text).toBe("AB")
    expect(parsed.spans).toEqual([
      { row: 0, start: 0, end: 1, fg: "#ff6666", bold: true },
      { row: 0, start: 1, end: 2, dim: true },
    ])
  })

  test("256-colour and truecolor foregrounds resolve to hex", () => {
    expect(parseAnsi(`${ESC}[38;5;12mA${ESC}[m`).spans).toEqual([{ row: 0, start: 0, end: 1, fg: "#6666ff" }])
    expect(parseAnsi(`${ESC}[38;5;196mA${ESC}[m`).spans).toEqual([{ row: 0, start: 0, end: 1, fg: "#ff0000" }])
    expect(parseAnsi(`${ESC}[38;2;130;89;221mA${ESC}[m`).spans).toEqual([{ row: 0, start: 0, end: 1, fg: "#8259dd" }])
  })

  test("39 restores the default foreground and 22 clears bold and dim", () => {
    const parsed = parseAnsi(`${ESC}[32;1mA${ESC}[39mB${ESC}[22mC`)
    expect(parsed.text).toBe("ABC")
    expect(parsed.spans).toEqual([
      { row: 0, start: 0, end: 1, fg: "#008000", bold: true },
      { row: 0, start: 1, end: 2, bold: true },
    ])
  })

  test("non-SGR escapes are stripped without producing spans", () => {
    expect(parseAnsi(`a${ESC}[Kb${ESC}]8;;http://x${ESC}\\c${ESC}(Bd`)).toEqual({ text: "abcd", spans: [] })
  })

  test("background-only SGR parameters are ignored", () => {
    expect(parseAnsi(`${ESC}[44mA${ESC}[m`)).toEqual({ text: "A", spans: [] })
  })
})
