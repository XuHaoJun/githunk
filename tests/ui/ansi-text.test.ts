import { describe, expect, test } from "bun:test"
import { TextRenderable } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import { parseAnsi } from "../../src/ui/ansi"
import { installAnsiText, releaseAnsiText } from "../../src/ui/panes/ansi-text"
import { installDiffText } from "../../src/ui/panes/diff-text"
import { parseDiff } from "../../src/domain/diff/parse"
import { renderDiff } from "../../src/domain/diff/render"

const ESC = "\u001b"

/** A `git log --graph --color=always` shaped body with `commits` entries. */
function logText(commits: number): string {
  const rows: string[] = []
  for (let index = 0; index < commits; index++) {
    rows.push(`${ESC}[33m* commit ${String(index).padStart(7, "0")}${ESC}[m`)
    rows.push("| Author: Ada Lovelace <ada@example.com>")
    rows.push("| Date:   2 days ago")
    rows.push("|")
    rows.push(`|     subject line ${index}`)
    rows.push("|")
  }
  return rows.join("\n")
}

async function pane(width = 120, height = 40): Promise<{
  readonly text: TextRenderable
  flush(): Promise<void>
  destroy(): void
}> {
  const setup = await createTestRenderer({ width, height })
  const text = new TextRenderable(setup.renderer, { id: "main-text", content: "", width: width - 2, height: height - 2, selectable: true })
  setup.renderer.root.add(text)
  return { text, flush: () => setup.flush(), destroy: () => setup.renderer.destroy() }
}

describe("installAnsiText", () => {
  test("installs the stripped text, escapes and all, as the pane's content", async () => {
    const host = await pane()
    try {
      const parsed = parseAnsi(logText(3))
      installAnsiText(host.text, { preamble: "", body: parsed.text, spans: parsed.spans })
      await host.flush()
      expect(host.text.plainText).toContain("* commit 0000000")
      expect(host.text.plainText).not.toContain(ESC)
      expect(host.text.plainText.split("\n").length).toBe(18)
    } finally {
      host.destroy()
    }
  })

  test("a preamble is kept ahead of the body and shifts nothing else", async () => {
    const host = await pane()
    try {
      const parsed = parseAnsi(`${ESC}[33mcommit abc${ESC}[m`)
      installAnsiText(host.text, { preamble: "v1.0 annotated\n\n---\n", body: parsed.text, spans: parsed.spans })
      await host.flush()
      expect(host.text.plainText.split("\n")).toEqual(["v1.0 annotated", "", "---", "commit abc"])
    } finally {
      host.destroy()
    }
  })

  test("re-installing the same content leaves the scroll offset alone", async () => {
    const host = await pane()
    try {
      const parsed = parseAnsi(logText(60))
      installAnsiText(host.text, { preamble: "", body: parsed.text, spans: parsed.spans })
      await host.flush()
      host.text.scrollY = 40
      await host.flush()
      installAnsiText(host.text, { preamble: "", body: parsed.text, spans: parsed.spans })
      await host.flush()
      expect(host.text.scrollY).toBe(40)
    } finally {
      host.destroy()
    }
  })

  test("scrolling a long log costs no more per step than scrolling a short one", async () => {
    const perScroll = async (commits: number): Promise<number> => {
      const host = await pane()
      try {
        const parsed = parseAnsi(logText(commits))
        installAnsiText(host.text, { preamble: "", body: parsed.text, spans: parsed.spans })
        await host.flush()
        const steps = 30
        const started = performance.now()
        for (let step = 0; step < steps; step++) {
          host.text.scrollY = step * 2
          await host.flush()
        }
        return (performance.now() - started) / steps
      } finally {
        host.destroy()
      }
    }
    const small = await perScroll(60)
    const large = await perScroll(6000)
    // 100x the rows: a whole-document repaint would show up here as orders of magnitude.
    expect(large).toBeLessThan(Math.max(small * 4, 4))
  })

  test("handing the pane to a diff and back repaints instead of showing stale colours", async () => {
    const host = await pane()
    try {
      const parsed = parseAnsi(logText(3))
      installAnsiText(host.text, { preamble: "", body: parsed.text, spans: parsed.spans })
      await host.flush()
      releaseAnsiText(host.text)
      const rendered = renderDiff(parseDiff([
        "diff --git a/a.txt b/a.txt",
        "index 1111111..2222222 100644",
        "--- a/a.txt",
        "+++ b/a.txt",
        "@@ -1,1 +1,1 @@",
        "-before",
        "+after",
        "",
      ].join("\n")))
      installDiffText(host.text, { preamble: "", body: rendered.displayText, displayLines: rendered.displayLines })
      await host.flush()
      expect(host.text.plainText).toContain("after")

      installAnsiText(host.text, { preamble: "", body: parsed.text, spans: parsed.spans })
      await host.flush()
      expect(host.text.plainText).toContain("* commit 0000000")
    } finally {
      host.destroy()
    }
  })
})
