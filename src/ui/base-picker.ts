import type { BaseInference } from "../git/base-inference"

export type BasePicker = Extract<BaseInference, { readonly kind: "choose" }>

export function basePickerTitle(picker: BasePicker): string {
  return `Choose review base (${picker.reason})`
}

export function basePickerOptions(picker: BasePicker): readonly string[] {
  return picker.candidates
}

export function renderBasePicker(picker: BasePicker): string {
  const options = picker.candidates.length === 0
    ? "No local or remote branch refs resolve to commits."
    : picker.candidates.map((candidate, index) => `${index + 1}. ${candidate}`).join("\n")
  return `${basePickerTitle(picker)}\n${options}`
}
