import { createHash } from "node:crypto"
import type { ReviewGeneration, ReviewIdentity } from "./types"

export function sha256Tuple(parts: readonly string[]): string {
  const hash = createHash("sha256")
  for (const part of parts) {
    const bytes = new TextEncoder().encode(part)
    const length = Buffer.alloc(4)
    length.writeUInt32BE(bytes.byteLength, 0)
    hash.update(length)
    hash.update(bytes)
  }
  return hash.digest("hex")
}

export function createReviewIdentity(input: { headRef?: string; headOid: string; baseRef: string }): ReviewIdentity {
  const headKey = input.headRef ?? `detached:${input.headOid}`
  return {
    id: sha256Tuple(["branch-review-v2", headKey, input.baseRef]),
    headRef: input.headRef ?? null,
    baseRef: input.baseRef,
    detachedHeadOid: input.headRef === undefined ? input.headOid : null,
  }
}

export function createReviewGeneration(input: Omit<ReviewGeneration, "id">): ReviewGeneration {
  return { ...input, id: sha256Tuple([input.mergeBaseOid, input.baseOid, input.headOid]) }
}
