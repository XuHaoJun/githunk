---
name: githunk-release
description: Use when a user asks to release a githunk version, bump package.json, create or push a v<version> tag, or investigate a tagged release.
---

# githunk release

`release <version>` is the canonical trigger for an end-to-end public release. It bumps the root package version, creates the release commit and matching tag, pushes them in order, and verifies the tag-triggered GitHub Actions run. Do not interpret `publish <version>` as this workflow; `publish` is reserved for an explicitly requested npm-only operation.

## Safety invariants

- Never force-push, move, delete, or recreate an existing release tag.
- Never reuse a version that exists on npm. Treat an npm auth or network error as unknown, not as absence.
- Never release from a dirty or ambiguous checkout. Do not stage only `package.json` to hide unrelated changes.
- Never bypass a failed check because of a deadline, a previous green commit, or a claim that the failure is unrelated.
- Never claim publication until the exact tag-triggered workflow succeeds.
- Do not discard user changes. If the checkout is not clean, stop and report the blocking paths.
- Get explicit confirmation immediately before creating the release commit, tag, and pushing them. A version request authorizes preparation; it does not silently authorize an irreversible public tag push.

Any preflight blocker ends the release attempt. Do not continue to local gates, edit the version,
ask for push confirmation, or reinterpret the blocker as a warning.

## 1. Parse the request

Accept only the canonical form `release <version>` for this workflow. Read the target version from `package.json` conventions and compare it semver-aware with the current version; reject malformed versions and targets that are not newer.

Derive the tag exactly as `v<version>`:

- `0.3.4` → stable npm `latest` and GitHub Latest.
- `0.3.4-beta.1`, `0.3.4-alpha.1`, or `0.3.4-rc.1` → npm `beta`, not GitHub Latest.

The root package and all five platform packages share the release version:

```text
@xuhaojun/githunk
@xuhaojun/githunk-linux-arm64
@xuhaojun/githunk-linux-x64
@xuhaojun/githunk-windows-x64
@xuhaojun/githunk-darwin-x64
@xuhaojun/githunk-darwin-arm64
```

## 2. Read-only preflight

Run the preflight before editing or staging anything:

1. Confirm the repository root, current branch, and upstream. The normal release branch is `main`; stop on another branch unless the user explicitly names a release branch.
2. Fetch current tags and the release branch without changing the worktree:

   ```bash
   git fetch origin <branch> --tags --prune
   ```

3. Require a clean checkout, including untracked files:

   ```bash
   git status --porcelain --untracked-files=all
   ```

   Any output is a blocker. Preserve those changes; do not stash, reset, clean, or overwrite them automatically.

4. Confirm the local branch tip matches its upstream tip. If the remote advanced or the checkout contains unpublished commits, stop and report it.
5. Read the current version from the root `package.json`; do not copy a version from documentation. `bun.lock` does not need a root-version change.
6. Confirm `v<version>` is absent both locally and on `origin`. Any existing local or remote tag is a blocker, regardless of whether npm contains the version.
7. Query npm for every package listed above. A version result means the target is already used and is a blocker. Treat only an explicit not-found response such as `E404` as absence; an exit code alone is insufficient. Authentication, DNS, timeout, or other inconclusive errors are blockers.

## 3. Prepare and verify locally

If the user already reports that `bun run check` failed, stop immediately before editing the
version. Do not run the known failing command again.

Otherwise, before changing `package.json`, run the baseline project gate from the clean checkout:

```bash
bun run check
```

If this baseline run fails, stop before editing the version. Do not treat the failure as merely
unverified.

After the baseline gate passes, change only `package.json`'s `version` field. Do not change
dependencies, generated files, `bun.lock`, release notes, or unrelated user files.

Run the prepared-version gates in this order:

```bash
bun run check
bun run build
bun run build:bin
bun run ./scripts/stage-prebuilt-npm.ts
bun run check:prebuilt-pack
bun run smoke:prebuilt-install
bun run publish:prebuilt:npm -- --dry-run --tag <latest-or-beta>
bun run check:release-version v<version>
```

The local staging path verifies the host platform. The tag-triggered GitHub Actions workflow remains authoritative for all five platform binaries, QEMU x64 compatibility, trusted npm publishing, attestations, and the GitHub Release.

Inspect the prepared change before any commit:

```bash
git diff --check
git diff --name-only
git diff -- package.json
```

The only changed tracked path must be `package.json`, and the diff must contain only the intended version change. Use the existing commit convention:

```text
docs: release v<version>
```

Present the user with the target version, tag, branch, base commit, changed path, gate results, npm channel, and exact commit message. Wait for explicit confirmation before continuing.

If the user declines or preparation fails, restore the old `package.json` version and leave unrelated files untouched. Do not create a commit or tag.

## 4. Commit, tag, and push

Immediately after confirmation, re-check the checkout, package version, target tag absence, and prepared base commit. If any value changed, stop and prepare again.

Commit only the version bump:

```bash
git add -- package.json
git commit -m "docs: release v<version>"
git show --stat --oneline HEAD
git show --format= -- package.json
```

Create an annotated tag at that commit:

```bash
git tag -a "v<version>" -m "v<version>"
```

Push the commit first, then only this exact tag:

```bash
git push origin HEAD:<branch>
git push origin "v<version>"
```

Never use `git push --tags`, `--force`, tag deletion, or tag replacement. If the commit push succeeds but the tag push fails, keep the commit and retry only the unchanged tag after diagnosing the failure. Do not amend or create a second tag.

## 5. Verify the tagged release

The tag push triggers `.github/workflows/release-prebuilt-npm.yml`. Find the run by the exact tagged commit; never select an unrelated run:

```bash
release_sha=$(git rev-parse "v<version>^{}")
gh run list --workflow release-prebuilt-npm.yml --event push --commit "$release_sha" --limit 1
gh run watch <run-id> --exit-status
```

If the first lookup is empty, wait briefly and repeat the same exact-commit lookup; never guess from the newest workflow run. Propagate the watched run's failure. A successful release requires the build matrix, staged-package check, install smoke test, npm publication, attestations, and GitHub Release jobs to pass.

After the workflow succeeds, verify the root package, all five platform packages, npm dist-tag, and GitHub Release. If a workflow or npm query fails, report the exact failure and do not move the tag or blindly retry publication. Inventory any partially published packages before recovery.

## Required report

Use this structure and keep evidence levels distinct:

```text
Status: released | blocked | workflow pending
Version: <version>
Tag: v<version>
Commit: <sha>
Automated: <checks and exact workflow result>
Manual smoke observed: <only real observations>
Not tested: <remaining checks>
Links: <workflow and GitHub Release URLs, when available>
```

## Common mistakes

- Using `publish <version>` for the full release instead of `release <version>`.
- Staging only `package.json` while unrelated tracked or untracked files are present.
- Treating a failed `bun run check` or an npm network error as harmless.
- Using `release:` or `chore:` when the repository's current release commit convention is `docs: release v<version>`.
- Editing `bun.lock` for the root package version.
- Pushing a broad tag set or force-updating a tag.
- Reporting npm publication immediately after pushing the tag instead of waiting for the exact workflow run.
