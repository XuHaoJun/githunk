import { BoxRenderable, TextRenderable, type CliRenderer } from "@opentui/core"
import { attachVerticalScrollbar, syncVerticalScrollbar } from "./common"
import { setPlainPaneText } from "./pane-text"
import type { CommandRecord } from "../../domain/command"
import type { FocusId } from "../focus"

export type CommandLogPaneHandle = {
  readonly id: FocusId
  readonly box: BoxRenderable
  readonly text: TextRenderable
  resize(width: number, height: number): void
  update(records: readonly CommandRecord[]): void
  setFocused(focused: boolean): void
  scrollBy(delta: number): void
  scrollTo(position: number): void
  maxScrollY(): number
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
/** Keep command output inspectable in a non-selectable, scrollable viewport. */
export function tailCommandLogLines(records: readonly CommandRecord[], lineLimit: number): readonly string[] {
  const limit = Math.max(1, Math.floor(lineLimit))
  const selected: string[] = []
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const block = formatRecord(records[index]!).split("\n")
    if (selected.length === 0 && block.length > limit) {
      selected.push(...block.slice(-limit))
      break
    }
    if (selected.length + block.length + (selected.length === 0 ? 0 : 1) > limit) break
    selected.unshift(...block)
    if (index > 0) selected.unshift("")
  }
  return selected.slice(-limit)
}


export function createCommandLogPane(renderer: CliRenderer, records: readonly CommandRecord[]): CommandLogPaneHandle {
  const box = new BoxRenderable(renderer, {
    id: "command-log-pane",
    border: true,
    borderColor: "#555555",
    focusedBorderColor: "#ffffff",
    title: "Command Log",
    position: "absolute",
    width: "100%",
    height: "100%",
    overflow: "hidden",
  })
  const text = new TextRenderable(renderer, {
    id: "command-log-text",
    content: "No commands recorded",
    selectable: false,
    wrapMode: "none",
    width: "100%",
  })
  box.add(text)
  const originalLogMouseEvent = (text as unknown as { onMouseEvent?: (event: import("@opentui/core").MouseEvent) => void }).onMouseEvent?.bind(text)
  ;(text as unknown as { onMouseEvent: (event: import("@opentui/core").MouseEvent) => void }).onMouseEvent = (event: import("@opentui/core").MouseEvent) => {
    if ((event as unknown as { type: string }).type === "scroll") {
      event.preventDefault()
      return
    }
    originalLogMouseEvent?.(event as unknown as never)
  }
  const bar = attachVerticalScrollbar(box, text, "command-log")
  let rendered: { readonly count: number; readonly newest: CommandRecord | undefined } | undefined
  const pane: CommandLogPaneHandle = {
    id: "command-log",
    box,
    text,
    resize(width: number, height: number) {
      text.width = Math.max(1, Math.floor(width) - 2)
      text.height = Math.max(1, Math.floor(height) - 2)
      text.scrollY = text.maxScrollY
      syncVerticalScrollbar(bar, text)
    },
    update(nextRecords: readonly CommandRecord[]) {
      // The log keeps each command's whole stdout, so this text is as large as the biggest patch
      // the app has run — and `CommandLog.records()` hands back the same array it appends to, so
      // identity cannot detect a new record. Comparing the count and the newest record does, and
      // skipping an unchanged log is what keeps it off the cost of every layout pass and refresh.
      if (rendered !== undefined && rendered.count === nextRecords.length && rendered.newest === nextRecords[nextRecords.length - 1]) return
      rendered = { count: nextRecords.length, newest: nextRecords[nextRecords.length - 1] }
      setPlainPaneText(text, nextRecords.length === 0 ? "No commands recorded" : nextRecords.map(formatRecord).join("\n\n"))
      text.scrollY = text.maxScrollY
      syncVerticalScrollbar(bar, text)
    },
    setFocused(focused: boolean) {
      box.borderColor = focused ? "#ffffff" : "#555555"
      box.titleColor = focused ? "#ffffff" : "#aaaaaa"
      box.requestRender()
    },
    scrollBy(delta: number) {
      text.scrollY = Math.max(0, Math.min(text.maxScrollY, text.scrollY + delta))
      syncVerticalScrollbar(bar, text)
      box.requestRender()
    },
    scrollTo(position: number) {
      text.scrollY = Math.max(0, Math.min(text.maxScrollY, position))
      syncVerticalScrollbar(bar, text)
      box.requestRender()
    },
    maxScrollY() {
      return text.maxScrollY
    },
  }
  pane.update(records)
  return pane
}
