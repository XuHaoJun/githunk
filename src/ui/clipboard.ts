export type ClipboardPort = {
  isOsc52Supported(): boolean
  copyToClipboardOSC52(text: string): boolean
}

export type CopyResult = {
  readonly status: "emitted" | "blocked" | "empty"
  readonly bytes: number
  readonly message: string
}

export class ClipboardService {
  constructor(private readonly port: ClipboardPort) {}

  copy(text: string): CopyResult {
    const bytes = Buffer.byteLength(text, "utf8")
    if (text.length === 0) return { status: "empty", bytes, message: "No text selected" }
    if (!this.port.isOsc52Supported() || !this.port.copyToClipboardOSC52(text)) {
      return { status: "blocked", bytes, message: "OSC52 blocked/unsupported" }
    }
    return { status: "emitted", bytes, message: `OSC52 emitted ${bytes} bytes — verify local clipboard` }
  }
}

export function copySelection(text: string, clipboard: ClipboardPort): CopyResult {
  return new ClipboardService(clipboard).copy(text)
}
