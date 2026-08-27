import { describe, expect, test } from "bun:test"
import { parseRawDiffZ, parseNumstatZ } from "../../../src/review/git/raw-diff"

describe("parseRawDiffZ", () => {
  test("parses modified, added, deleted", () => {
    const raw = [
      ":100644 100644 aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb M",
      "src/foo.ts",
      ":000000 100644 0000000000000000000000000000000000000000 cccccccccccccccccccccccccccccccccccccccc A",
      "new.txt",
      ":100644 000000 dddddddddddddddddddddddddddddddddddddddd 0000000000000000000000000000000000000000 D",
      "old.txt",
      "",
    ].join("\0")
    const entries = parseRawDiffZ(raw)
    expect(entries.length).toBe(3)
    expect(entries[0]!.path).toBe("src/foo.ts")
    expect(entries[0]!.status).toBe("M")
    expect(entries[0]!.oldMode).toBe("100644")
    expect(entries[0]!.newMode).toBe("100644")
    expect(entries[1]!.status).toBe("A")
    expect(entries[1]!.previousPath).toBeUndefined()
    expect(entries[2]!.status).toBe("D")
  })

  test("parses rename with score and previousPath", () => {
    const raw = ":100644 100644 aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb R100\0oldname.txt\0newname.txt\0"
    const entries = parseRawDiffZ(raw)
    expect(entries.length).toBe(1)
    expect(entries[0]!.status).toBe("R100")
    expect(entries[0]!.score).toBe(100)
    expect(entries[0]!.path).toBe("newname.txt")
    expect(entries[0]!.previousPath).toBe("oldname.txt")
  })

  test("parses copy with score", () => {
    const raw = ":100644 100644 aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb C100\0original.txt\0copy.txt\0"
    const entries = parseRawDiffZ(raw)
    expect(entries[0]!.status).toBe("C100")
    expect(entries[0]!.previousPath).toBe("original.txt")
  })

  test("parses mode change", () => {
    const raw = ":100644 100755 aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb M\0mode.txt\0"
    const entries = parseRawDiffZ(raw)
    expect(entries[0]!.oldMode).toBe("100644")
    expect(entries[0]!.newMode).toBe("100755")
  })

  test("empty raw returns empty", () => {
    expect(parseRawDiffZ("")).toEqual([])
  })

  test("throws on invalid metadata", () => {
    expect(() => parseRawDiffZ(":bad\0file.txt\0")).toThrow()
  })
})

describe("parseNumstatZ", () => {
  test("parses added and modified with numeric counts", () => {
    const raw = ["1\t2\tsrc/foo.ts", "5\t0\tnew.txt", ""].join("\0")
    const entries = parseNumstatZ(raw)
    expect(entries.length).toBe(2)
    expect(entries[0]).toEqual({ path: "src/foo.ts", additions: 1, deletions: 2 })
    expect(entries[1]).toEqual({ path: "new.txt", additions: 5, deletions: 0 })
  })

  test("maps binary dash to null", () => {
    const raw = ["-\t-\timage.png", ""].join("\0")
    const entries = parseNumstatZ(raw)
    expect(entries[0]!.additions).toBeNull()
    expect(entries[0]!.deletions).toBeNull()
  })

  test("parses rename with two trailing paths", () => {
    const raw = ["1\t1\t", "oldname.txt", "newname.txt", ""].join("\0")
    const entries = parseNumstatZ(raw)
    expect(entries.length).toBe(1)
    expect(entries[0]!.path).toBe("newname.txt")
    expect(entries[0]!.previousPath).toBe("oldname.txt")
    expect(entries[0]!.additions).toBe(1)
  })

  test("empty returns empty", () => {
    expect(parseNumstatZ("")).toEqual([])
  })
})
