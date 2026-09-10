import { expect, test } from "bun:test"
import { dirname } from "node:path"
import { fileURLToPath } from "node:url"

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))))

test("the published npm package contains the agent-readable handoff skill", async () => {
  const child = Bun.spawn(["npm", "pack", "--dry-run", "--json", "--ignore-scripts"], {
    cwd: root,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    Bun.readableStreamToText(child.stdout),
    Bun.readableStreamToText(child.stderr),
    child.exited,
  ])
  expect(exitCode, stderr).toBe(0)
  const payload = JSON.parse(stdout) as readonly { files: readonly { path: string }[] }[]
  const files = payload[0]?.files.map((entry) => entry.path) ?? []
  expect(files).toContain("skills/githunk-handoff/SKILL.md")
  expect(files).not.toContain("skills/githunk-release/SKILL.md")
})
