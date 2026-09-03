/**
 * Compatibility entry point for display-cell width helpers.
 *
 * The implementation belongs to the domain diff package so pure diff layout code does not depend
 * on UI modules. Existing UI callers keep this import path during the transition.
 */
export { cellWidth, isWide } from "../domain/diff/cell-width"
