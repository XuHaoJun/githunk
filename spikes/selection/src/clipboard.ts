export type ClipboardPort = {
  isOsc52Supported(): boolean
  copyToClipboardOSC52(text: string): boolean
}

export type CopyResult = {
  status: "emitted" | "blocked" | "empty"
  bytes: number
}

export function copySelection(
  text: string,
  clipboard: ClipboardPort,
): CopyResult {
  const bytes = Buffer.byteLength(text, "utf8")

  if (text.length === 0) {
    return { status: "empty", bytes }
  }

  if (!clipboard.isOsc52Supported()) {
    return { status: "blocked", bytes }
  }

  return {
    status: clipboard.copyToClipboardOSC52(text) ? "emitted" : "blocked",
    bytes,
  }
}
