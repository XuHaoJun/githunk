# Memory footprint reduction — v0.3.x

Status: in progress
Target: idle RSS ~70 MB (from ~91 MB), repository screen, no Branch Review opened.

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
| `--bytecode` | **Deferred.** Requires `--format=esm` with `--compile`; grows the binary 107 → 127 MB. Buys startup time, not memory. Revisit once phase 2 lands, since the project accepts a larger binary for faster startup. |
| `shiki/core` instead of `shiki` | **Rejected.** githunk does not import `shiki`; `@pierre/diffs` does. Our choice of specifier is irrelevant. |
| Tree-shaking `bundledLanguages` | **Rejected.** It is a live map of `() => import(…)` thunks. A stored thunk is never shakeable, and `sideEffects: false` does not help. |
| `tsconfig` `paths` alias | **Rejected.** Verified not to apply to a bare specifier imported from inside `node_modules`; the binary came out larger. |
| `--external` / `--packages=external` | **Rejected.** Incoherent with a standalone binary. |
| Grammars as external files beside the binary | **Rejected.** Breaks the single-file distribution that `install.sh` and the five platform packages depend on. |
| Splitting Branch Review into a second binary | **Rejected.** Ten platform artifacts instead of five, and both processes are resident while review is open, so peak gets worse. |
| **Build-time stub alias for `shiki` + grammars as embedded assets** | **Adopted (phase 2).** See below. |

## Phase 1 — build flags and a lazy Branch Review chunk

1. `--splitting` and `--minify` in `scripts/build-bin.ts`.
2. Make `ReactReviewHost` reachable only through a dynamic import so the Branch Review
   chunk is not instantiated until the screen is opened. `createReviewView` returns a
   promise; `AppScreenController` awaits it.

Measured on the real `cli.ts` binary, idle in this repository, median of 3 runs:

| build | binary | idle RSS |
| --- | --- | --- |
| baseline | 107.5 MB | 91 MB |
| `--splitting` | 107.5 MB | 88 MB |
| + lazy `ReactReviewHost` | 107.5 MB | 85 MB |
| + `--minify` | 105.3 MB | 83 MB |

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

### Risk: unsupported languages throw

With `bundledLanguages` stubbed empty, a language outside the curated set raises
`resolveLanguage: "<lang>" not found in bundled or custom languages` rather than
degrading. githunk must gate the detected language through an allowlist and fall back to
`text` before handing it to `@pierre/diffs`. Grammar JSON is not free either — a
19-language set is ~1.26 MB but `ruby` alone is 2.5 MB — so the set is curated
deliberately.

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
