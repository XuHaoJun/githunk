import type { CliRenderer } from "@opentui/core"
import type { ReviewScreenView } from "../../app/screen-controller"
import type { ReviewWorkspaceController } from "./controller"

/**
 * Keeps the Branch Review React tree — React, `@opentui/react`, the workspace components and the
 * syntax highlighter behind them — out of the repository screen's startup path.
 *
 * `bun build --compile` maps the embedded module graph as a PT_LOAD segment during execve
 * (oven-sh/bun#26923), so a statically imported module is charged to RSS whether or not it ever
 * runs. `--splitting` (set in `scripts/build-bin.ts`) turns this dynamic import into a chunk that
 * stays uninstantiated until Branch Review is actually opened; without that flag the import would
 * be free of any effect, so the two changes only pay off together.
 *
 * The loaded module is cached so that `disposeLoadedReactReviewRenderer` can reach
 * `ReactReviewHost.disposeRenderer` without pulling the chunk in just to tear it down — a session
 * that never opened Branch Review has nothing to dispose.
 */
type ReactReviewHostModule = typeof import("./react-review-host")

let loadedModule: ReactReviewHostModule | undefined

export async function createReactReviewView(renderer: CliRenderer, controller: ReviewWorkspaceController, onClose: () => void): Promise<ReviewScreenView> {
  const module = loadedModule ?? (await import("./react-review-host"))
  loadedModule = module
  return new module.ReactReviewHost(renderer, controller, onClose)
}

/** Disposes the React renderer only when the Branch Review chunk was actually loaded. */
export function disposeLoadedReactReviewRenderer(renderer: CliRenderer): void {
  loadedModule?.ReactReviewHost.disposeRenderer(renderer)
}
