import { describe, expect, test } from "bun:test"
import type { AppModel } from "../../src/app/model"
import type { SubmoduleConfig } from "../../src/domain/submodule"
import {
  NO_SUBMODULES,
  selectedSubmoduleFrom,
  submodulePreviewText,
  submoduleRowId,
  submoduleRows,
} from "../../src/ui/panes/submodules-pane"

function model(submodules: readonly SubmoduleConfig[]): AppModel {
  return { submodules } as unknown as AppModel
}

const top: SubmoduleConfig = { name: "libs/mid", path: "libs/mid", url: "/tmp/mid" }
const nested: SubmoduleConfig = { name: "vendor/inner", path: "vendor/inner", url: "/tmp/inner", parentModule: top }

/**
 * pkg/gui/presentation/submodules.go `getSubmoduleDisplayStrings`: the section name, prefixed with
 * two spaces per parent module plus `"- "` when nested.
 */
describe("submodule rows", () => {
  test("a top-level submodule renders its bare name", () => {
    const rows = submoduleRows(model([top]))
    expect(rows.map((row) => row.id)).toEqual([submoduleRowId(top)])
    expect(rows[0]!.columns[0]!.text).toBe("libs/mid")
  })

  test("a nested submodule is indented two spaces per parent and prefixed with a dash", () => {
    const rows = submoduleRows(model([top, nested]))
    expect(rows.map((row) => row.columns[0]!.text)).toEqual(["libs/mid", "  - vendor/inner"])
    expect(rows[1]!.id).toBe("submodule:libs/mid/vendor/inner")
  })

  test("filtering matches on the rendered name", () => {
    expect(submoduleRows(model([top, nested]), "inner").map((row) => row.id)).toEqual([submoduleRowId(nested)])
  })

  test("no submodules at all yields no rows", () => {
    expect(submoduleRows({} as unknown as AppModel)).toEqual([])
  })

  test("selectedSubmoduleFrom resolves a row id back to its submodule", () => {
    const m = model([top, nested])
    expect(selectedSubmoduleFrom(m, submoduleRowId(nested))).toEqual(nested)
    expect(selectedSubmoduleFrom(m, "submodule:nope")).toBeUndefined()
    expect(selectedSubmoduleFrom(m, undefined)).toBeUndefined()
  })
})

/** pkg/gui/controllers/submodules_controller.go:113-121. */
describe("submodule preview", () => {
  test("emits lazygit's Name/Path/Url prefix block, blank line included", () => {
    expect(submodulePreviewText(nested)).toBe(
      "Name: libs/mid/vendor/inner\nPath: libs/mid/vendor/inner\nUrl:  /tmp/inner\n\n",
    )
  })

  test("a submodule section with no url leaves the Url cell empty", () => {
    expect(submodulePreviewText({ name: "a", path: "a" })).toBe("Name: a\nPath: a\nUrl:  \n\n")
  })

  test("no selection renders lazygit's literal No submodules string", () => {
    expect(NO_SUBMODULES).toBe("No submodules")
  })
})
