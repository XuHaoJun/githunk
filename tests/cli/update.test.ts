import { createHash } from "node:crypto"
import { describe, expect, test } from "bun:test"
import { runUpdate, type UpdateEnvironment } from "../../src/cli/update"

function sha256Hex(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex")
}

function stubEnv(overrides: Partial<UpdateEnvironment> = {}): UpdateEnvironment & {
  calls: { fetchTag: number; fetchAsset: number; replace: string[] }
} {
  const calls = { fetchTag: 0, fetchAsset: 0, replace: [] as string[] }
  const tarball = new TextEncoder().encode("fake-tarball-bytes")
  const asset = "githunk-linux-x64.tar.gz"
  return {
    calls,
    executablePath: "/home/user/.local/bin/githunk",
    platform: "linux",
    arch: "x64",
    installedVersion: () => "0.2.0",
    fetchReleaseTag: () => {
      calls.fetchTag += 1
      return Promise.resolve("v0.3.0")
    },
    fetchAsset: (_tag: string, _asset: string) => {
      calls.fetchAsset += 1
      return Promise.resolve({ tarball, checksums: `${sha256Hex(tarball)}  ${asset}\n` })
    },
    withTempDir: (fn) => fn("/tmp/githunk-update-test"),
    writeFile: () => Promise.resolve(),
    extractTarball: () => Promise.resolve(),
    stagedBinary: (dir) => `${dir}/githunk-linux-x64/githunk`,
    writeBinary: (staged, dest) => {
      calls.replace.push(`${staged} -> ${dest}`)
      return Promise.resolve()
    },
    ...overrides,
  }
}

describe("runUpdate", () => {
  test("points npm installs at the package manager without touching the network", async () => {
    const env = stubEnv({ executablePath: "/usr/bin/node" })
    const result = await runUpdate({ check: false }, env)
    expect(result.exitCode).toBe(1)
    expect(result.message).toContain("npm update --global @xuhaojun/githunk")
    expect(env.calls.fetchTag).toBe(0)
  })

  test("reports up to date without downloading", async () => {
    const env = stubEnv({ installedVersion: () => "0.3.0" })
    const result = await runUpdate({ check: false }, env)
    expect(result).toEqual({ exitCode: 0, message: "githunk 0.3.0 is already up to date" })
    expect(env.calls.fetchAsset).toBe(0)
  })

  test("check reports the available version without replacing the binary", async () => {
    const env = stubEnv()
    const result = await runUpdate({ check: true }, env)
    expect(result).toEqual({ exitCode: 0, message: "update available: 0.2.0 -> 0.3.0" })
    expect(env.calls.replace).toEqual([])
  })

  test("applies the update and replaces the installed binary", async () => {
    const env = stubEnv()
    const result = await runUpdate({ check: false }, env)
    expect(result).toEqual({ exitCode: 0, message: "updated githunk 0.2.0 -> 0.3.0" })
    expect(env.calls.replace).toEqual([
      "/tmp/githunk-update-test/githunk-linux-x64/githunk -> /home/user/.local/bin/githunk",
    ])
  })

  test("honors an explicit version, including downgrades", async () => {
    const env = stubEnv()
    const result = await runUpdate({ version: "0.1.0", check: false }, env)
    expect(result.exitCode).toBe(0)
    expect(env.calls.replace.length).toBe(1)
  })

  test("refuses a checksum mismatch without replacing the binary", async () => {
    const env = stubEnv({
      fetchAsset: () => Promise.resolve({ tarball: new TextEncoder().encode("tampered"), checksums: "0".repeat(64) + "  githunk-linux-x64.tar.gz\n" }),
    })
    const result = await runUpdate({ check: false }, env)
    expect(result.exitCode).toBe(1)
    expect(result.message).toMatch(/checksum/i)
    expect(env.calls.replace).toEqual([])
  })

  test("refuses platforms without a prebuilt binary", async () => {
    const env = stubEnv({ platform: "freebsd" })
    const result = await runUpdate({ check: false }, env)
    expect(result.exitCode).toBe(1)
    expect(result.message).toContain("npm install -g @xuhaojun/githunk")
    expect(env.calls.fetchTag).toBe(0)
  })
})
