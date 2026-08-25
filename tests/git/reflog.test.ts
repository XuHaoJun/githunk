import { describe, expect, test } from "bun:test"
import { REFLOG_LIMIT, listReflog, parseReflog } from "../../src/git/reflog"
import { reflogEntryId, shortHash } from "../../src/domain/reflog"

type Call = { readonly args: readonly string[]; readonly options: unknown }

function fakeRunner(stdout: string, exitCode = 0) {
  const calls: Call[] = []
  const runner = {
    run: async (args: readonly string[], options: unknown) => {
      calls.push({ args: [...args], options })
      return { exitCode, stdout, stderr: "", record: {} as never }
    },
  }
  return { runner, calls }
}

function record(oid: string, unix: string, subject: string, parents: string): string {
  return `${oid}\0${unix}\0${subject}\0${parents}\0`
}

describe("reflog parsing", () => {
  test("parses hash, commit timestamp, reflog subject, and parents", () => {
    const raw =
      record("a".repeat(40), "1700000000", "checkout: moving from main to feature", `${"b".repeat(40)}`) +
      record("b".repeat(40), "1699999999", "commit (initial): root", "")
    const entries = parseReflog(raw)
    expect(entries).toHaveLength(2)
    expect(entries[0]?.oid).toBe("a".repeat(40))
    expect(entries[0]?.shortOid).toBe("aaaaaaaa")
    expect(entries[0]?.subject).toBe("checkout: moving from main to feature")
    expect(entries[0]?.parentOids).toEqual(["b".repeat(40)])
    expect(entries[0]?.committedAtUnix).toBe(1700000000)
    expect(entries[0]?.committedAt).toBe(new Date(1700000000 * 1000).toISOString())
    expect(entries[0]?.index).toBe(0)
    expect(entries[0]?.selector).toBe("HEAD@{0}")
    expect(entries[1]?.parentOids).toEqual([])
    expect(entries[1]?.index).toBe(1)
    expect(entries[1]?.selector).toBe("HEAD@{1}")
  })

  test("keeps spaces, colons, and control characters inside the reflog subject", () => {
    const subject = "rebase (finish): returning to refs/heads/feat:x y"
    const entries = parseReflog(record("c".repeat(40), "1700000001", subject, ""))
    expect(entries[0]?.subject).toBe(subject)
  })

  test("splits multi-parent merge entries on spaces", () => {
    const parents = `${"d".repeat(40)} ${"e".repeat(40)}`
    const entries = parseReflog(record("f".repeat(40), "1700000002", "merge feat: Fast-forward", parents))
    expect(entries[0]?.parentOids).toEqual([`${"d".repeat(40)}`, `${"e".repeat(40)}`])
  })

  test("gives duplicate hash and subject pairs distinct ids", () => {
    // `%ct` is the COMMIT timestamp, so consecutive entries can share hash and
    // timestamp; identical subjects are possible too (two hops back and forth).
    const subject = "checkout: moving from main to feature"
    const raw =
      record("a".repeat(40), "1700000000", subject, "") +
      record("a".repeat(40), "1700000000", subject, "")
    const entries = parseReflog(raw)
    expect(entries[0]?.id).not.toBe(entries[1]?.id)
    expect(entries[0]?.id).toBe(reflogEntryId("a".repeat(40), subject, 0))
    expect(entries[1]?.id).toBe(reflogEntryId("a".repeat(40), subject, 1))
  })

  test("ids are unambiguous when a subject itself looks like an occurrence suffix", () => {
    expect(reflogEntryId("a".repeat(40), "subject#1", 0)).not.toBe(reflogEntryId("a".repeat(40), "subject", 1))
  })

  test("uses the requested ref for selectors", () => {
    const entries = parseReflog(record("a".repeat(40), "1700000000", "branch: Created from HEAD", ""), "refs/heads/feat")
    expect(entries[0]?.selector).toBe("refs/heads/feat@{0}")
  })

  test("ignores empty output", () => {
    expect(parseReflog("")).toEqual([])
    expect(parseReflog("\n")).toEqual([])
  })

  test("shortens hashes to lazygit's eight characters", () => {
    expect(shortHash("0123456789abcdef")).toBe("01234567")
    expect(shortHash("abc")).toBe("abc")
  })
})

describe("reflog loader", () => {
  test("asks git for a NUL-delimited reflog walk with signatures off and a default cap", async () => {
    const { runner, calls } = fakeRunner("")
    await listReflog(runner as never)
    const args = calls[0]?.args ?? []
    expect(args.slice(0, 3)).toEqual(["-c", "log.showSignature=false", "log"])
    expect(args).toContain("-g")
    expect(args).toContain("-z")
    expect(args).toContain("--format=%H%x00%ct%x00%gs%x00%P")
    expect(args.slice(-2)).toEqual(["-n", String(REFLOG_LIMIT)])
    expect(calls[0]?.options).toMatchObject({ readOnly: true })
  })

  test("honours an explicit ref and limit", async () => {
    const { runner, calls } = fakeRunner("")
    await listReflog(runner as never, { ref: "refs/heads/feat", limit: 5 })
    const args = calls[0]?.args ?? []
    expect(args).toContain("refs/heads/feat")
    expect(args.slice(-2)).toEqual(["-n", "5"])
  })

  test("returns an empty list when the repository has no reflog", async () => {
    const { runner, calls } = fakeRunner("fatal: no reflog for 'HEAD'", 128)
    expect(await listReflog(runner as never)).toEqual([])
    expect(calls[0]?.options).toMatchObject({ acceptedExitCodes: [0, 128] })
  })

  test("maps loaded records through the parser", async () => {
    const { runner } = fakeRunner(record("a".repeat(40), "1700000000", "commit: work", "".repeat(0)))
    const entries = await listReflog(runner as never, { ref: "HEAD" })
    expect(entries).toHaveLength(1)
    expect(entries[0]?.subject).toBe("commit: work")
  })
})
