# Memory footprint reduction — v0.3.x

Status: phase 1 landed, phase 2 attempted and reverted, target not reached.
Target: idle RSS ~70 MB (from ~91 MB), repository screen, no Branch Review opened.
Result: **87 MB**. Two attempts were budgeted and both were spent; the remainder is not
addressable from githunk's own code. See "Where the remaining 87 MB is".

## Problem

githunk idles at ~91 MB RSS where lazygit idles at ~20 MB. The gap is not the Bun
runtime: a `console.log` compiled with `bun build --compile` idles at 14 MB, *below*
lazygit's Go runtime. The cost is what githunk puts on top.

Measured ladder (Bun 1.4.2, linux x64, compiled binaries, idle under a pty):

| build | RSS | file-backed | anon | threads |
| --- | --- | --- | --- | --- |
| lazygit | 21 MB | 12 MB | 8 MB | 7 |
| `console.log("hi")` compiled | 14 MB | 12 MB | 2 MB | 9 |
| + OpenTUI renderer, hello world | 52 MB | 35 MB | 17 MB | 13 |
| githunk | 91 MB | 42 MB | 51 MB | 18 |

OpenTUI's 38 MB is the floor we accept; it buys the renderer. The remaining ~40 MB is
addressable.

## Why bundled-but-unused code costs RSS

`bun build --compile` places the embedded module graph in an ELF `.bun` section that the
kernel maps as a `PT_LOAD` segment during `execve`
(<https://github.com/oven-sh/bun/pull/26923>). A module that is bundled but never
imported is therefore part of the process image and is charged to RSS unconditionally.

This was measured directly. A module behind an `await import()` that never executes still
cost ~13 MB of the ~19 MB that the fully-evaluated case cost. Converting
`useReviewHighlights.ts`'s static import to a dynamic one produced a **byte-identical
binary and identical RSS**.

`--splitting` is the escape hatch, and it is supported with `--compile`
(<https://bun.com/docs/bundler/executables>). With it, deferred chunks are not
instantiated at startup.

## What dominates the addressable 40 MB

> **Superseded by phase 2's result.** Everything below was measured *before* `--splitting`
> and was true then. Once `--splitting` is on, Shiki stops being the problem: its grammars
> are dynamic imports, and deferring them is enough. Kept because it explains why phase 2
> looked like the obvious next step, and why it was not.

Shiki, reached transitively through `@pierre/diffs`:

- `dist/highlighter/shared_highlighter.js:8` — `import { createHighlighter, … } from "shiki"`
- `dist/highlighter/languages/resolveLanguage.js:3` — `import { bundledLanguages } from "shiki"`

That pulls all 346 bundled grammars into the binary. Isolated measurement: importing
`highlight-adapter` alone takes a bare binary from 15 MB to 46 MB RSS without
highlighting anything. Stubbing it out of githunk saved 10.4 MB of binary and 15 MB of
RSS in a same-run comparison.

By contrast React + `@opentui/react` + the whole review-workspace UI is worth only ~2 MB
of binary and ~3 MB of RSS. **The problem is Shiki's grammars, not "the Branch Review
packages".**

## Approaches considered

| approach | verdict |
| --- | --- |
| `await import()` alone | **Rejected.** No effect without `--splitting`; binary byte-identical. |
| `--compile --splitting` | **Adopted (phase 1).** Startup RSS 54 → 16 MB in a staged probe. |
| `--minify` | **Adopted (phase 1).** ~2 MB binary, ~4 MB RSS. No trade-off. |
| `--bytecode` | **Deferred.** Needs `--format=esm` under `--compile` (@opentui/core uses top-level await, so plain `--bytecode` will not build); grows the binary 107 → 127 MB. Buys startup time, not memory. Worth revisiting on its own merits, since this project accepts a larger binary for faster startup. |
| `shiki/core` instead of `shiki` | **Rejected.** githunk does not import `shiki`; `@pierre/diffs` does. Our choice of specifier is irrelevant. |
| Tree-shaking `bundledLanguages` | **Rejected.** It is a live map of `() => import(…)` thunks. A stored thunk is never shakeable, and `sideEffects: false` does not help. |
| `tsconfig` `paths` alias | **Rejected.** Verified not to apply to a bare specifier imported from inside `node_modules`; the binary came out larger. |
| `--external` / `--packages=external` | **Rejected.** Incoherent with a standalone binary. |
| Grammars as external files beside the binary | **Rejected.** Breaks the single-file distribution that `install.sh` and the five platform packages depend on. |
| Splitting Branch Review into a second binary | **Rejected.** Ten platform artifacts instead of five, and both processes are resident while review is open, so peak gets worse. |
| **Build-time stub alias for `shiki` + curated grammars** | **Attempted (phase 2), reverted.** Works and shrinks the binary, but buys no memory once `--splitting` is on. See below. |

## Phase 1 — build flags and a lazy Branch Review chunk

1. `--splitting` and `--minify` in `scripts/build-bin.ts`.
2. Make `ReactReviewHost` reachable only through a dynamic import so the Branch Review
   chunk is not instantiated until the screen is opened. `createReviewView` returns a
   promise; `AppScreenController` awaits it.

Measured on the real `cli.ts` binary, idle in this repository, median of 3 runs:

| build | binary | idle RSS |
| --- | --- | --- |
| baseline | 107.5 MB | 92 MB |
| shipped (`--splitting --minify` + lazy `ReactReviewHost`) | 105.3 MB | **87 MB** |

Startup, before the app does any work, drops much further than the idle figure suggests:
54 MB → 16 MB. The idle number converges because the repository screen legitimately loads
most of the graph; what `--splitting` removes is everything the screen never touches.

## Phase 2 — take Shiki's grammars out of the module graph

The key observation is that a payload embedded as a **file asset** is free until read,
while the same payload as a **module** is not. Same 1.9 MB JSON, same binary size:

| form | startup RSS |
| --- | --- |
| `import data from "./g.json"` | 36 MB |
| `import blob from "./g.json" with { type: "file" }` + `Bun.file(blob).text()` | 16 MB (= baseline) |

So:

1. A stub module exporting empty `bundledLanguages` / `bundledThemes`, re-exporting
   `@shikijs/core` and `createJavaScriptRegexEngine`.
2. A `Bun.build` `onResolve` plugin aliasing both `shiki` and `shiki/wasm` to that stub.
   `shiki/wasm` matters separately: it re-exports the base64-inlined oniguruma WASM, so
   it costs startup memory even unused, and `@pierre/diffs` names it in an unexecuted
   branch.
3. A curated grammar set dumped to JSON, embedded `with { type: "file" }`, registered
   through `@pierre/diffs`' public `registerCustomLanguage` / `registerCustomTheme`.
   `resolveLanguage.js:11` checks custom loaders *before* `bundledLanguages`, so this is
   a supported seam.
4. `scripts/build-bin.ts` moves from `Bun.spawnSync` of the CLI to the `Bun.build` JS API
   so the plugin can be applied. `compile.target` keeps the `-baseline` constraint that
   prevents SIGILL on pre-Haswell CPUs.

### Outcome: attempted, measured, reverted

Built and measured. Highlighting was verified functionally in a compiled binary against a
real-Shiki build of the same probe: identical output (typescript 8 tokens, ruby 6 tokens,
an unknown extension null in both). The binary shrank 105.3 MB → 100.0 MB.

**Idle RSS did not move.** Medians of three runs each, measured in one batch with no other
load:

| build | idle RSS |
| --- | --- |
| baseline | 92 MB |
| phase 1 | 87 MB |
| phase 1 + Shiki stub | 88 MB |

The reason is that phase 1 already solved it. Shiki's `bundledLanguages` entries are
*already* dynamic imports; what made them expensive was `--compile` without `--splitting`
mapping the whole graph into the process image. Once `--splitting` defers them, narrowing
346 deferred chunks to 60 deferred chunks saves binary bytes and no memory.

So the stub was reverted. It bought ~5 MB of binary — which this project would happily
pay — but at the cost of a language allowlist: any grammar outside the curated set
silently loses highlighting. That is a real regression in exchange for zero progress on
the actual goal.

**The general lesson: with `--splitting` on, a dependency's dynamically-imported payload
is no longer a memory problem. Only statically reachable code is.**

### Risk that made the stub not worth keeping: unsupported languages throw

With `bundledLanguages` stubbed empty, a language outside the curated set raises
`resolveLanguage: "<lang>" not found in bundled or custom languages` rather than
degrading. githunk must gate the detected language through an allowlist and fall back to
`text` before handing it to `@pierre/diffs`. Grammar JSON is not free either — a
19-language set is ~1.26 MB but `ruby` alone is 2.5 MB — so the set is curated
deliberately.

## Where the remaining 87 MB is

Staged probe on the shipped build (`--splitting --minify`, lazy Branch Review):

```
start                    RSS=16MB   heap=0.9MB  thr=3     <- was 54 MB before --splitting
import @opentui/core     RSS=55MB   heap=4.6MB  thr=6     (+39)
import githunk graph     RSS=62MB   heap=7.5MB  thr=6     (+7)
createCliRenderer        RSS=60MB   heap=8.1MB  thr=8     (-2)
createApp                RSS=66MB   heap=9.2MB  thr=8     (+6)
refresh                  RSS=83MB   heap=15.1MB thr=18    (+17)
+2.5s idle               RSS=89MB   heap=16.3MB thr=18    (+6)
after gc                 RSS=89MB   heap=15.9MB thr=19
```

`--splitting` did its job: startup is now 16 MB, and the single largest remaining item is
**importing `@opentui/core`, +39 MB**. Isolated in its own compiled binary, that import
alone takes 16 MB → 50 MB, of which 36.3 MB is binary file pages and 9.9 MB is anonymous.

That cost is not reachable from githunk. OpenTUI already embeds its tree-sitter grammars
with `with { type: "file" }` — the cheap form, free until read — so there is no wasm
payload to strip. What remains is its own JavaScript plus extracting the 6.1 MB
`libopentui.so` to a temporary file at import time, both intrinsic to loading the renderer.
The floor for *any* Bun + OpenTUI application measured 52 MB for a hello-world TUI.

Reaching ~70 MB would need one of:

- upstream OpenTUI work (a smaller or lazily-loaded native backend), or
- githunk's own `refresh` step, worth +17 MB with only +6 MB of JS heap behind it, meaning
  the bulk is OpenTUI text buffers and Git output rather than githunk objects, or
- not using OpenTUI.

None of those is a build-flag change, so none was attempted within this task's budget.

## Measurement method

Numbers in this document come from a compiled binary run under a pty
(`setsid script -qfc <bin> /dev/null`), sampled from `/proc/<pid>/status` after 8-9 s of
idle, in this repository. Cross-run variance is roughly ±5 MB, so only same-run
comparisons are quoted as deltas. A staged probe that snapshots RSS at
`start` / `import` / `createCliRenderer` / `createApp` / `refresh` is used to attribute
cost to a startup phase.

`--bytecode` is currently blocked without `--format=esm` because `@opentui/core` uses
top-level await:

```
error: "await" can only be used inside an "async" function
  at node_modules/@opentui/core/chunk-bun-37s3zwb6.js:11882:22
  11882 | var backend2 = await loadBackend2();
```
