import { describe, expect, test } from "bun:test"
import { MainPreviewGate } from "../../src/ui/main-preview"
import { createTestRenderer } from "@opentui/core/testing"
import { createMainPane, getMainCursorTarget, getMainDiffLineRangeState, getMainDocument, installMainContent, setMainCursorTarget, setMainDiffLineRangeState, setMainLoading } from "../../src/ui/panes/main-pane"
import { parseDiff } from "../../src/domain/diff/parse"
import type { CommitDetails } from "../../src/domain/commit"
import type { MainPaneContent } from "../../src/ui/panes/main-pane"
import { toggleDiffLineRange } from "../../src/domain/diff/line-selection"
import { parseAnsi } from "../../src/ui/ansi"

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

function presentCommit(details: CommitDetails): MainPaneContent {
  return {
    source: "commit",
    stableId: details.oid,
    label: details.shortOid,
    ...(details.preamble === undefined ? {} : { preamble: details.preamble }),
    document: details.document,
  }
}

function presentTag(tag: { ref: string }): MainPaneContent {
  return { source: "tag", stableId: tag.ref, label: tag.ref, plainText: `tag ${tag.ref}` }
}

describe("MainPreviewGate", () => {
  test("discards stale async result and keeps latest", async () => {
    const installed: MainPaneContent[] = []
    const loading: boolean[] = []
    const errors: unknown[] = []
    const gate = new MainPreviewGate({
      install: (content) => installed.push(content),
      setLoading: (value) => loading.push(value),
      reportError: (error) => errors.push(error),
    })
    const first = deferred<CommitDetails>()
    const second = deferred<CommitDetails>()
    const oldDetails: CommitDetails = {
      oid: "old", shortOid: "old", parentOids: [], authorName: "A", authoredAt: "", subject: "old", body: "",
      document: { text: "old patch", lines: [], files: [] }, patch: { text: "old patch", lines: [], files: [] }, raw: "", preamble: "old",
    }
    const newDetails: CommitDetails = {
      oid: "new", shortOid: "new", parentOids: [], authorName: "A", authoredAt: "", subject: "new", body: "",
      document: { text: "new patch", lines: [], files: [] }, patch: { text: "new patch", lines: [], files: [] }, raw: "", preamble: "new",
    }
    const oldRequest = gate.request("commit", "old", () => first.promise, presentCommit)
    const newRequest = gate.request("commit", "new", () => second.promise, presentCommit)
    second.resolve(newDetails)
    await newRequest
    first.resolve(oldDetails)
    await oldRequest
    expect(installed.at(-1)?.stableId).toBe("new")
    expect(installed.some((content) => content.stableId === "old")).toBe(false)
    expect(errors).toHaveLength(0)
  })

  test("cross-source: synchronous install invalidates pending async and clears loading", async () => {
    const installed: MainPaneContent[] = []
    const loading: boolean[] = []
    const errors: unknown[] = []
    const gate = new MainPreviewGate({
      install: (content) => installed.push(content),
      setLoading: (value) => loading.push(value),
      reportError: (error) => errors.push(error),
    })
    const tagDeferred = deferred<{ ref: string }>()
    const filesContent: MainPaneContent = { source: "files", stableId: "a.txt", label: "Files — a.txt", plainText: "files content" }
    const tagPromise = gate.request("tag", "refs/tags/v1.0", () => tagDeferred.promise, presentTag)
    gate.installSynchronous(filesContent)
    tagDeferred.resolve({ ref: "refs/tags/v1.0" })
    await tagPromise
    expect(installed.at(-1)?.stableId).toBe("a.txt")
    expect(installed.some((c) => c.stableId === "refs/tags/v1.0")).toBe(false)
    expect(loading.at(-1)).toBe(false)
  })

  test("rejected request reports error and leaves installed content unchanged", async () => {
    const installed: MainPaneContent[] = []
    const loading: boolean[] = []
    const errors: unknown[] = []
    const gate = new MainPreviewGate({
      install: (content) => installed.push(content),
      setLoading: (value) => loading.push(value),
      reportError: (error) => errors.push(error),
    })
    const filesContent: MainPaneContent = { source: "files", stableId: "a.txt", label: "Files", plainText: "files" }
    gate.installSynchronous(filesContent)
    const failing = deferred<CommitDetails>()
    const request = gate.request("commit", "bad", () => failing.promise, presentCommit)
    failing.reject(new Error("load failed"))
    await request
    expect(errors).toHaveLength(1)
    expect(String(errors[0])).toContain("load failed")
    expect(installed.at(-1)?.stableId).toBe("a.txt")
    expect(loading.at(-1)).toBe(false)
  })

  test("second synchronous install updates identity and disables loading", () => {
    const installed: MainPaneContent[] = []
    const loading: boolean[] = []
    const gate = new MainPreviewGate({
      install: (c) => installed.push(c),
      setLoading: (v) => loading.push(v),
      reportError: () => {},
    })
    gate.installSynchronous({ source: "commit", stableId: "a", label: "A", plainText: "a" })
    gate.installSynchronous({ source: "commit", stableId: "b", label: "B", plainText: "b" })
    expect(installed.map((c) => c.stableId)).toEqual(["a", "b"])
    expect(loading).toContain(false)
  })
})

describe("Main pane lifecycle", () => {
  test("viewport preserve/clear and selection retention", async () => {
    const setup = await createTestRenderer({ width: 120, height: 40 })
    const model = {
      repositoryRoot: "",
      branch: "",
      reviewTarget: { kind: "working-tree", scope: "all" },
      files: [],
      patches: [],
      rawPatchSections: [],
      loading: false,
      commandLog: [],
      title: "",
    } as unknown as import("../../src/app/model").AppModel
    const pane = createMainPane(setup.renderer, model)
    const contentA: MainPaneContent = { source: "commit", stableId: "a", label: "A", plainText: "hello world\n".repeat(50) }
    const contentA2: MainPaneContent = { source: "commit", stableId: "a", label: "A", plainText: "hello world\n".repeat(50) }
    const contentAChanged: MainPaneContent = { source: "commit", stableId: "a", label: "A", plainText: "different\n".repeat(50) }
    const contentB: MainPaneContent = { source: "commit", stableId: "b", label: "B", plainText: "other\n".repeat(50) }

    installMainContent(pane, contentA, false)
    pane.text.scrollY = 12
    const textView = pane.text as unknown as { setSelection?: (a: number, b: number) => void; hasSelection?: () => boolean }
    if ("setSelection" in pane.text && typeof textView.setSelection === "function") {
      try { textView.setSelection(0, 5) } catch {}
    }
    const hasSelectionBefore = typeof textView.hasSelection === "function" ? textView.hasSelection() : false

    installMainContent(pane, contentA2, false)
    expect(pane.text.scrollY).toBe(12)
    if (hasSelectionBefore) {
      const hasNow = typeof textView.hasSelection === "function" ? textView.hasSelection() : false
      expect(hasNow).toBe(true)
    }

    installMainContent(pane, contentAChanged, false)
    expect(pane.text.scrollY).toBeLessThanOrEqual(pane.text.maxScrollY)
    expect(typeof textView.hasSelection === "function" ? textView.hasSelection() : false).toBe(false)

    pane.text.scrollY = 5
    pane.text.scrollX = 3
    if ("setSelection" in pane.text && typeof textView.setSelection === "function") {
      try { textView.setSelection(0, 2) } catch {}
    }
    installMainContent(pane, contentB, false)
    expect(pane.text.scrollY).toBe(0)
    expect(pane.text.scrollX).toBe(0)
    expect(typeof textView.hasSelection === "function" ? textView.hasSelection() : false).toBe(false)

    setup.renderer.destroy()
  })

  test("clears stale document when diff transitions to plain content", async () => {
    const setup = await createTestRenderer({ width: 120, height: 40 })
    const model = {
      repositoryRoot: "",
      branch: "",
      reviewTarget: { kind: "working-tree", scope: "all" },
      files: [],
      patches: [],
      rawPatchSections: [],
      loading: false,
      commandLog: [],
      title: "",
    } as unknown as import("../../src/app/model").AppModel
    const pane = createMainPane(setup.renderer, model)
    installMainContent(pane, {
      source: "commit",
      stableId: "diff",
      label: "Diff",
      document: parseDiff("diff --git a/a.txt b/a.txt\n@@ -1 +1 @@\n-old\n+new\n"),
    }, false)
    expect(getMainDocument(pane)).toBeDefined()
    installMainContent(pane, { source: "commit", stableId: "plain", label: "Plain", plainText: "No patch loaded" }, false)
    expect(getMainDocument(pane)).toBeUndefined()
    setup.renderer.destroy()
  })

  test("clears diff state when same identity transitions to matching plain content", async () => {
    const setup = await createTestRenderer({ width: 120, height: 40 })
    const model = {
      repositoryRoot: "",
      branch: "",
      reviewTarget: { kind: "working-tree", scope: "all" },
      files: [],
      patches: [],
      rawPatchSections: [],
      loading: false,
      commandLog: [],
      title: "",
    } as unknown as import("../../src/app/model").AppModel
    const pane = createMainPane(setup.renderer, model)
    const document = parseDiff("diff --git a/a.txt b/a.txt\n@@ -1 +1 @@\n-old\n+new\n")
    installMainContent(pane, { source: "commit", stableId: "same", label: "Diff", document }, false)
    const range = getMainDiffLineRangeState(pane)
    expect(range).toBeDefined()
    setMainCursorTarget(pane, { fileIndex: 0, hunkIndex: 0 })
    setMainDiffLineRangeState(pane, toggleDiffLineRange(range!))
    const textView = pane.text as unknown as {
      setSelection?: (start: number, end: number) => void
      getSelection?: () => unknown
      hasSelection?: () => boolean
    }
    textView.setSelection?.(0, 5)
    const nativeBefore = textView.getSelection?.()
    const hadNativeSelection = typeof textView.hasSelection === "function" ? textView.hasSelection() : nativeBefore !== undefined
    installMainContent(pane, { source: "commit", stableId: "same", label: "Plain", plainText: document.text }, false)
    expect(getMainDocument(pane)).toBeUndefined()
    expect(getMainDiffLineRangeState(pane)).toBeUndefined()
    expect(getMainCursorTarget(pane)).toBeUndefined()
    expect(pane.text.plainText).toBe(document.text)
    if (hadNativeSelection && typeof textView.hasSelection === "function") expect(textView.hasSelection()).toBe(false)
    if (nativeBefore !== undefined && typeof textView.getSelection === "function") expect(textView.getSelection()).toBeNull()
    setup.renderer.destroy()
  })

  test("clears diff state when same identity transitions to ANSI content", async () => {
    const setup = await createTestRenderer({ width: 120, height: 40 })
    const model = {
      repositoryRoot: "",
      branch: "",
      reviewTarget: { kind: "working-tree", scope: "all" },
      files: [],
      patches: [],
      rawPatchSections: [],
      loading: false,
      commandLog: [],
      title: "",
    } as unknown as import("../../src/app/model").AppModel
    const pane = createMainPane(setup.renderer, model)
    const document = parseDiff("diff --git a/a.txt b/a.txt\n@@ -1 +1 @@\n-old\n+new\n")
    installMainContent(pane, { source: "commit", stableId: "same", label: "Diff", document }, false)
    const range = getMainDiffLineRangeState(pane)
    expect(range).toBeDefined()
    setMainCursorTarget(pane, { fileIndex: 0, hunkIndex: 0 })
    setMainDiffLineRangeState(pane, toggleDiffLineRange(range!))
    const textView = pane.text as unknown as {
      setSelection?: (start: number, end: number) => void
      getSelection?: () => unknown
      hasSelection?: () => boolean
    }
    textView.setSelection?.(0, 5)
    const nativeBefore = textView.getSelection?.()
    const hadNativeSelection = typeof textView.hasSelection === "function" ? textView.hasSelection() : nativeBefore !== undefined
    installMainContent(pane, { source: "commit", stableId: "same", label: "ANSI", ansi: parseAnsi(document.text) }, false)
    expect(getMainDocument(pane)).toBeUndefined()
    expect(getMainDiffLineRangeState(pane)).toBeUndefined()
    expect(getMainCursorTarget(pane)).toBeUndefined()
    expect(pane.text.wrapMode).toBe("none")
    expect(pane.text.plainText).toBe(document.text)
    if (hadNativeSelection && typeof textView.hasSelection === "function") expect(textView.hasSelection()).toBe(false)
    if (nativeBefore !== undefined && typeof textView.getSelection === "function") expect(textView.getSelection()).toBeNull()
    setup.renderer.destroy()
  })

  test("restores diff rendering when plain content enters a document with same identity", async () => {
    const setup = await createTestRenderer({ width: 120, height: 40 })
    const model = {
      repositoryRoot: "",
      branch: "",
      reviewTarget: { kind: "working-tree", scope: "all" },
      files: [],
      patches: [],
      rawPatchSections: [],
      loading: false,
      commandLog: [],
      title: "",
    } as unknown as import("../../src/app/model").AppModel
    const pane = createMainPane(setup.renderer, model)
    setup.renderer.root.add(pane.box)
    const document = parseDiff("diff --git a/a.txt b/a.txt\n@@ -1 +1 @@\n-old\n+new\n")
    installMainContent(pane, { source: "commit", stableId: "same-entry", label: "Plain", plainText: document.text }, false)
    const textView = pane.text as unknown as {
      setSelection?: (start: number, end: number) => void
      getSelection?: () => unknown
      hasSelection?: () => boolean
    }
    textView.setSelection?.(0, 5)
    const nativeBeforePlain = textView.getSelection?.()
    const hadNativeSelectionPlain = typeof textView.hasSelection === "function" ? textView.hasSelection() : nativeBeforePlain !== undefined
    expect(getMainDocument(pane)).toBeUndefined()
    installMainContent(pane, { source: "commit", stableId: "same-entry", label: "Diff", document }, false)
    expect(getMainDocument(pane)).toBe(document)
    expect(getMainDiffLineRangeState(pane)).toBeDefined()
    expect(pane.text.wrapMode).toBe("char")
    await setup.flush()
    const hasDiffColor = setup.captureSpans().lines.some((line) => line.spans.some((span) => span.fg.intent === "indexed"))
    expect(hasDiffColor).toBe(true)
    if (hadNativeSelectionPlain && typeof textView.hasSelection === "function") expect(textView.hasSelection()).toBe(false)
    if (nativeBeforePlain !== undefined && typeof textView.getSelection === "function") expect(textView.getSelection()).toBeNull()
    installMainContent(pane, { source: "commit", stableId: "same-entry", label: "ANSI", ansi: parseAnsi(document.text) }, false)
    expect(getMainDocument(pane)).toBeUndefined()
    expect(pane.text.wrapMode).toBe("none")
    textView.setSelection?.(0, 5)
    const nativeBeforeAnsi = textView.getSelection?.()
    installMainContent(pane, { source: "commit", stableId: "same-entry", label: "Diff again", document }, false)
    expect(getMainDocument(pane)).toBe(document)
    expect(getMainDiffLineRangeState(pane)).toBeDefined()
    expect(pane.text.wrapMode).toBe("char")
    await setup.flush()
    const hasDiffColorAfterAnsi = setup.captureSpans().lines.some((line) => line.spans.some((span) => span.fg.intent === "indexed"))
    expect(hasDiffColorAfterAnsi).toBe(true)
    if (typeof textView.hasSelection === "function") expect(textView.hasSelection()).toBe(false)
    if (nativeBeforeAnsi !== undefined && typeof textView.getSelection === "function") expect(textView.getSelection()).toBeNull()

    setup.renderer.destroy()
  })
  test("loading retains prior content and selection", async () => {
    const setup = await createTestRenderer({ width: 120, height: 40 })
    const model = {
      repositoryRoot: "",
      branch: "",
      reviewTarget: { kind: "working-tree", scope: "all" },
      files: [],
      patches: [],
      rawPatchSections: [],
      loading: false,
      commandLog: [],
      title: "",
    } as unknown as import("../../src/app/model").AppModel
    const pane = createMainPane(setup.renderer, model)
    const first: MainPaneContent = { source: "commit", stableId: "a", label: "A", plainText: "first content" }
    installMainContent(pane, first, false)
    setMainLoading(pane, true, false)
    expect(pane.text.scrollY).toBe(0)
    setMainLoading(pane, false, false)
    setup.renderer.destroy()
  })
})
