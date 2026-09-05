import { spawnSync } from "node:child_process"
import { chmodSync, cpSync, mkdtempSync, renameSync, rmSync } from "node:fs"
import { writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parseCliArgs } from "./cli/args"
import { runUpdate, type UpdateEnvironment } from "./cli/update"
import { startApp } from "./main"

const RELEASES_API = "https://api.github.com/repos/XuHaoJun/githunk/releases/latest"
const DOWNLOAD_BASE = "https://github.com/XuHaoJun/githunk/releases/download"

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`request failed: ${url} (${response.status})`)
  return response.text()
}

async function fetchBytes(url: string): Promise<Uint8Array> {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`request failed: ${url} (${response.status})`)
  return new Uint8Array(await response.arrayBuffer())
}

function productionUpdateEnv(): UpdateEnvironment {
  return {
    executablePath: process.execPath,
    platform: process.platform,
    arch: process.arch,
    installedVersion: () => {
      const proc = spawnSync(process.execPath, ["--version"], { encoding: "utf8" })
      if (proc.status !== 0) throw new Error("could not read the installed version")
      return proc.stdout.trim()
    },
    fetchReleaseTag: async () => {
      const payload: unknown = JSON.parse(await fetchText(RELEASES_API))
      const tag =
        typeof payload === "object" && payload !== null && "tag_name" in payload ? payload.tag_name : undefined
      if (typeof tag !== "string" || tag === "") throw new Error("could not read the newest release")
      return tag
    },
    fetchAsset: async (tag: string, asset: string) => ({
      tarball: await fetchBytes(`${DOWNLOAD_BASE}/${tag}/${asset}`),
      checksums: await fetchText(`${DOWNLOAD_BASE}/${tag}/SHA256SUMS`),
    }),
    withTempDir: async (run) => {
      const dir = mkdtempSync(join(tmpdir(), "githunk-update-"))
      try {
        return await run(dir)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    },
    writeFile: (path, data) => writeFile(path, data),
    extractTarball: async (archivePath, destDir) => {
      const proc = spawnSync("tar", ["-xzf", archivePath, "-C", destDir])
      if (proc.status !== 0) throw new Error("could not extract the release archive (need tar on PATH)")
    },
    stagedBinary: (dir) => join(dir, `githunk-${process.platform === "win32" ? "windows" : process.platform}-${process.arch === "arm64" ? "arm64" : "x64"}`, process.platform === "win32" ? "githunk.exe" : "githunk"),
    writeBinary: async (stagedPath, destPath) => {
      cpSync(stagedPath, `${destPath}.new`)
      chmodSync(`${destPath}.new`, 0o755)
      renameSync(`${destPath}.new`, destPath)
    },
  }
}

const result = parseCliArgs(process.argv.slice(2))

if (result.kind === "help" || result.kind === "version") {
  process.stdout.write(result.text.endsWith("\n") ? result.text : `${result.text}\n`)
  process.exitCode = 0
} else if (result.kind === "error") {
  process.stderr.write(result.message.endsWith("\n") ? result.message : `${result.message}\n`)
  process.exitCode = result.exitCode
} else if (result.kind === "update") {
  const outcome = await runUpdate(
    { ...(result.version === undefined ? {} : { version: result.version }), check: result.check },
    productionUpdateEnv(),
  )
  const stream = outcome.exitCode === 0 ? process.stdout : process.stderr
  stream.write(outcome.message.endsWith("\n") ? outcome.message : `${outcome.message}\n`)
  process.exitCode = outcome.exitCode
} else {
  process.exitCode = await startApp(
    result.startDirectory === undefined ? {} : { startDirectory: result.startDirectory },
  )
}
