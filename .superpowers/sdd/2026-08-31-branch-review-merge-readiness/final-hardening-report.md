# Final Hardening Report

## Scope

Implemented the final hardening findings from `final-review-findings.md` on branch-review workspace commit `2a296e2`.

## Fixes

- **Persisted semantic reconciliation:** Reopening a review now forces anchor reconciliation even when the reconstructed and loaded states reference the same document object. Invalid same-content anchors are classified as stale instead of active, so Finish validation requires explicit re-anchoring. Persisted feedback, filter, viewed records, draft, and expanded gaps remain intact; line selections are dropped when they cannot be reconciled.
- **Patch fidelity:** Patch chunk splitting now removes only framing newlines and preserves trailing spaces/tabs in final hunk payload lines, retaining hunk and aggregate digest identity.
- **Range navigation:** Semantic `j`/`k` movement keeps the first range endpoint available for a subsequent `v`; starting a new `v` clears a completed pending range anchor. Added multiline range and pending-anchor regressions.
- **Screen recovery:** If review view construction fails after opening the review controller, repository root visibility and show state are restored, an error banner/render is requested, and review-controller cleanup is awaited.
- **Finish/refresh serialization:** Finish and generation refresh operations share a mutation queue. Finish snapshots and validates one immutable state, checks ownership before durable writes and final publication, and aborts if state/revision/document generation changes. Artifact-first and retry/recovery behavior remains intact.
- **Filter key routing:** Focused filter input receives printable filter characters—including layout-looking `l`, uppercase `R`, slash, and path characters—instead of workspace commands. Existing intentional `0`/`1` focus controls remain available.

## Changed files

### Source

- `src/review/core/reconcile.ts`
- `src/review/core/anchors.ts`
- `src/review/git/patch-adapter.ts`
- `src/review/storage/review-artifact-store.ts`
- `src/ui/review-workspace/controller.ts`
- `src/ui/review-workspace/ReviewWorkspaceApp.tsx`
- `src/app/screen-controller.ts`

### Tests

- `tests/ui/review-workspace/refresh.integration.test.ts`
- `tests/ui/review-workspace/finish.integration.test.ts`
- `tests/ui/review-workspace/navigation.integration.test.ts`
- `tests/review/git/patch-adapter.test.ts`
- `tests/app/screen-controller.test.ts`

## Verification

Focused behavioral suites passed:

- `bun test tests/ui/review-workspace/refresh.integration.test.ts tests/ui/review-workspace/finish.integration.test.ts tests/app/screen-controller.test.ts tests/ui/review-workspace/navigation.integration.test.ts tests/review/git/patch-adapter.test.ts tests/review/core/anchors.test.ts tests/review/storage/review-artifact-store.integration.test.ts`
  - **56 passed, 0 failed, 241 expectations**
- `bun test tests/acceptance/branch-review-workspace.integration.test.ts`
  - **4 passed, 0 failed, 82 expectations**
- `bun test tests/ui/review-workspace/navigation.integration.test.ts tests/ui/review-workspace/react-review-workspace.integration.test.tsx tests/review/core/feedback.test.ts tests/review/core/line-selection.test.ts`
  - **43 passed, 0 failed, 177 expectations**
- `bun test tests/review/git/patch-adapter.test.ts tests/review/conformance/patch-adapter.conformance.test.ts tests/domain/diff/parse.test.ts`
  - **27 passed, 0 failed, 308 expectations**
- `git diff --check`
  - **No whitespace errors**

`bunx tsc --noEmit --pretty false` remains non-zero because of the repository's existing baseline diagnostics (76 diagnostics in five files), including missing Bun test globals in `tests/ui/review-workspace/finish-dialog.test.ts`, existing `contextDigest` typing in `src/review/core/anchors.ts`, existing state-store typing, and existing refresh/header test typing. No diagnostics were reported for the changed screen-controller test after its fixes, nor for the changed controller or workspace source files.

An existing React `act(...)` warning is emitted by the finish integration suite; the suite passes and the warning predates this hardening work.
