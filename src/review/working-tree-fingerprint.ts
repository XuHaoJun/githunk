import { createHash } from "node:crypto"
import type { ReviewTarget } from "../domain/review-target"

export type MutableReviewTarget =
  | Extract<ReviewTarget, { kind: "working-tree" }>
  | Extract<ReviewTarget, { kind: "stash" }>

export type FilePatchInput = {
  readonly currentPath?: string | undefined
  readonly path?: string | undefined
  readonly previousPath?: string | undefined
  readonly rawPatch?: string | undefined
  readonly patch?: string | undefined
} | string

function utf8(value: string): Uint8Array {
  return new TextEncoder().encode(value)
}

/** SHA-256 over a tuple encoded as length-prefixed UTF-8 fields. */
export function sha256Tuple(parts: readonly string[]): string {
  const hash = createHash("sha256")
  for (const part of parts) {
    const bytes = utf8(part)
    const length = Buffer.allocUnsafe(4)
    length.writeUInt32BE(bytes.byteLength, 0)
    hash.update(length)
    hash.update(bytes)
  }
  return hash.digest("hex")
}

function targetFingerprintParts(target: MutableReviewTarget): readonly string[] {
  switch (target.kind) {
    case "working-tree":
      return [target.kind, target.scope, "", ""]
    case "stash":
      return [target.kind, "", target.ref, "", ""]
  }
}

export function workingTreeTargetKey(target: MutableReviewTarget): string {
  return sha256Tuple(targetFingerprintParts(target))
}

function filePatchParts(input: FilePatchInput): readonly [string, string, string] {
  if (typeof input === "string") return ["", "", input]
  return [input.currentPath ?? input.path ?? "", input.previousPath ?? "", input.rawPatch ?? input.patch ?? ""]
}

export function fingerprintWorkingTreeFile(target: MutableReviewTarget, filePatch: FilePatchInput): string {
  const [currentPath, previousPath, rawPatch] = filePatchParts(filePatch)
  return sha256Tuple([workingTreeTargetKey(target), currentPath, previousPath, rawPatch])
}
