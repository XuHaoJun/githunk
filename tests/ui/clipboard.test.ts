import { describe, expect, test } from "bun:test"
import { ClipboardService, formatCopyResult, type ClipboardPort } from "../../src/ui/clipboard"
describe("truthful OSC52 clipboard status", () => {
  test("reports empty without emitting", () => {
    let emitted = false
    const port: ClipboardPort = { isOsc52Supported: () => true, copyToClipboardOSC52: () => { emitted = true; return true } }
    const result = new ClipboardService(port).copy("")
    expect(result).toEqual({ status: "empty", bytes: 0 })
    expect(formatCopyResult(result)).toBe("No text selected")
    expect(emitted).toBe(false)
  })

  test("reports blocked/unsupported without claiming copied", () => {
    const port: ClipboardPort = { isOsc52Supported: () => false, copyToClipboardOSC52: () => true }
    const result = new ClipboardService(port).copy("abc")
    expect(result).toEqual({ status: "blocked", bytes: 3 })
    expect(formatCopyResult(result)).toBe("OSC52 blocked/unsupported")
  })

  test("reports emitted bytes and asks user to verify", () => {
    const port: ClipboardPort = { isOsc52Supported: () => true, copyToClipboardOSC52: (text) => text === "a€🙂" }
    const result = new ClipboardService(port).copy("a€🙂")
    expect(result).toEqual({ status: "emitted", bytes: 8 })
    expect(formatCopyResult(result)).toBe("OSC52 emitted 8 bytes — verify local clipboard")
  })

  test("does not confuse a rejected write with acknowledgement", () => {
    const port: ClipboardPort = { isOsc52Supported: () => true, copyToClipboardOSC52: () => false }
    expect(new ClipboardService(port).copy("abc").status).toBe("blocked")
  })
})
