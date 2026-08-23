import { describe, expect, test } from "bun:test"
import { copySelection } from "../src/clipboard"

describe("OSC52 copy policy", () => {
  test("does not emit empty selections", () => {
    const port = {
      isOsc52Supported: () => true,
      copyToClipboardOSC52: () => true,
    }

    expect(copySelection("", port)).toEqual({ status: "empty", bytes: 0 })
  })

  test("reports capability-policy block", () => {
    const port = {
      isOsc52Supported: () => false,
      copyToClipboardOSC52: () => true,
    }

    expect(copySelection("abc", port)).toEqual({ status: "blocked", bytes: 3 })
  })

  test("reports emission but does not claim terminal acceptance", () => {
    const port = {
      isOsc52Supported: () => true,
      copyToClipboardOSC52: (text: string) => text === "abc",
    }

    expect(copySelection("abc", port)).toEqual({ status: "emitted", bytes: 3 })
  })

  test("counts selected text as UTF-8 bytes", () => {
    const port = {
      isOsc52Supported: () => true,
      copyToClipboardOSC52: () => true,
    }

    expect(copySelection("a€🙂", port)).toEqual({ status: "emitted", bytes: 8 })
  })
})
