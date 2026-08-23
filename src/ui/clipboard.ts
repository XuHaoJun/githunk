export type ClipboardPort = {
  isOsc52Supported(): boolean
  copyToClipboardOSC52(text: string): boolean
}

export type CopyResult = {
  readonly status: "emitted" | "blocked" | "empty"
  readonly bytes: number
}

export function formatCopyResult(result: CopyResult): string {
  if (result.status === "empty") return "No text selected"
  if (result.status === "blocked") return "OSC52 blocked/unsupported"
  return `OSC52 emitted ${result.bytes} bytes — verify local clipboard`
}

export class ClipboardService {
  constructor(private readonly port: ClipboardPort) {}

  copy(text: string): CopyResult {
    const bytes = Buffer.byteLength(text, "utf8")
    if (text.length === 0) return { status: "empty", bytes }
    if (!this.port.isOsc52Supported() || !this.port.copyToClipboardOSC52(text)) return { status: "blocked", bytes }
    return { status: "emitted", bytes }
  }
}

export function copySelection(text: string, clipboard: ClipboardPort): CopyResult {
  return new ClipboardService(clipboard).copy(text)
}
