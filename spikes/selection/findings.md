# OpenTUI Selection Spike Findings

**Date:** 2026-08-24  
**Framework under test:** `@opentui/core` 0.5.6 (exactly pinned)

## Scope and method

This disposable, fixture-only spike evaluates the PRD §16 selection gate; it does not execute Git. Evidence is intentionally separated into:

1. **Structural/code evidence:** renderable hierarchy, selection and splitter handlers, deterministic fixtures, and clipboard policy.
2. **Automated evidence:** 9 fixture/layout/clipboard tests passed, and TypeScript type-checking completed cleanly.
3. **PTY-observed behavior:** at 120×40, OpenTUI rendered isolated LEFT and PATCH panes, CJK, emoji, decomposed `e` + combining accent, tabs, blank lines, the long wrapped source line, and multiple hunks. An injected SGR drag wholly inside PATCH completed a selection and displayed exactly `OSC52 emitted 246 bytes`. An injected splitter drag resized LEFT from about 30 to about 40 columns and did not trigger selection, but OpenTUI capture was established only after the first drag sample landed inside the one-cell splitter.
4. **User-observed behavior:** a real manual run confirmed that dragging inside PATCH does not visibly select LEFT. This confirms the primary visual pane-isolation hypothesis.
5. **Client clipboard acceptance:** not observed in recorded evidence. OSC52 emission is not proof that a terminal or multiplexer accepted the operation, and no exact paste result is claimed.

The PTY run plus the user's manual run confirm visible pane isolation. They do not complete the remaining manual stress and compatibility matrices. Local, SSH without a multiplexer, tmux, terminal resize, scrolling, exact partial endpoints, and exact Unicode/wrapped clipboard-content comparisons were not recorded.

## Environment

| Field | Observed value |
|---|---|
| `TERM` | `xterm-256color` |
| SSH | `true` |
| tmux | `false` |
| zellij | `true` |
| PTY size | `120×40` |
| Client terminal/version | Not captured |
| Client OSC52 settings | Not captured |

This is one SSH+zellij observation only. It must not be generalized to local, SSH-only, or tmux environments.

## Automated evidence

| Check | Result | Evidence boundary |
|---|---|---|
| Fixture/layout/clipboard suite | PASS | 9 tests passed. The tests cover hostile fixture presence, layout clamps, OSC52 policy states, and UTF-8 byte counting; they do not exercise terminal selection mapping or client paste. |
| TypeScript | PASS | Type-check completed cleanly. This establishes type compatibility, not runtime behavior. |
| Framework pin | PASS | `package.json` pins `@opentui/core` exactly to `0.5.6`. |
| Dependency installation | PARTIAL | Installation completed, but `bun install` warned that the plan-requested `typescript: latest` resolved to 7.0.2 with an incorrect peer dependency. |
| Diff presentation | PARTIAL | OpenTUI 0.5.6 has no bundled diff parser. PATCH therefore uses a selectable plain `TextRenderable`; PRD fixture line numbers and syntax highlighting were not exercised. |

## Release-blocking gates and S1–S12

No PARTIAL result is treated as a pass.

| PRD criterion / gate | Result | Evidence |
|---|---|---|
| S1 — Basic pane isolation | PASS | LEFT is a separate non-selectable renderable, PATCH is selectable, the PTY drag completed wholly inside PATCH, and the user's real manual run confirmed that PATCH dragging does not visibly select LEFT. Exact client-pasted content remains tracked separately under S3 and S10–S12. |
| S2 — Partial first/last lines | NOT RUN | No exact mid-line endpoint selection or logical-character-boundary comparison was performed. |
| S3 — Adjacent pane contamination | PARTIAL | LEFT and PATCH are separate renderable branches, LEFT is dense and non-selectable, and the PTY showed isolated panes. Zero left-pane text in actual clipboard output was not verified. |
| S4 — Scrolling | NOT RUN | The PATCH scroll box exists, but no scrolled selection was compared with underlying logical lines. |
| S5 — Wrapped lines | PARTIAL | The long source line visibly wrapped at 120×40. Its copied logical text and a mid-wrapped-line boundary were not compared exactly. |
| S6 — Unicode | PARTIAL | CJK, emoji, a wide-character case, and decomposed `e` + combining accent rendered. Exact selected/pasted Unicode content was not checked for corruption or boundary errors. |
| S7 — Terminal resize | NOT RUN | No selection mapping check was performed after or during terminal resize. |
| S8 — Vertical splitter | PASS | PTY injection resized LEFT from about 30 to about 40 columns and did not trigger selection. The first sample must land within the one-cell splitter to establish OpenTUI drag capture. |
| S9 — Command-log splitter | NOT IMPLEMENTED | The spike has no Main/Command Log region or horizontal splitter, so vertical region resizing was not exercised. |
| S10 — OSC52 local | NOT RUN | No local-terminal run or client-machine paste check occurred. |
| S11 — SSH | PARTIAL | The observed process ran over SSH inside zellij and reported `OSC52 emitted 246 bytes`; no SSH-only run and no client clipboard paste were observed. |
| S12 — tmux / zellij | PARTIAL | One SSH+zellij PTY observation emitted OSC52. tmux was not run, zellij client acceptance was not observed, and required configuration for either multiplexer was not established. |

## Compatibility observations

| Environment | Selection | OSC52 | Client clipboard acceptance | Required configuration |
|---|---|---|---|---|
| Local | NOT RUN | NOT RUN | NOT RUN | Not established |
| SSH, no multiplexer | NOT RUN | NOT RUN | NOT RUN | Not established |
| SSH + tmux | NOT RUN | NOT RUN | NOT RUN | Not established |
| SSH + zellij | PARTIAL — pane rendering and injected PATCH drag observed; exact selected text not captured | PARTIAL — OpenTUI reported emission of 246 bytes | NOT RUN — no client paste was observable | Not established; terminal/version and OSC52 policy were not captured |

## Limitations

- The emission status proves only that OpenTUI's OSC52 path returned success and reported a UTF-8 byte count. OSC52 has no terminal-side acknowledgement here.
- The exact selected 246-byte payload was not independently captured, so it cannot prove pane isolation, logical wrapping, Unicode correctness, or partial endpoint correctness.
- The PTY evidence does not cover scroll offsets, terminal resize, local execution, SSH-only execution, tmux, or confirmed zellij clipboard delivery.
- The splitter observation depends on beginning capture inside a one-cell target; this is documented behavior to retest, not evidence of a selection defect.
- Plain selectable text preserved the interaction experiment, but did not exercise PRD-required fixture line numbers or syntax highlighting.
- The available evidence does not include an exact replay transcript for the injected SGR coordinates; the repeatable manual procedure below is therefore authoritative for reconsideration.

## Exact repro commands

From the repository root:

```bash
bun install
bun test
bunx tsc --noEmit
bun run spike:selection
```

Capture the runtime environment before OpenTUI takes over the terminal:

```bash
GITHUNK_SPIKE_ENV=1 bun run spike:selection 2> /tmp/githunk-spike-env.json
cat /tmp/githunk-spike-env.json
```

For each available environment—local, SSH without a multiplexer, SSH+tmux, and SSH+zellij—run `bun run spike:selection` in a 120×40 terminal and again after narrowing PATCH until the long line wraps. Follow the repository procedure exactly:

1. Select five PATCH lines including `GITHUNK_PATCH_ONLY_ALPHA`; paste on the client and record the exact text. It must contain no `M src/` text.
2. Repeat with mid-line start/end points and compare exact logical boundaries.
3. Scroll PATCH, select visible content, and compare it with the fixture's underlying lines.
4. Select across the long wrapped line and verify one reconstructed logical source line.
5. Select CJK, emoji, decomposed `e` + combining accent, a tab-indented line, and multiline Unicode; compare exact pasted bytes/text.
6. Resize the terminal narrower and wider, then repeat selection; also resize during ordinary use.
7. Begin a drag inside the one-cell vertical splitter and verify resize without selection; begin one cell inside PATCH and verify selection without resize.
8. After a horizontal Main/Command Log splitter exists, drag it and verify vertical resize independently of PATCH selection.
9. For OSC52 cases, record both the on-screen emission/block status and the client paste result, terminal name/version, dimensions, multiplexer version, and every required OSC52 setting.

## Decision

`REJECT_OPENTUI`

This is a no-go for the complete current technology gate because several release-blocking requirements remain unverified: exact copied payload boundaries, scrolling, wrapping, Unicode, terminal resize, S9, and client clipboard delivery. It is **not** a failure of the primary pane-isolation hypothesis: the user's real manual run confirms that dragging in PATCH does not visibly select LEFT. No OpenTUI core defect has been demonstrated. The evidence supports continuing with OpenTUI experiments, but not yet declaring the full PRD gate complete.

## Bounded reconsideration checklist

Reconsider OpenTUI 0.5.6 only after all of the following are attached as reproducible evidence:

- [ ] S1–S7 pass with exact selected-versus-pasted text at wide and wrapped widths, including dense adjacent LEFT rows, partial endpoints, scrolling, Unicode, tabs, and terminal resize.
- [ ] S8 passes repeatedly from documented splitter coordinates without selection, and PATCH-origin drags never resize.
- [ ] S9 is implemented and its horizontal splitter passes independently of PATCH selection.
- [ ] S10 passes in at least one named/versioned compatible local terminal with exact client paste evidence and documented OSC52 settings.
- [ ] S11 passes over SSH without a multiplexer in a documented client terminal, including exact multiline CJK+emoji paste evidence.
- [ ] S12 records confirmed client clipboard behavior and exact required configuration for both tmux and zellij; unsupported combinations are explicitly bounded.
- [ ] Fixture line numbers and syntax highlighting are exercised through a supported selectable diff presentation, or the product requirement is explicitly revised before framework acceptance.
- [ ] The TypeScript 7.0.2 peer-dependency warning is resolved with a compatible pinned toolchain, and the 9 automated tests plus clean type-check remain reproducible.

If any pane isolation, logical wrapping, Unicode, scrolling, resize, or remote clipboard requirement then fails, reproduce the failure against current OpenTUI behavior before concluding that the architecture itself is unsuitable.