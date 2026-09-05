import type { InputRenderable, KeyEvent, MouseEvent, ScrollBoxRenderable } from "@opentui/core"
import { useKeyboard } from "@opentui/react"
import { useLayoutEffect, useMemo, useRef, useState } from "react"
import type { ReviewBaseSelection } from "../controller"

export type ReviewBasePickerProps = Readonly<{
  selection: ReviewBaseSelection
  width: number
  height: number
  active: boolean
  warning?: string
  onChoose: (ref: string) => void
  onCancel: () => void
  onRetry: () => void
}>

function consume(event: KeyEvent | MouseEvent): void {
  event.preventDefault()
  event.stopPropagation()
}

export function ReviewBasePicker({ selection, width, height, active, warning, onChoose, onCancel, onRetry }: ReviewBasePickerProps) {
  const [query, setQuery] = useState("")
  const [selectedIndex, setSelectedIndex] = useState(0)
  const inputRef = useRef<InputRenderable | null>(null)
  const scrollRef = useRef<ScrollBoxRenderable | null>(null)
  const busy = selection.loading || selection.selecting
  const candidates = useMemo(() => {
    const filter = query.trim().toLowerCase()
    return filter ? selection.candidates.filter((candidate) => candidate.label.toLowerCase().includes(filter) || candidate.ref.toLowerCase().includes(filter)) : selection.candidates
  }, [query, selection.candidates])
  const index = Math.min(selectedIndex, Math.max(0, candidates.length - 1))
  const selected = candidates[index]
  const dialogWidth = Math.max(1, Math.min(90, width - (width > 20 ? 4 : 0)))
  const dialogHeight = Math.max(1, Math.min(20, height - (height > 10 ? 2 : 0)))
  const border = dialogWidth >= 4 && dialogHeight >= 5
  const showDetail = dialogHeight >= 9
  const contentWidth = Math.max(1, dialogWidth - (border ? 2 : 0))
  const warningHeight = warning && dialogHeight >= 9 ? 1 : 0
  const listHeight = Math.max(1, dialogHeight - (border ? 2 : 0) - 3 - (showDetail ? 1 : 0) - warningHeight)

  const reveal = (next: number) => {
    const scroll = scrollRef.current
    if (!scroll) return
    // lazygit pkg/gui/controllers/list_controller.go:118-144 keeps the selected
    // row visible, including boundary navigation after a mouse scroll.
    const viewportHeight = Math.max(1, Math.floor(scroll.viewport.height || listHeight))
    if (next < scroll.scrollTop) scroll.scrollTop = next
    else if (next >= scroll.scrollTop + viewportHeight) scroll.scrollTop = next - viewportHeight + 1
  }
  useLayoutEffect(() => { reveal(index) }, [index, candidates, listHeight])
  useLayoutEffect(() => {
    inputRef.current?.blur()
  }, [active, busy])

  const move = (direction: "up" | "down"): void => {
    if (busy) return
    const next = Math.max(0, Math.min(candidates.length - 1, index + (direction === "down" ? 1 : -1)))
    setSelectedIndex(next)
    reveal(next)
  }
  const submit = (): void => {
    if (busy) return
    if (selected) onChoose(selected.ref)
    else if (selection.error) onRetry()
  }
  const handlePickerKey = (event: KeyEvent): boolean => {
    const name = event.name.toLowerCase()
    if (busy) {
      consume(event)
      return true
    }
    if (name === "escape") {
      consume(event)
      onCancel()
      return true
    }
    if (name === "up" || name === "down") {
      move(name)
      consume(event)
      return true
    }
    if (name === "return" || name === "enter") {
      consume(event)
      submit()
      return true
    }
    if (event.ctrl && name === "r") {
      consume(event)
      onRetry()
      return true
    }
    if (name === "tab") {
      consume(event)
      return true
    }
    if (name === "backspace") {
      consume(event)
      setQuery((previous) => previous.length > 0 ? previous.slice(0, -1) : previous)
      setSelectedIndex(0)
      if (scrollRef.current) scrollRef.current.scrollTop = 0
      return true
    }
    if (!event.ctrl && !event.meta) {
      const char = name === "space" ? " " : name
      if ([...char].length === 1) {
        const code = char.codePointAt(0) ?? 0
        if (code >= 0x20 && code !== 0x7f) {
          consume(event)
          setQuery((previous) => `${previous}${char}`)
          setSelectedIndex(0)
          if (scrollRef.current) scrollRef.current.scrollTop = 0
          return true
        }
      }
    }
    return false
  }
  useKeyboard((event) => {
    if (!active) return
    handlePickerKey(event)
  })

  const status = selection.loading ? "Loading branches…" : selection.selecting ? "Loading review…" : selection.error
    ? `Error: ${selection.error}` : selection.candidates.length === 0 ? "No branches available. Ctrl-R retry."
      : candidates.length === 0 ? "No matching branches." : `${candidates.length} branches · recommendations first`

  return (
    <box id="review-base-backdrop" onMouse={consume} style={{ position: "absolute", left: 0, top: 0, width, height, zIndex: 100, backgroundColor: "#151515" }}>
      <box id="review-base-picker" style={{ position: "absolute", left: Math.floor((width - dialogWidth) / 2), top: Math.floor((height - dialogHeight) / 2), width: dialogWidth, height: dialogHeight, border, borderColor: "#b9ca4a", flexDirection: "column", backgroundColor: "#202020", overflow: "hidden" }}>
        <text content="Choose base branch" wrapMode="none" truncate={true} />
        <input id="review-base-filter" ref={inputRef} width={contentWidth} value={query} placeholder="Filter branches…" focused={false} onInput={(value) => {
          if (busy) return
          setQuery(value)
          setSelectedIndex(0)
          if (scrollRef.current) scrollRef.current.scrollTop = 0
        }} onKeyDown={(event) => {
          if (handlePickerKey(event)) return
        }} onSubmit={() => {
          submit()
        }} />
        <scrollbox id="review-base-list" ref={scrollRef} width="100%" height={listHeight} flexShrink={0} scrollY={true} viewportCulling={true} verticalScrollbarOptions={{ visible: false }}>
          <box style={{ width: "100%", flexDirection: "column" }}>
            {candidates.length === 0 ? <text content={status} wrapMode="none" truncate={true} /> : null}
            {candidates.map((candidate, candidateIndex) => (
              <box key={candidate.ref} id={`review-base-row:${candidate.ref}`} style={{ width: "100%", height: 1, flexShrink: 0, backgroundColor: index === candidateIndex ? "#365f8a" : "#202020" }} onMouseUp={(event) => {
                consume(event)
                if (busy) return
                setSelectedIndex(candidateIndex)
                onChoose(candidate.ref)
              }}>
                <text content={`${index === candidateIndex ? ">" : " "} ${candidate.label}${candidate.reason ? ` — ${candidate.reason}` : ""}`} selectable={false} wrapMode="none" truncate={true} />
              </box>
            ))}
          </box>
        </scrollbox>
        {showDetail ? <text id="review-base-status" content={status} fg={selection.error ? "#f0c674" : "#b4b4b4"} wrapMode="none" truncate={true} /> : null}
        {warningHeight > 0 && warning ? <text id="review-base-warning" content={warning} fg="#f0c674" wrapMode="none" truncate={true} /> : null}
        <box style={{ width: "100%", height: 1, flexShrink: 0, flexDirection: "row" }}>
          {selection.error || selection.candidates.length === 0 ? <box id="review-base-retry" onMouseUp={(event) => {
            consume(event)
            if (!busy) onRetry()
          }}><text content="[Ctrl-R retry] " /></box> : null}
          <text content={selection.error !== undefined || busy ? status : "↑↓ choose · Enter select · Esc cancel"} wrapMode="none" truncate={true} />
        </box>
      </box>
    </box>
  )
}
