import { describe, expect, test } from "bun:test"
import { resolveReleaseChannel } from "../../scripts/resolve-release-channel"

describe("resolveReleaseChannel", () => {
  test("publishes stable tags to latest and marks the GitHub release latest", () => {
    expect(
      resolveReleaseChannel({ event: "push", ref: "refs/tags/v0.2.0", requestedTag: "latest", currentLatest: "0.1.3" }),
    ).toEqual({ npmTag: "latest", makeLatest: true })
  })

  test("publishes prerelease tags to beta without marking latest", () => {
    for (const ref of ["refs/tags/v0.2.0-beta.1", "refs/tags/v0.2.0-rc.1", "refs/tags/v0.2.0-alpha.1"]) {
      expect(
        resolveReleaseChannel({ event: "push", ref, requestedTag: "latest", currentLatest: "0.1.3" }),
      ).toEqual({ npmTag: "beta", makeLatest: false })
    }
  })

  test("honors the manual dispatch tag", () => {
    expect(
      resolveReleaseChannel({ event: "workflow_dispatch", ref: "main", requestedTag: "beta", currentLatest: "0.2.0" }),
    ).toEqual({ npmTag: "beta", makeLatest: false })
    expect(
      resolveReleaseChannel({ event: "workflow_dispatch", ref: "main", requestedTag: "latest", currentLatest: "0.2.0" }),
    ).toEqual({ npmTag: "latest", makeLatest: true })
  })
})
