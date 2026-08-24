import { TextRenderable, type CliRenderer } from "@opentui/core"
import type { AppModel } from "../app/model"

const HINTS_COLOR = "#8a8a8a"
const STATUS_COLOR = "#c8c8c8"

export type HintsBarHandle = {
  readonly hints: TextRenderable
  readonly status: TextRenderable
  update(hintsText: string, statusText: string): void
}

export function createHintsBar(renderer: CliRenderer): HintsBarHandle {
  const hints = new TextRenderable(renderer, {
    id: "hints-text",
    content: "",
    selectable: false,
    wrapMode: "none",
    position: "absolute",
    fg: HINTS_COLOR,
  })
  const status = new TextRenderable(renderer, {
    id: "review-status-text",
    content: "",
    selectable: false,
    wrapMode: "none",
    position: "absolute",
    fg: STATUS_COLOR,
  })
  return {
    hints,
    status,
    update(hintsText: string, statusText: string) {
      hints.content = hintsText
      status.content = statusText
    },
  }
}

/**
 * The right-aligned segment: what is being reviewed, and how far the review has got.
 * While a banner is set it replaces the routine text — lazygit's information window
 * gives transient messages precedence over its routine content, and the banner is
 * exactly such a message (it must stay observable even when the status pane's own
 * rows are folded away).
 */
export function reviewStatusText(model: AppModel): string {
  if (model.banner !== undefined && model.banner.length > 0) return `! ${model.banner}`
  const summary = model.reviewSummary
  const files = summary?.files ?? 0
  if (files === 0) return model.title
  const progress = `${summary?.reviewed ?? 0}/${files} ●`
  const invalidated = (summary?.invalidated ?? 0) > 0 ? `  ${summary?.invalidated}!` : ""
  return `${model.title}  ${progress}${invalidated}`
}
