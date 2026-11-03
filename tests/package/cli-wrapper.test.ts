import { afterEach, describe, expect, test } from "bun:test"
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))))
const wrapper = join(root, "bin", "githunk.js")

async function readUntil(stream: ReadableStream<Uint8Array>, marker: string): Promise<string> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let text = ""
  while (!text.includes(marker)) {
    const { value, done } = await reader.read()
    if (done) break
    text += decoder.decode(value, { stream: true })
  }
  reader.releaseLock()
  return text
}

describe.skipIf(process.platform === "win32")("bin/githunk.js", () => {
  const temporaryDirectories: string[] = []

  afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
  })

  test("reports the forwarded signal when the child shuts down cleanly", async () => {
    const directory = await mkdtemp(join(tmpdir(), "githunk-wrapper-signal-"))
    temporaryDirectories.push(directory)
    const child = join(directory, "child.sh")
    await writeFile(child, "#!/bin/sh\necho ready\ntrap 'exit 0' TERM\nwhile :; do sleep 0.05; done\n")
    await chmod(child, 0o755)

    const proc = Bun.spawn(["node", wrapper], {
      cwd: directory,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, GITHUNK_BIN_PATH: child }
    })
    expect(await readUntil(proc.stdout, "ready")).toContain("ready")
    proc.kill("SIGTERM")

    expect(await proc.exited).toBe(143)
  })
})
