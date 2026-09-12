import { describe, expect, test } from "bun:test"
import { createTestRenderer } from "@opentui/core/testing"
import { act } from "react"
import type { CliRenderer } from "@opentui/core"
import { AppScreenController } from "../../../src/app/screen-controller"
import type { AppController } from "../../../src/app/controller"
import { createReactReviewView, disposeLoadedReactReviewRenderer } from "../../../src/ui/review-workspace/react-review-host-lazy"
import type { ReviewWorkspaceController } from "../../../src/ui/review-workspace/controller"
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function emptyController(): ReviewWorkspaceController {
  return {
    state: undefined,
    error: undefined,
    subscribe: () => () => undefined,
    getExpandedSourceByGap: () => new Map()
  } as unknown as ReviewWorkspaceController
}

describe("lazy React review host", () => {
  test("mounts the same workspace tree the direct host mounts, and disposes afterwards", async () => {
    const setup = await createTestRenderer({ width: 100, height: 30 })
    const renderer = setup.renderer as unknown as CliRenderer

    await act(async () => {
      await createReactReviewView(renderer, emptyController(), () => undefined)
      await setup.renderOnce()
      await Bun.sleep(0)
      await setup.renderOnce()
    })

    expect(setup.renderer.root.findDescendantById("react-review-workspace")).toBeDefined()

    await act(async () => {
      disposeLoadedReactReviewRenderer(renderer)
      await setup.renderOnce()
    })

    expect(setup.renderer.root.findDescendantById("react-review-workspace")).toBeUndefined()
  })

  test("a screen controller that never opened Branch Review disposes nothing at shutdown", async () => {
    // Shutdown must not reach into the Branch Review chunk on behalf of a session that never
    // opened the screen. `react-review-host-lazy` caches the module process-wide, so the guard
    // cannot live there — a sibling test that opened Branch Review would have populated it. The
    // guard belongs to the controller, which has a lifecycle.
    //
    // The first renderer only exists to make sure the module *is* cached, so that a regression
    // (dropping the guard) actually has something to dispose and this test fails for the right
    // reason rather than passing on an empty cache.
    const primer = await createTestRenderer({ width: 40, height: 10 })
    const primerRenderer = primer.renderer as unknown as CliRenderer
    await act(async () => {
      await createReactReviewView(primerRenderer, emptyController(), () => undefined)
      await primer.renderOnce()
    })
    // Leave no mounted React root behind: the cache this primes is process-wide, but the root is
    // not, and a stray one perturbs sibling tests that share the renderer harness.
    await act(async () => {
      disposeLoadedReactReviewRenderer(primerRenderer)
      await primer.renderOnce()
    })

    const setup = await createTestRenderer({ width: 100, height: 30 })
    const renderer = setup.renderer as unknown as CliRenderer
    const { ReactReviewHost } = await import("../../../src/ui/review-workspace/react-review-host")

    await act(async () => {
      new ReactReviewHost(renderer, emptyController(), () => undefined)
      await setup.renderOnce()
      await Bun.sleep(0)
      await setup.renderOnce()
    })
    expect(setup.renderer.root.findDescendantById("react-review-workspace")).toBeDefined()

    const screens = new AppScreenController({
      repositoryController: { refresh: async () => undefined } as unknown as AppController,
      renderer,
      createReviewController: () => emptyController(),
      createReviewView: () => {
        throw new Error("Branch Review must not be opened in this test")
      }
    })

    await act(async () => {
      await screens.destroy()
      await setup.renderOnce()
    })

    expect(setup.renderer.root.findDescendantById("react-review-workspace")).toBeDefined()
  })
})
