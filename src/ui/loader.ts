/**
 * lazygit's spinner: `Loader(now, config)` picks a frame from the wall clock
 * (pkg/gui/presentation/loader.go:10-14), so every place that draws it during one repaint draws
 * the same frame without anyone owning an animation counter.
 *
 *     index := milliseconds / int64(config.Rate) % int64(len(config.Frames))
 *
 * Frames and rate are `gui.spinner`'s defaults — pkg/config/user_config.go:929-932.
 */

export const SPINNER_FRAMES: readonly string[] = ["●∙∙", "∙●∙", "∙∙●", "∙●∙"]

export const SPINNER_RATE_MS = 180

export function loaderFrame(nowMs: number): string {
  const index = Math.floor(nowMs / SPINNER_RATE_MS) % SPINNER_FRAMES.length
  return SPINNER_FRAMES[index < 0 ? index + SPINNER_FRAMES.length : index]!
}
