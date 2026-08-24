import { describe, expect, test } from "bun:test"
import { filterItems, indexForStableId, removeLastSearchCharacter } from "../../src/app/filter"
import { FilterInput } from "../../src/ui/filter-input"

describe("Unicode-aware filtering", () => {
  const items = [
    { id: "one", label: "Résumé immédiat" },
    { id: "two", label: "Straße" },
    { id: "three", label: "Other" },
  ] as const

  test("matches case-insensitive Unicode substrings in source order", () => {
    expect(filterItems("RÉSUMÉ", items, (item) => item.label).map((item) => item.id)).toEqual(["one"])
    expect(filterItems("STR", items, (item) => item.label).map((item) => item.id)).toEqual(["two"])
  })

  test("empty and zero-result queries are explicit", () => {
    expect(filterItems("", items, (item) => item.label)).toBe(items)
    expect(filterItems("missing", items, (item) => item.label)).toEqual([])
  })

  test("retains a stable selection identifier when the filtered list changes", () => {
    const filtered = filterItems("e", items, (item) => item.label)
    expect(indexForStableId(filtered, "three", (item) => item.id, 0)).toBe(1)
    expect(indexForStableId<typeof items[number]>([], "two", (item) => item.id)).toBe(0)
  })
  test("filter input treats OpenTUI space and shifted payloads as printable text", () => {
    const input = new FilterInput()
    input.open()
    input.handleKey({ name: "space", sequence: " " })
    input.handleKey({ name: "P", sequence: "P", shift: true })
    input.handleKey({ name: "enter" })
    expect(input.state.query).toBe(" P")
  })


  test("backspace removes one grapheme rather than one UTF-16 code unit", () => {
    expect(removeLastSearchCharacter("a😀")).toBe("a")
    expect(removeLastSearchCharacter("e\u0301")).toBe("")
  })
})
