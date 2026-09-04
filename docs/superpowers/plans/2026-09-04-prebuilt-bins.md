# Prebuilt release binaries Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship githunk as standalone `bun --compile` binaries per platform (hunk-style), so the app never depends on the invoking shell's Node version.

**Architecture:** Native CI matrix builds one host binary per platform; staging scripts assemble 1 meta + 5 platform npm packages with `os`/`cpu` fields; `bin/githunk.js` execs the matching prebuilt binary with the existing Node bundle as fallback. Execution: inline in this session (operator pre-approved).

**Tech Stack:** Bun 1.4.0 (`build --compile`), TypeScript strict, GitHub Actions native runners, npm OIDC trusted publishing.

**Spec:** hunk reference at `learn-projects/hunk` (`scripts/build-bin.ts`, `scripts/prebuilt-package-helpers.ts`, `scripts/stage-prebuilt-npm.ts`, `scripts/build-prebuilt-artifact.ts`, `scripts/publish-prebuilt-npm.ts`, `bin/hunk.cjs`, `.github/workflows/release-prebuilt-npm.yml`); decisions from operator: npm first (no install.sh), manual placeholder publish + 6 trusted publishers as operator actions.

## Global Constraints

- No new runtime dependencies (`@opentui/core` stays the only one).
- `strict` + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes`; keep the `...(x === undefined ? {} : { x })` spread idiom.
- Platform matrix (5): `githunk-linux-x64`, `githunk-linux-arm64`, `githunk-darwin-x64`, `githunk-darwin-arm64`, `githunk-windows-x64` under scope `@xuhaojun`; meta package `name` stays `@xuhaojun/githunk`, all six share one version.
- x64 always uses the `-baseline` compile target (Haswell SIGILL); linux picks `-musl-baseline` when `/lib/ld-musl-x86_64.so.1` exists.
- Existing `bun run build` (Node bundle to `dist/githunk.js`) keeps working; it becomes the meta package's fallback payload.
- Operator-owned manual steps (placeholders, trusted publishers, `npm` environment) are NOT tasks in this plan; the plan ends by listing them.

---

### Task 1: Embed CLI version for the compiled binary

**Files:**
- Modify: `src/cli/args.ts:1-37` (replace filesystem walk with a bundled JSON import)
- Modify: `tsconfig.json` (add `resolveJsonModule: true`; add `scripts/**/*.ts` to `include`)
- Test: `tests/cli/args.test.ts` (unchanged, must stay green)
- Test: `tests/package/compiled-binary.integration.test.ts` (new: compile host binary, assert `--version` and non-git boot)

**Interfaces:**
- Consumes: nothing new.
- Produces: `getCliVersion(): string` keeps its signature; `scripts/*` become typechecked.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))))

describe("compiled binary", () => {
  test("reports the package version, not the dev fallback", async () => {
    const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as { version: string }
    const workdir = await mkdtemp(join(tmpdir(), "githunk-compile-"))
    try {
      const binary = join(workdir, "githunk")
      const build = Bun.spawnSync(["bun", "build", "--compile", "src/cli.ts", "--outfile", binary], { cwd: root })
      expect(build.exitCode).toBe(0)
      const run = Bun.spawnSync([binary, "--version"], { stdout: "pipe", stderr: "pipe" })
      expect(run.exitCode).toBe(0)
      expect(run.stdout.toString()).toContain(manifest.version)
      expect(run.stdout.toString()).not.toContain("0.0.0-dev")
    } finally {
      await rm(workdir, { recursive: true, force: true })
    }
  })

  test("boots outside a git repository without node", async () => {
    const workdir = await mkdtemp(join(tmpdir(), "githunk-compile-"))
    const project = await mkdtemp(join(tmpdir(), "githunk-notgit-"))
    try {
      const binary = join(workdir, "githunk")
      expect(Bun.spawnSync(["bun", "build", "--compile", "src/cli.ts", "--outfile", binary], { cwd: root }).exitCode).toBe(0)
      const run = Bun.spawnSync([binary], { cwd: project, stdout: "pipe", stderr: "pipe" })
      expect(run.exitCode).toBe(1)
      expect(run.stderr.toString()).toContain("githunk: not inside a Git repository")
    } finally {
      await rm(workdir, { recursive: true, force: true })
      await rm(project, { recursive: true, force: true })
    }
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/package/compiled-binary.integration.test.ts`
Expected: FAIL — stdout contains `0.0.0-dev`, not the manifest version.

- [ ] **Step 3: Write minimal implementation**

```ts
import { Command, CommanderError } from "commander"
import manifest from "../../package.json" with { type: "json" }
```

Replace `getCliVersion` body with:

```ts
/** Package version embedded at bundle time, so `bun build --compile` binaries report the real version. */
export function getCliVersion(): string {
  return typeof manifest.version === "string" && manifest.version !== "" ? manifest.version : "0.0.0-dev"
}
```

Delete `cachedVersion`, the walk, and the now-unused `node:fs`/`node:path`/`node:url` imports. Add `"resolveJsonModule": true` to `tsconfig.json` compilerOptions and `"scripts/**/*.ts"` to `include`.

- [ ] **Step 4: Run tests to verify green**

Run: `bun test tests/cli/args.test.ts tests/package/compiled-binary.integration.test.ts`
Expected: PASS. Also run `bun run build` (exit 0) and `bun run typecheck` (exit 0).

- [ ] **Step 5: Commit**

```bash
git add src/cli/args.ts tsconfig.json tests/package/compiled-binary.integration.test.ts
git commit -m "feat: embed CLI version for compiled binaries"
```

---

### Task 2: Host compile script with baseline targets

**Files:**
- Create: `scripts/build-bin.ts`
- Modify: `package.json` (add `"build:bin": "bun run ./scripts/build-bin.ts"`)
- Test: `tests/package/compiled-binary.integration.test.ts` (reuse: extend with a baseline-target case on x64 linux, or assert `compileTargetForHost("linux", "x64")` via a unit test in `tests/package/build-bin.test.ts`)

**Interfaces:**
- Consumes: nothing.
- Produces: `compileTargetForHost(platform, arch, isMuslHost?): string | null`; `dist/githunk` (or `dist/githunk.exe` on win32) after `bun run build:bin`.

- [ ] **Step 1: Write the failing test** (`tests/package/build-bin.test.ts`):

```ts
import { describe, expect, test } from "bun:test"
import { compileTargetForHost } from "../../scripts/build-bin"

describe("compileTargetForHost", () => {
  test("uses the baseline runtime on linux x64 glibc", () => {
    expect(compileTargetForHost("linux", "x64", () => false)).toBe("bun-linux-x64-baseline")
  })

  test("uses the musl baseline runtime on linux x64 musl", () => {
    expect(compileTargetForHost("linux", "x64", () => true)).toBe("bun-linux-x64-musl-baseline")
  })

  test("keeps the host runtime on arm64", () => {
    expect(compileTargetForHost("linux", "arm64")).toBeNull()
    expect(compileTargetForHost("darwin", "arm64")).toBeNull()
  })

  test("uses the baseline runtime on darwin and windows x64", () => {
    expect(compileTargetForHost("darwin", "x64")).toBe("bun-darwin-x64-baseline")
    expect(compileTargetForHost("win32", "x64")).toBe("bun-windows-x64-baseline")
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/package/build-bin.test.ts`
Expected: FAIL with "compileTargetForHost not defined" (or module-not-found).

- [ ] **Step 3: Write minimal implementation** (`scripts/build-bin.ts`, port of hunk's `scripts/build-bin.ts:15-87`): exported `compileTargetForHost` plus an `import.meta.main` block running `bun build --compile --no-compile-autoload-bunfig [--target=…] src/cli.ts --outfile dist/githunk[.exe]` with repo-local `BUN_TMPDIR`/`BUN_INSTALL`, deleting nothing else.

- [ ] **Step 4: Run tests to verify green**

Run: `bun test tests/package/build-bin.test.ts tests/package/compiled-binary.integration.test.ts && bun run build:bin && ./dist/githunk --version`
Expected: PASS; binary prints the manifest version.

- [ ] **Step 5: Commit**

```bash
git add scripts/build-bin.ts tests/package/build-bin.test.ts package.json
git commit -m "feat: add host prebuilt binary build"
```

---

### Task 3: Platform package helpers plus artifact staging

**Files:**
- Create: `scripts/prebuilt-package-helpers.ts` (matrix, manifest builders, dirs; port of hunk's `scripts/prebuilt-package-helpers.ts:35-218`, package names `@xuhaojun/githunk-*`, binary `githunk`)
- Create: `scripts/build-prebuilt-artifact.ts` (stage host `dist/githunk[.exe]` into `dist/release/artifacts/<pkg>`; `--expect-package` gate; port of hunk's `scripts/build-prebuilt-artifact.ts:43-108`, minus skills bundling)
- Create: `scripts/stage-prebuilt-npm.ts` (assemble `dist/release/npm/<meta + platforms>` from `--artifact-root` or host binary; port of hunk's `scripts/stage-prebuilt-npm.ts:77-203`; meta ships `bin/`, `dist/githunk.js` fallback, README, LICENSE)
- Modify: `package.json` (add `build:prebuilt:artifact`, `stage:prebuilt:release` scripts)
- Test: `tests/package/prebuilt-manifest.test.ts` (matrix has 5 specs; platform manifest carries `os`/`cpu`; optional-deps map pins the root version)

**Interfaces:**
- Consumes: `compileTargetForHost` (Task 2, artifact script shells to `build:bin` output only — no import).
- Produces: `PLATFORM_PACKAGE_MATRIX`, `getHostPlatformPackageSpec()`, `buildPlatformPackageManifest(root, spec)`, `buildOptionalDependencyMap(version)`, `releaseNpmDir()`, `releaseArtifactsDir()`.

- [ ] **Step 1: Write the failing test** as sketched above (assert exact 5 package names, `os`/`cpu` per spec, meta optionalDeps `{ "<pkg>": version }`).

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/package/prebuilt-manifest.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Write minimal implementation** per file list; keep hunk's shapes, drop skills/metadata extras except a minimal `metadata.json` (package name + version) per artifact.

- [ ] **Step 4: Run tests plus local staging to verify green**

Run: `bun test tests/package/prebuilt-manifest.test.ts && bun run build:bin && bun run build:prebuilt:artifact && bun run stage:prebuilt:release && find dist/release -maxdepth 3 | sort`
Expected: PASS; `dist/release/npm` holds the meta dir plus one host platform dir; `dist/release/artifacts` holds the host artifact.

- [ ] **Step 5: Commit**

```bash
git add scripts/prebuilt-package-helpers.ts scripts/build-prebuilt-artifact.ts scripts/stage-prebuilt-npm.ts tests/package/prebuilt-manifest.test.ts package.json
git commit -m "feat: stage prebuilt platform npm packages"
```

---

### Task 4: Launcher with prebuilt lookup

**Files:**
- Modify: `bin/githunk.js` (keep path/shebang; prepend `GITHUNK_BIN_PATH` override + walk-up `node_modules/<platform-pkg>/bin/githunk[.exe]` lookup; fall back to the existing `process.execPath --experimental-ffi dist` spawn; keep signal forwarding and exit-code mapping byte-for-byte)
- Test: `tests/package/launcher-prebuilt.integration.test.ts` (spawn launcher with `GITHUNK_BIN_PATH` → fake executable asserting passthrough of args/exit code; spawn with a fake `node_modules/<host-pkg>/bin/` tree asserting lookup wins; existing publish tests stay green)

**Interfaces:**
- Consumes: `PLATFORM_PACKAGE_MATRIX` package names (hardcode the 5 names + binary names in the launcher; no TS import — launcher must stay dependency-free).
- Produces: same CLI behavior on all current paths, plus prebuilt exec when installed.

- [ ] **Step 1: Write the failing test** (fake binary = shell script `echo "args:$@"; exit 7`; assert launcher exits 7 and forwards args).

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/package/launcher-prebuilt.integration.test.ts`
Expected: FAIL (fake binary never executed; real dist runs instead).

- [ ] **Step 3: Write minimal implementation** (port hunk `bin/hunk.cjs:8-41,43-73,75-95,117-126`: `run()`, `hostCandidates()`, `findInstalledBinary()`, override first, then prebuilt, then legacy spawn).

- [ ] **Step 4: Run tests to verify green**

Run: `bun test tests/package/`
Expected: PASS (2 prebuilt tests + 2 publish tests).

- [ ] **Step 5: Commit**

```bash
git add bin/githunk.js tests/package/launcher-prebuilt.integration.test.ts
git commit -m "feat: prefer prebuilt binary in launcher"
```

---

### Task 5: Release workflow plus publish scripts

**Files:**
- Create: `scripts/check-release-version.ts` (tag `vX.Y.Z` must equal `package.json` version; port hunk's script behavior: strip leading `v`, compare, non-zero exit with message)
- Create: `scripts/publish-prebuilt-npm.ts` (loop staged dirs, platform packages first, meta last, skip already-published via `npm view`, `--dry-run` + `--tag`; port hunk's `scripts/publish-prebuilt-npm.ts:55-117`)
- Create: `scripts/check-prebuilt-pack.ts` (assert staged dirs each contain package.json + payload; `npm pack --dry-run` per dir must exit 0)
- Create: `.github/workflows/release-prebuilt-npm.yml` (port hunk's, minus benchmark gate and website: 5-job matrix build → stage+verify+smoke+dry-run → publish (tag push or manual `publish=true`) → GitHub release tarballs + SHA256SUMS + attestations)
- Modify: `package.json` (add `check:prebuilt-pack`, `publish:prebuilt:npm`, `check:release-version` scripts)
- Test: manual/dry-run only — `bun run check:prebuilt-pack` and `publish:prebuilt:npm -- --dry-run --tag latest` against Task 3's local staging. No new unit test (covered by Task 3 manifest tests + workflow dry-run step).

- [ ] **Step 1: Stage locally** (`bun run stage:prebuilt:release` from Task 3 output).

- [ ] **Step 2: Implement scripts + workflow** per file list.

- [ ] **Step 3: Verify dry-run green**

Run: `bun run check:prebuilt-pack && bun run publish:prebuilt:npm -- --dry-run --tag latest`
Expected: exit 0, per-package dry-run output, meta last.

- [ ] **Step 4: Commit**

```bash
git add scripts/check-release-version.ts scripts/publish-prebuilt-npm.ts scripts/check-prebuilt-pack.ts .github/workflows/release-prebuilt-npm.yml package.json
git commit -m "feat: add prebuilt release workflow"
```

---

### Task 6: Local end-to-end verification

- [ ] **Step 1: Full local pipeline**

Run: `bun run build:bin && bun run build:prebuilt:artifact && bun run stage:prebuilt:release && bun run check:prebuilt-pack && bun run publish:prebuilt:npm -- --dry-run --tag latest`
Expected: exit 0 throughout.

- [ ] **Step 2: Staged-install smoke**

```bash
root=$(pwd); d=$(mktemp -d); cd "$d" && npm install "$root/dist/release/npm/@xuhaojun/githunk" --no-save 2>&1 | tail -2 && ./node_modules/.bin/githunk --version
```

Expected: prints the manifest version (proves the staged meta + platform package resolve and the launcher finds the prebuilt binary). Records evidence for the release checklist.

- [ ] **Step 3: Full gate**

Run: `bun run check`
Expected: typecheck + all tests pass.

- [ ] **Step 4: Report operator manual steps**

Reply with the exact click/type sequence: 5 placeholder publishes (names + versions), 6 trusted-publisher bindings (collects the frozen workflow filename), `npm` environment creation. No commit (docs updates if any go in a separate `docs:` commit).
