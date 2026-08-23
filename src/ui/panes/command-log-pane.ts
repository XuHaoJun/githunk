import { ScrollBoxRenderable, TextRenderable, type CliRenderer } from "@opentui/core"
import type { CommandRecord } from "../../domain/command"
import type { FocusId } from "../focus"

export type CommandLogPaneHandle = {
  readonly id: FocusId
  readonly box: ScrollBoxRenderable
  readonly text: TextRenderable
  update(records: readonly CommandRecord[]): void
  setFocused(focused: boolean): void
}

function escapeArg(value: string): string {
  return JSON.stringify(value)
}

function formatRecord(record: CommandRecord): string {
  const argv = record.args.map(escapeArg).join(" ")
  const output: string[] = [
    `${record.startedAt}  ${argv}`,
    `exit ${record.exitCode}  ${record.durationMs}ms`,
  ]
  if (record.stdout) output.push(`stdout:\n${record.stdout.trimEnd()}`)
  if (record.stderr) output.push(`stderr:\n${record.stderr.trimEnd()}`)
  return output.join("\n")
}

export function createCommandLogPane(renderer: CliRenderer, records: readonly CommandRecord[]): CommandLogPaneHandle {
  const box = new ScrollBoxRenderable(renderer, {
    id: "command-log-pane",
    border: true,
    borderColor: "#555555",
    focusedBorderColor: "#ffffff",
    title: "Command Log",
    position: "absolute",
    width: "100%",
    height: "100%",
    overflow: "hidden",
    scrollY: true,
    scrollX: false,
    stickyScroll: true,
    stickyStart: "bottom",
    focusable: false,
  })
  const text = new TextRenderable(renderer, {
    id: "command-log-text",
    content: "No commands recorded",
    selectable: false,
    wrapMode: "none",
    width: "100%",
  })
  box.add(text)
  const pane: CommandLogPaneHandle = {
    id: "command-log",
    box,
    text,
    update(nextRecords: readonly CommandRecord[]) {
      text.content = nextRecords.length === 0
        ? "No commands recorded"
        : nextRecords.map(formatRecord).join("\n\n")
      box.scrollTo({ x: 0, y: Number.MAX_SAFE_INTEGER })
    },
    setFocused(focused: boolean) {
      box.borderColor = focused ? "#ffffff" : "#555555"
      box.titleColor = focused ? "#ffffff" : "#aaaaaa"
      box.requestRender()
    },
  }
  pane.update(records)
  return pane
}
