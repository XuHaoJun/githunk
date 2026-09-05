import { createHash } from "node:crypto"
import { basename, join } from "node:path"

export type UpdateRequest = {
  readonly version?: string
  readonly check: boolean
}

export type UpdateEnvironment = {
  readonly executablePath: string
  readonly platform: NodeJS.Platform
  readonly arch: string
  readonly installedVersion: () => string
  readonly fetchReleaseTag: () => Promise<string>
  readonly fetchAsset: (tag: string, asset: string) => Promise<{
    readonly tarball: Uint8Array
    readonly checksums: string
  }>
  readonly withTempDir: <T>(run: (dir: string) => Promise<T>) => Promise<T>
  readonly writeFile: (path: string, data: Uint8Array) => Promise<void>
  readonly extractTarball: (archivePath: string, destDir: string) => Promise<void>
  readonly stagedBinary: (dir: string) => string
  readonly writeBinary: (stagedPath: string, destPath: string) => Promise<void>
}

export type UpdateResult = {
  readonly exitCode: number
  readonly message: string
}

/** Release asset name for one platform, or null when no prebuilt binary ships there. */
export function assetNameFor(platform: NodeJS.Platform, arch: string): string | null {
  const osToken = platform === "linux" ? "linux" : platform === "darwin" ? "darwin" : platform === "win32" ? "windows" : null
  const archToken = arch === "x64" ? "x64" : arch === "arm64" ? "arm64" : null
  if (osToken === null || archToken === null) return null
  if (osToken === "windows" && archToken !== "x64") return null
  return `githunk-${osToken}-${archToken}.tar.gz`
}

function normalizeVersion(version: string): string {
  return version.trim().replace(/^v/, "")
}

/** Compare two versions as numeric triples. Returns negative/zero/positive. */
export function compareVersions(left: string, right: string): number {
  const parts = (version: string): [number, number, number] => {
    const [major = "0", minor = "0", patch = "0"] = normalizeVersion(version).split(".")
    return [Number(major) || 0, Number(minor) || 0, Number(patch) || 0]
  }
  const [aMajor, aMinor, aPatch] = parts(left)
  const [bMajor, bMinor, bPatch] = parts(right)
  return aMajor - bMajor || aMinor - bMinor || aPatch - bPatch
}

/** True when the running process is the standalone prebuilt binary (not node/bun). */
export function isSelfManagedBinary(executablePath: string): boolean {
  const base = basename(executablePath)
  return base === "githunk" || base === "githunk.exe"
}

function verifyChecksum(tarball: Uint8Array, checksums: string, asset: string): void {
  const actual = createHash("sha256").update(tarball).digest("hex")
  const line = checksums
    .split("\n")
    .map((entry) => entry.trim().split(/\s+/))
    .find((fields) => fields[fields.length - 1] === asset)
  const expected = line?.[0]
  if (expected === undefined || expected === "" || expected.toLowerCase() !== actual) {
    throw new Error(`checksum mismatch for ${asset}`)
  }
}

async function applyUpdate(target: string, asset: string, env: UpdateEnvironment): Promise<void> {
  await env.withTempDir(async (dir) => {
    const { tarball, checksums } = await env.fetchAsset(`v${target}`, asset)
    verifyChecksum(tarball, checksums, asset)
    const archivePath = join(dir, asset)
    await env.writeFile(archivePath, tarball)
    await env.extractTarball(archivePath, dir)
    await env.writeBinary(env.stagedBinary(dir), env.executablePath)
  })
}

export async function runUpdate(request: UpdateRequest, env: UpdateEnvironment): Promise<UpdateResult> {
  try {
    if (!isSelfManagedBinary(env.executablePath)) {
      return {
        exitCode: 1,
        message: "githunk was installed via npm — update it with `npm update --global @xuhaojun/githunk`",
      }
    }
    const asset = assetNameFor(env.platform, env.arch)
    if (asset === null) {
      return {
        exitCode: 1,
        message: `no prebuilt githunk binary ships for ${env.platform}-${env.arch} — install with \`npm install -g @xuhaojun/githunk\``,
      }
    }
    const current = normalizeVersion(env.installedVersion())
    const target = normalizeVersion(request.version ?? normalizeVersion(await env.fetchReleaseTag()))
    if (compareVersions(target, current) === 0) {
      return { exitCode: 0, message: `githunk ${current} is already up to date` }
    }
    if (request.check) {
      return { exitCode: 0, message: `update available: ${current} -> ${target}` }
    }
    await applyUpdate(target, asset, env)
    return { exitCode: 0, message: `updated githunk ${current} -> ${target}` }
  } catch (error) {
    return { exitCode: 1, message: error instanceof Error ? error.message : String(error) }
  }
}
