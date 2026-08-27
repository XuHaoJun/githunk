/**
 * A long-running git operation attributed to one list item, so the list can say what is happening
 * to that item rather than only what is happening to the app.
 *
 * lazygit's `types.ItemOperation` (pkg/gui/types/context.go) with the same members, and the labels
 * `ItemOperationToString` maps them to (pkg/gui/presentation/item_operations.go:8-27, strings from
 * pkg/i18n/english.go).
 */
export type ItemOperation =
  | "pushing"
  | "pulling"
  | "fast-forwarding"
  | "deleting"
  | "fetching"
  | "checking-out"

const LABELS: Readonly<Record<ItemOperation, string>> = {
  pushing: "Pushing",
  pulling: "Pulling",
  "fast-forwarding": "Fast-forwarding",
  deleting: "Deleting",
  fetching: "Fetching",
  "checking-out": "Checking out",
}

export function itemOperationLabel(operation: ItemOperation): string {
  return LABELS[operation]
}
