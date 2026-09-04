import { describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { parseCliArgs } from "../../src/cli/args"

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))))

describe("parseCliArgs", () => {
  test("starts in the current directory when no path is given", () => {
    expect(parseCliArgs([])).toEqual({ kind: "start" })
  })

  test("takes the start directory from --path", () => {
    expect(parseCliArgs(["--path", "/tmp/repo"])).toEqual({ kind: "start", startDirectory: "/tmp/repo" })
  })

  test("takes the start directory from -p", () => {
    expect(parseCliArgs(["-p", "/tmp/repo"])).toEqual({ kind: "start", startDirectory: "/tmp/repo" })
  })

  test("takes the start directory from --path=<dir>", () => {
    expect(parseCliArgs(["--path=/tmp/repo"])).toEqual({ kind: "start", startDirectory: "/tmp/repo" })
  })

  test("takes the start directory from a positional path", () => {
    expect(parseCliArgs(["/tmp/repo"])).toEqual({ kind: "start", startDirectory: "/tmp/repo" })
  })

  test("prefers the explicit --path over a positional path", () => {
    expect(parseCliArgs(["--path", "/tmp/explicit", "/tmp/positional"])).toEqual({
      kind: "start",
      startDirectory: "/tmp/explicit",
    })
  })

  test("treats text after -- as a positional path, not a flag", () => {
    expect(parseCliArgs(["--", "--path"])).toEqual({ kind: "start", startDirectory: "--path" })
  })

  test("reports help for --help", () => {
    const result = parseCliArgs(["--help"])
    expect(result.kind).toBe("help")
    if (result.kind !== "help") throw new Error("unreachable")
    expect(result.text).toContain("Usage")
    expect(result.text).toContain("--path")
  })

  test("reports help for -h", () => {
    expect(parseCliArgs(["-h"]).kind).toBe("help")
  })

  test("reports the package version for --version", async () => {
    const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as { version: string }
    const result = parseCliArgs(["--version"])
    expect(result.kind).toBe("version")
    if (result.kind !== "version") throw new Error("unreachable")
    expect(result.text).toContain(manifest.version)
  })

  test("rejects an unknown flag", () => {
    const result = parseCliArgs(["--nope"])
    expect(result.kind).toBe("error")
    if (result.kind !== "error") throw new Error("unreachable")
    expect(result.exitCode).toBe(1)
    expect(result.message.length).toBeGreaterThan(0)
  })

  test("rejects a missing --path value", () => {
    const result = parseCliArgs(["--path"])
    expect(result.kind).toBe("error")
    if (result.kind !== "error") throw new Error("unreachable")
    expect(result.exitCode).not.toBe(0)
  })
})
