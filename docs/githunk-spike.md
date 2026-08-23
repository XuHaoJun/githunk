# githunk OpenTUI Selection Spike Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove that OpenTUI can provide pane-isolated patch selection, correct copy semantics, mouse-resizable panes, and usable OSC52 clipboard behavior before githunk commits to OpenTUI.

**Architecture:** Build a disposable, fixture-only two-pane TUI using OpenTUI's imperative API. Keep layout math, splitter state, clipboard policy, and acceptance checks in small pure modules so they can be unit-tested with Bun; keep OpenTUI-specific wiring in one UI module. Do not call Git in this spike.

**Tech Stack:** Bun, TypeScript, `@opentui/core@0.5.6`, Bun test runner, OpenTUI imperative renderables.

**Spec:** `docs/superpowers/specs/2026-08-24-githunk-v0.1-design.md`

## Global Constraints

- This spike is disposable; do not build production Git abstractions into it.
- Do not execute `git status`, `git diff`, or any other Git command.
- Pin `@opentui/core` to exactly `0.5.6` and commit the lockfile.
- Preserve a deterministic fixture so failures can be reproduced across terminals.
- Selection must be application-aware and must never copy left-pane text when the drag remains inside the patch pane.
- Test ASCII, CJK, emoji, tabs, blank lines, long lines, wrapped lines, and multiple diff hunks.
- Test both a vertical pane splitter and clipboard behavior.
- OSC52 success means "OpenTUI emitted the request", not proof that the terminal changed its clipboard; manual verification is required.
- Record terminal, `$TERM`, SSH, tmux, and zellij context for every manual compatibility run.

---

## File Structure

```text
githunk/
├── package.json                         # Bun scripts and exact dependency pins
├── tsconfig.json                        # Strict TypeScript configuration
├── bun.lock                             # Exact dependency lock
├── spike/
│   └── selection/
│       ├── src/
│       │   ├── main.ts                  # Renderer startup and shutdown only
│       │   ├── app.ts                   # OpenTUI renderables and event wiring
│       │   ├── layout.ts                # Pure splitter geometry/state rules
│       │   ├── clipboard.ts             # OSC52 copy policy/result model
│       │   ├── acceptance-log.ts        # Captures spike environment + manual results
│       │   └── fixtures/
│       │       └── patch.ts             # Hostile deterministic left/patch content
│       ├── tests/
│       │   ├── layout.test.ts
│       │   ├── clipboard.test.ts
│       │   └── fixture.test.ts
│       ├── README.md                    # Exact manual test procedure
│       └── results.md                   # Filled compatibility/decision report
└── docs/
    └── superpowers/
        ├── specs/2026-08-24-githunk-v0.1-design.md
        └── plans/2026-08-24-githunk-selection-spike.md
```

`app.ts` is intentionally the only module allowed to know the OpenTUI widget tree. `layout.ts` and `clipboard.ts` must remain framework-light so a future Ratatui spike can reuse the behavioral requirements even though not the TypeScript implementation.

---

### Task 1: Bootstrap the Disposable Spike and Hostile Fixture

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `spike/selection/src/fixtures/patch.ts`
- Create: `spike/selection/tests/fixture.test.ts`
- Create: `spike/selection/README.md`

**Interfaces:**
- Produces: `LEFT_FIXTURE: readonly string[]`
- Produces: `PATCH_FIXTURE: string`
- Produces: `PATCH_SENTINELS: readonly string[]`

- [ ] **Step 1: Write the failing fixture integrity test**

```ts
// spike/selection/tests/fixture.test.ts
import { describe, expect, test } from "bun:test"
import {
  LEFT_FIXTURE,
  PATCH_FIXTURE,
  PATCH_SENTINELS,
} from "../src/fixtures/patch"

describe("selection spike fixtures", () => {
  test("left fixture is dense enough to expose row contamination", () => {
    expect(LEFT_FIXTURE.length).toBeGreaterThanOrEqual(20)
    expect(LEFT_FIXTURE.some((line) => line.includes("中文"))).toBe(true)
    expect(LEFT_FIXTURE.some((line) => line.includes("🚀"))).toBe(true)
  })

  test("patch fixture contains every hostile selection case", () => {
    expect(PATCH_FIXTURE).toContain("@@ -120,8 +120,14 @@")
    expect(PATCH_FIXTURE).toContain("中文審查")
    expect(PATCH_FIXTURE).toContain("🚀")
    expect(PATCH_FIXTURE).toContain("\t")
    expect(PATCH_FIXTURE).toContain("e\u0301")
    expect(PATCH_FIXTURE).toContain("const intentionallyLongLine")
    for (const sentinel of PATCH_SENTINELS) {
      expect(PATCH_FIXTURE).toContain(sentinel)
      expect(LEFT_FIXTURE.join("\n")).not.toContain(sentinel)
    }
  })
})
```

- [ ] **Step 2: Run the test and verify it fails because the fixture module does not exist**

Run:

```bash
bun test spike/selection/tests/fixture.test.ts
```

Expected: FAIL with module-resolution error for `../src/fixtures/patch`.

- [ ] **Step 3: Create the package and TypeScript configuration**

```json
// package.json
{
  "name": "githunk",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "bun test",
    "spike:selection": "bun run spike/selection/src/main.ts"
  },
  "dependencies": {
    "@opentui/core": "0.5.6"
  },
  "devDependencies": {
    "@types/bun": "latest",
    "typescript": "latest"
  }
}
```

```json
// tsconfig.json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "types": ["bun-types"],
    "skipLibCheck": true
  },
  "include": ["spike/**/*.ts"]
}
```

Run:

```bash
bun install
```

Expected: `bun.lock` is created and resolves `@opentui/core` to `0.5.6`.

- [ ] **Step 4: Implement the hostile fixture**

```ts
// spike/selection/src/fixtures/patch.ts
export const LEFT_FIXTURE = [
  "M src/auth/session.ts",
  "M src/payments/capture.ts",
  "M src/really/really/really/long/path/checkout-service.ts",
  "M src/中文檔案.ts",
  "M src/🚀-worker.ts",
  "M tests/auth/session.test.ts",
  "M tests/payments/capture.test.ts",
  "M src/a.ts",
  "M src/b.ts",
  "M src/c.ts",
  "M src/d.ts",
  "M src/e.ts",
  "M src/f.ts",
  "M src/g.ts",
  "M src/h.ts",
  "M src/i.ts",
  "M src/j.ts",
  "M src/k.ts",
  "M src/l.ts",
  "M src/m.ts",
  "M src/n.ts",
  "M src/o.ts",
] as const

export const PATCH_SENTINELS = [
  "GITHUNK_PATCH_ONLY_ALPHA",
  "GITHUNK_PATCH_ONLY_OMEGA",
] as const

export const PATCH_FIXTURE = `diff --git a/src/payments/capture.ts b/src/payments/capture.ts
index 1111111..2222222 100644
--- a/src/payments/capture.ts
+++ b/src/payments/capture.ts
@@ -120,8 +120,14 @@ export async function capturePayment(order: Order) {
-\tconst result = await legacyCapture(order)
+\tconst result = await capture(order)
+\tconst reviewLabel = "中文審查 🚀 e\u0301 GITHUNK_PATCH_ONLY_ALPHA"
+
+\tconst intentionallyLongLine = "this line is deliberately long so that a narrow patch pane forces wrapping while the logical source line remains one line for clipboard validation"
+
+\tif (!result.ok) {
+\t\tthrow new Error("capture failed")
+\t}
 
 \treturn result
 }
@@ -210,3 +216,4 @@ function audit() {
-  return "old"
+  return "new"
+  // GITHUNK_PATCH_ONLY_OMEGA
 }
`
```

- [ ] **Step 5: Run fixture tests**

Run:

```bash
bun test spike/selection/tests/fixture.test.ts
```

Expected: PASS.

- [ ] **Step 6: Write the spike README prerequisites**

```markdown
# OpenTUI Selection Spike

Prerequisites:

- Bun
- Zig (required by OpenTUI build/install path)
- a terminal with mouse reporting enabled

Run:

```bash
bun install
bun run spike:selection
```

This spike uses fixtures only. It must not execute Git commands.
```

- [ ] **Step 7: Commit**

```bash
git add package.json tsconfig.json bun.lock spike/selection
git commit -m "spike: bootstrap opentui selection fixture"
```

---

### Task 2: Implement Testable Splitter Geometry

**Files:**
- Create: `spike/selection/src/layout.ts`
- Create: `spike/selection/tests/layout.test.ts`

**Interfaces:**
- Produces: `type PaneLayout = { terminalWidth: number; leftWidth: number; splitterX: number; rightWidth: number }`
- Produces: `computePaneLayout(terminalWidth: number, requestedLeftWidth: number): PaneLayout`
- Produces: `resizeLeftPane(current: PaneLayout, mouseX: number): PaneLayout`

- [ ] **Step 1: Write failing layout tests**

```ts
// spike/selection/tests/layout.test.ts
import { describe, expect, test } from "bun:test"
import { computePaneLayout, resizeLeftPane } from "../src/layout"

describe("pane geometry", () => {
  test("keeps useful minimum widths", () => {
    expect(computePaneLayout(120, 30)).toEqual({
      terminalWidth: 120,
      leftWidth: 30,
      splitterX: 30,
      rightWidth: 89,
    })
  })

  test("clamps the left pane when dragged too far left", () => {
    const initial = computePaneLayout(120, 30)
    expect(resizeLeftPane(initial, 2).leftWidth).toBe(18)
  })

  test("protects at least 40 columns for the patch pane", () => {
    const initial = computePaneLayout(120, 30)
    const resized = resizeLeftPane(initial, 110)
    expect(resized.rightWidth).toBeGreaterThanOrEqual(40)
  })
})
```

- [ ] **Step 2: Run the tests and verify failure**

Run:

```bash
bun test spike/selection/tests/layout.test.ts
```

Expected: FAIL because `layout.ts` does not exist.

- [ ] **Step 3: Implement minimal deterministic layout math**

```ts
// spike/selection/src/layout.ts
const MIN_LEFT = 18
const MIN_RIGHT = 40
const SPLITTER_WIDTH = 1

export type PaneLayout = {
  terminalWidth: number
  leftWidth: number
  splitterX: number
  rightWidth: number
}

export function computePaneLayout(
  terminalWidth: number,
  requestedLeftWidth: number,
): PaneLayout {
  const maxLeft = Math.max(MIN_LEFT, terminalWidth - MIN_RIGHT - SPLITTER_WIDTH)
  const leftWidth = Math.min(Math.max(requestedLeftWidth, MIN_LEFT), maxLeft)
  return {
    terminalWidth,
    leftWidth,
    splitterX: leftWidth,
    rightWidth: Math.max(0, terminalWidth - leftWidth - SPLITTER_WIDTH),
  }
}

export function resizeLeftPane(current: PaneLayout, mouseX: number): PaneLayout {
  return computePaneLayout(current.terminalWidth, mouseX)
}
```

- [ ] **Step 4: Run the tests**

Run:

```bash
bun test spike/selection/tests/layout.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add spike/selection/src/layout.ts spike/selection/tests/layout.test.ts
git commit -m "spike: add deterministic pane splitter geometry"
```

---

### Task 3: Build the Two-Pane OpenTUI and Prove Pane-Isolated Selection

**Files:**
- Create: `spike/selection/src/app.ts`
- Create: `spike/selection/src/main.ts`
- Modify: `spike/selection/README.md`

**Interfaces:**
- Consumes: `LEFT_FIXTURE`, `PATCH_FIXTURE`
- Consumes: `computePaneLayout`, `resizeLeftPane`
- Produces: `createSelectionSpike(renderer: CliRenderer): { destroy(): void }`

- [ ] **Step 1: Add a manual acceptance section before implementation**

Append to `spike/selection/README.md`:

```markdown
## Core manual acceptance

1. Run the spike at >= 100 columns.
2. Drag from the middle of one patch line through at least five patch rows.
3. Confirm the visible selection never highlights the left file list.
4. Confirm copied text contains `GITHUNK_PATCH_ONLY_ALPHA` when selected and contains no `M src/` file-list text.
5. Scroll the patch and repeat.
6. Narrow the right pane until the long source line wraps and repeat.
```

- [ ] **Step 2: Implement renderer startup**

```ts
// spike/selection/src/main.ts
import { createCliRenderer } from "@opentui/core"
import { createSelectionSpike } from "./app"

const renderer = await createCliRenderer({
  exitOnCtrlC: true,
  useMouse: true,
  enableMouseMovement: true,
  targetFps: 30,
})

createSelectionSpike(renderer)
```

- [ ] **Step 3: Implement the two-pane UI using separate renderables**

`spike/selection/src/app.ts` must build this hierarchy:

```text
root row
├── left BoxRenderable
│   └── TextRenderable (LEFT_FIXTURE.join("\n"), selectable: false)
├── splitter BoxRenderable (width 1)
└── right ScrollBoxRenderable
    └── CodeRenderable (PATCH_FIXTURE, selectable: true)
```

Use `CodeRenderable` for the patch and set `selectable: true`. Do not put the left file list and patch text in the same `TextRenderable` or `CodeRenderable`.

The essential construction must follow this shape:

```ts
import {
  BoxRenderable,
  CodeRenderable,
  ScrollBoxRenderable,
  TextRenderable,
  type CliRenderer,
} from "@opentui/core"
import { LEFT_FIXTURE, PATCH_FIXTURE } from "./fixtures/patch"
import { computePaneLayout, resizeLeftPane } from "./layout"

export function createSelectionSpike(renderer: CliRenderer): { destroy(): void } {
  let layout = computePaneLayout(renderer.terminalWidth, 30)

  const root = new BoxRenderable(renderer, {
    id: "spike-root",
    flexDirection: "row",
    width: "100%",
    height: "100%",
  })

  const left = new BoxRenderable(renderer, {
    id: "left-pane",
    width: layout.leftWidth,
    height: "100%",
    border: true,
    title: "LEFT — must never contaminate PATCH copy",
  })

  const leftText = new TextRenderable(renderer, {
    id: "left-fixture",
    content: LEFT_FIXTURE.join("\n"),
    selectable: false,
  })

  const splitter = new BoxRenderable(renderer, {
    id: "vertical-splitter",
    width: 1,
    height: "100%",
  })

  const patchScroll = new ScrollBoxRenderable(renderer, {
    id: "patch-scroll",
    width: layout.rightWidth,
    height: "100%",
    border: true,
    title: "PATCH — drag to select",
    scrollY: true,
    scrollX: false,
  })

  const patch = new CodeRenderable(renderer, {
    id: "patch-code",
    content: PATCH_FIXTURE,
    filetype: "diff",
    selectable: true,
    width: "100%",
  })

  left.add(leftText)
  patchScroll.add(patch)
  root.add(left)
  root.add(splitter)
  root.add(patchScroll)
  renderer.root.add(root)

  const applyLayout = () => {
    left.width = layout.leftWidth
    patchScroll.width = layout.rightWidth
  }

  splitter.onMouseDrag = (event) => {
    layout = resizeLeftPane(
      computePaneLayout(renderer.terminalWidth, layout.leftWidth),
      event.x,
    )
    applyLayout()
  }

  renderer.on("resize", (width) => {
    layout = computePaneLayout(width, layout.leftWidth)
    applyLayout()
  })

  return {
    destroy() {
      root.destroy()
    },
  }
}
```

If `filetype: "diff"` is not accepted by OpenTUI 0.5.6, use `TextRenderable` with `selectable: true` for this spike rather than introducing a custom syntax layer; selection correctness is the requirement.

- [ ] **Step 4: Run the application and execute S1–S4 manually**

Run:

```bash
bun run spike:selection
```

Verify:

- multiline selection wholly inside PATCH does not highlight LEFT;
- first/last line can start/end mid-line;
- scrolling does not shift copied logical content;
- dragging the splitter changes widths without starting patch selection.

Expected: all four behaviors succeed or the failure is recorded verbatim in `results.md` during Task 7.

- [ ] **Step 5: Run automated tests to guard pure modules**

Run:

```bash
bun test
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add spike/selection/src/app.ts spike/selection/src/main.ts spike/selection/README.md
git commit -m "spike: prove opentui pane-aware patch selection"
```

---

### Task 4: Add Explicit Clipboard Policy and OSC52 Feedback

**Files:**
- Create: `spike/selection/src/clipboard.ts`
- Create: `spike/selection/tests/clipboard.test.ts`
- Modify: `spike/selection/src/app.ts`

**Interfaces:**
- Produces: `type ClipboardPort = { isOsc52Supported(): boolean; copyToClipboardOSC52(text: string): boolean }`
- Produces: `type CopyResult = { status: "emitted" | "blocked" | "empty"; bytes: number }`
- Produces: `copySelection(text: string, clipboard: ClipboardPort): CopyResult`

- [ ] **Step 1: Write failing clipboard-policy tests**

```ts
// spike/selection/tests/clipboard.test.ts
import { describe, expect, test } from "bun:test"
import { copySelection } from "../src/clipboard"

describe("OSC52 copy policy", () => {
  test("does not emit empty selections", () => {
    const port = {
      isOsc52Supported: () => true,
      copyToClipboardOSC52: () => true,
    }
    expect(copySelection("", port)).toEqual({ status: "empty", bytes: 0 })
  })

  test("reports capability-policy block", () => {
    const port = {
      isOsc52Supported: () => false,
      copyToClipboardOSC52: () => true,
    }
    expect(copySelection("abc", port)).toEqual({ status: "blocked", bytes: 3 })
  })

  test("reports emission but does not claim terminal acceptance", () => {
    const port = {
      isOsc52Supported: () => true,
      copyToClipboardOSC52: (text: string) => text === "abc",
    }
    expect(copySelection("abc", port)).toEqual({ status: "emitted", bytes: 3 })
  })
})
```

- [ ] **Step 2: Run the test and verify it fails**

Run:

```bash
bun test spike/selection/tests/clipboard.test.ts
```

Expected: FAIL because `clipboard.ts` does not exist.

- [ ] **Step 3: Implement the policy**

```ts
// spike/selection/src/clipboard.ts
export type ClipboardPort = {
  isOsc52Supported(): boolean
  copyToClipboardOSC52(text: string): boolean
}

export type CopyResult = {
  status: "emitted" | "blocked" | "empty"
  bytes: number
}

export function copySelection(text: string, clipboard: ClipboardPort): CopyResult {
  const bytes = Buffer.byteLength(text, "utf8")
  if (text.length === 0) return { status: "empty", bytes }
  if (!clipboard.isOsc52Supported()) return { status: "blocked", bytes }
  return {
    status: clipboard.copyToClipboardOSC52(text) ? "emitted" : "blocked",
    bytes,
  }
}
```

- [ ] **Step 4: Wire renderer selection completion to OSC52**

In `app.ts`, subscribe once:

```ts
renderer.on("selection", (selection) => {
  const text = selection.getSelectedText()
  const result = copySelection(text, renderer)
  statusText.content =
    result.status === "emitted"
      ? `OSC52 emitted ${result.bytes} bytes — verify local clipboard`
      : result.status === "blocked"
        ? "OSC52 blocked/unsupported in this environment"
        : "No text selected"
})
```

Add a one-line, non-selectable status renderable inside the root or right pane. The message must say **emitted**, not **copied**, because terminals do not acknowledge OSC52 clipboard acceptance.

- [ ] **Step 5: Run tests**

Run:

```bash
bun test
```

Expected: PASS.

- [ ] **Step 6: Manually verify local clipboard**

Run:

```bash
bun run spike:selection
```

Select `GITHUNK_PATCH_ONLY_ALPHA`, then paste into a normal local shell/editor outside the spike.

Expected: pasted content exactly matches the selected patch text and contains no left-pane file names.

- [ ] **Step 7: Commit**

```bash
git add spike/selection/src/clipboard.ts spike/selection/tests/clipboard.test.ts spike/selection/src/app.ts
git commit -m "spike: validate osc52 patch copy semantics"
```

---

### Task 5: Stress Wrapping, Unicode, Resizing, and Selection Boundaries

**Files:**
- Modify: `spike/selection/README.md`
- Modify: `spike/selection/src/app.ts` only if a diagnostic toggle is needed

**Interfaces:**
- Consumes existing fixture and UI.
- Produces no production interface; this task produces reproducible evidence.

- [ ] **Step 1: Add the exact stress matrix to the README**

```markdown
## Stress matrix

Run each case twice: once at 120+ columns and once with PATCH narrowed until the intentionally long line wraps.

| ID | Case | Expected |
|---|---|---|
| U1 | Select `中文審查` | Exact CJK text |
| U2 | Select `🚀` plus neighbors | No adjacent character corruption |
| U3 | Select `é` | Grapheme is not split/corrupted |
| U4 | Select a tab-indented line | Clipboard preserves logical indentation |
| W1 | Select the wrapped long source line | Clipboard contains one logical source line, not visual-row artifacts |
| W2 | Select from mid wrapped line into next logical line | Boundary text is correct |
| R1 | Resize terminal narrower, then wider | Selection remains mapped to visible patch content |
| R2 | Drag splitter repeatedly, then select | No left-pane contamination |
| S1 | Start drag on splitter | Resize only; no text selection |
| S2 | Start drag one cell inside patch | Selection only; no resize |
```

- [ ] **Step 2: Run every stress case locally**

Run:

```bash
bun run spike:selection
```

Expected: U1–U4, W1–W2, R1–R2, S1–S2 all match the table. Capture any mismatch with terminal name, version, dimensions, and exact selected/pasted text.

- [ ] **Step 3: Re-run automated tests after any diagnostic change**

Run:

```bash
bun test
```

Expected: PASS.

- [ ] **Step 4: Commit documentation/evidence changes**

```bash
git add spike/selection/README.md spike/selection/src/app.ts
git commit -m "spike: exercise unicode wrapping and resize selection"
```

---

### Task 6: Add Environment Capture for Remote Compatibility Runs

**Files:**
- Create: `spike/selection/src/acceptance-log.ts`
- Modify: `spike/selection/src/main.ts`
- Modify: `spike/selection/README.md`

**Interfaces:**
- Produces: `captureEnvironment(): AcceptanceEnvironment`
- Produces: `type AcceptanceEnvironment`

- [ ] **Step 1: Implement environment capture**

```ts
// spike/selection/src/acceptance-log.ts
export type AcceptanceEnvironment = {
  term: string | null
  termProgram: string | null
  ssh: boolean
  tmux: boolean
  zellij: boolean
  columns: number | null
  rows: number | null
}

export function captureEnvironment(): AcceptanceEnvironment {
  return {
    term: process.env.TERM ?? null,
    termProgram: process.env.TERM_PROGRAM ?? null,
    ssh: Boolean(process.env.SSH_CONNECTION || process.env.SSH_CLIENT || process.env.SSH_TTY),
    tmux: Boolean(process.env.TMUX),
    zellij: Boolean(process.env.ZELLIJ || process.env.ZELLIJ_SESSION_NAME),
    columns: process.stdout.columns ?? null,
    rows: process.stdout.rows ?? null,
  }
}
```

- [ ] **Step 2: Print environment metadata before renderer takeover**

In `main.ts`, before `createCliRenderer`, serialize the environment to stderr only when `GITHUNK_SPIKE_ENV=1`:

```ts
import { captureEnvironment } from "./acceptance-log"

if (process.env.GITHUNK_SPIKE_ENV === "1") {
  process.stderr.write(`${JSON.stringify(captureEnvironment())}\n`)
}
```

- [ ] **Step 3: Add exact remote test commands to README**

```markdown
## Remote matrix

Capture environment:

```bash
GITHUNK_SPIKE_ENV=1 bun run spike:selection 2> /tmp/githunk-spike-env.json
cat /tmp/githunk-spike-env.json
```

Run these four environments where available:

1. local terminal
2. SSH, no multiplexer
3. SSH inside tmux
4. SSH inside zellij

For each environment:

- select `GITHUNK_PATCH_ONLY_ALPHA`;
- paste on the client machine;
- repeat with a multiline selection containing CJK + emoji;
- record PASS/FAIL and any terminal setting required for OSC52.
```

- [ ] **Step 4: Run automated tests**

Run:

```bash
bun test
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add spike/selection/src/acceptance-log.ts spike/selection/src/main.ts spike/selection/README.md
git commit -m "spike: capture ssh tmux and zellij test context"
```

---

### Task 7: Execute the Compatibility Matrix and Make the Framework Decision

**Files:**
- Create: `spike/selection/results.md`

**Interfaces:**
- Produces: one decision: `ACCEPT_OPENTUI`, `ACCEPT_WITH_WORKAROUND`, or `REJECT_OPENTUI`.

- [ ] **Step 1: Create the results document with explicit gates**

```markdown
# OpenTUI Selection Spike Results

**OpenTUI:** @opentui/core 0.5.6
**Date:** 2026-08-24

## Release-blocking gates

| Gate | Result | Evidence |
|---|---|---|
| Pane-isolated multiline selection | | |
| Partial first/last line correctness | | |
| Scrolled selection correctness | | |
| Wrapped logical-line correctness | | |
| CJK / emoji / combining text | | |
| Terminal resize correctness | | |
| Mouse splitter does not steal selection | | |
| Local clipboard | | |
| SSH clipboard | | |

## Compatibility observations

| Environment | Selection | OSC52 | Required configuration |
|---|---|---|---|
| Local | | | |
| SSH | | | |
| SSH + tmux | | | |
| SSH + zellij | | | |

## Decision

Choose exactly one:

- `ACCEPT_OPENTUI` — every release-blocking gate passes.
- `ACCEPT_WITH_WORKAROUND` — every core selection gate passes and clipboard/multiplexer limitations have a small, explicit fallback suitable for v0.1.
- `REJECT_OPENTUI` — pane isolation, wrapping, Unicode, scrolling, or resize correctness cannot be made reliable without building our own selection model.

## Notes

Record exact repro steps for every failure.
```

- [ ] **Step 2: Execute the local gate matrix**

Run:

```bash
bun run spike:selection
```

Expected: fill every local release-blocking row with PASS or a reproducible failure.

- [ ] **Step 3: Execute available SSH / tmux / zellij runs**

Use the procedure from `README.md` and record client terminal settings required for OSC52.

Expected: the report distinguishes OpenTUI emission from actual client clipboard acceptance.

- [ ] **Step 4: Re-check known OpenTUI selection churn before rejecting the framework**

If and only if a core selection gate fails on 0.5.6, reproduce it against the current OpenTUI example behavior or current `main` before declaring the architecture impossible. Do not silently move githunk to an unpinned development build; record whether the defect is already fixed upstream.

- [ ] **Step 5: Make the framework decision**

Decision rule:

```text
if pane isolation && scrolling && wrapping && unicode && resize pass:
    if local + SSH clipboard pass cleanly:
        ACCEPT_OPENTUI
    else if clipboard can use a bounded native/OSC52 fallback:
        ACCEPT_WITH_WORKAROUND
    else:
        REJECT_OPENTUI
else:
    REJECT_OPENTUI
```

Do not accept OpenTUI merely because a simple ASCII selection demo works.

- [ ] **Step 6: Run final automated verification**

Run:

```bash
bun test
```

Expected: all tests PASS.

- [ ] **Step 7: Commit the evidence**

```bash
git add spike/selection/results.md
git commit -m "docs: record opentui selection spike decision"
```

---

## Self-Review

### Spec coverage

This plan covers the approved pre-v0.1 technology gate only:

- pane-aware selection: Tasks 3, 5, 7;
- Unicode / wrapping: Tasks 1, 5, 7;
- mouse splitter: Tasks 2, 3, 5;
- OSC52: Tasks 4, 6, 7;
- SSH / tmux / zellij: Tasks 6, 7;
- reproducible framework decision: Task 7.

Git status, branches, commits, review progress, partial staging, and the full lazygit-compatible layout deliberately remain outside this plan. They should receive separate implementation plans only after this gate passes.

### Type consistency

- `computePaneLayout` and `resizeLeftPane` use `PaneLayout` consistently.
- `copySelection` accepts the minimal `ClipboardPort`, which `CliRenderer` structurally satisfies through `isOsc52Supported()` and `copyToClipboardOSC52()`.
- `createSelectionSpike` is the sole OpenTUI application composition entry point.

### Scope decision

The approved v0.1 spec contains multiple independently testable subsystems, so implementation should continue as separate plans after this spike rather than one monolithic v0.1 plan.

Recommended next plans after `ACCEPT_OPENTUI`:

1. `githunk-shell-layout-and-keymap`
2. `githunk-git-read-model`
3. `githunk-working-tree-review`
4. `githunk-branch-review-base-head`
5. `githunk-stage-unstage-partial-patch`
6. `githunk-branches-remotes-tracking-checkout`
7. `githunk-commit-stash-sync`
8. `githunk-review-progress`

