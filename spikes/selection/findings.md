# OpenTUI Selection Spike Findings

**Date:** 2026-08-24  
**Framework under test:** `@opentui/core` 0.5.6 (exactly pinned)

## Scope and method

This disposable, fixture-only spike evaluates the PRD §16 selection gate; it does not execute Git. Evidence is intentionally separated into:

1. **Structural/code evidence:** renderable hierarchy, selection and splitter handlers, deterministic fixtures, and clipboard policy.
2. **Automated evidence:** 9 fixture/layout/clipboard tests passed, and TypeScript type-checking completed cleanly.
3. **PTY-observed behavior:** at 120×40, OpenTUI rendered isolated LEFT and PATCH panes, CJK, emoji, decomposed `e` + combining accent, tabs, blank lines, the long wrapped source line, and multiple hunks. An injected SGR drag wholly inside PATCH completed a selection and displayed exactly `OSC52 emitted 246 bytes`. An injected splitter drag resized LEFT from about 30 to about 40 columns and did not trigger selection, but OpenTUI capture was established only after the first drag sample landed inside the one-cell splitter.
4. **User-observed behavior:** a real SSH+zellij run confirmed that dragging inside PATCH does not visibly select LEFT, the copied payload contains no LEFT text, scrolling downward and then dragging still copies correctly, and terminal resize remains usable. This covers the user's actual remote-development workflow.
5. **Compatibility boundary:** local, SSH without a multiplexer, and tmux were not tested. The user explicitly accepts SSH+zellij as the v0.1 compatibility floor.

The primary pane-isolation, scrolled-copy, resize, vertical-splitter, and SSH+zellij clipboard hypotheses pass for the user's v0.1 workflow. Exact partial endpoints, exhaustive wrapped/Unicode boundary cases, and other terminal/multiplexer combinations remain follow-up compatibility work rather than v0.1 framework blockers.

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

Results below distinguish the accepted v0.1 compatibility floor from broader untested environments.

| PRD criterion / gate | Result | Evidence |
|---|---|---|
| S1 — Basic pane isolation | PASS | LEFT is a separate non-selectable renderable, PATCH is selectable, the PTY drag completed wholly inside PATCH, and the user's real manual run confirmed that PATCH dragging does not visibly select LEFT. Exact client-pasted content remains tracked separately under S3 and S10–S12. |
| S2 — Partial first/last lines | NOT RUN | No exact mid-line endpoint selection or logical-character-boundary comparison was performed. |
| S3 — Adjacent pane contamination | PASS | The dense LEFT fixture and separate renderable branches were exercised manually; the user confirmed the copied PATCH payload contains no LEFT text. |
| S4 — Scrolling | PASS | The user scrolled PATCH downward, continued dragging, and confirmed copying remained correct. |
| S5 — Wrapped lines | PARTIAL | The long source line visibly wrapped at 120×40. Its copied logical text and a mid-wrapped-line boundary were not compared exactly. |
| S6 — Unicode | PARTIAL | CJK, emoji, a wide-character case, and decomposed `e` + combining accent rendered. Exact selected/pasted Unicode content was not checked for corruption or boundary errors. |
| S7 — Terminal resize | PASS | The user exercised resize in the target workflow and reported normal behavior. |
| S8 — Vertical splitter | PASS | PTY injection resized LEFT from about 30 to about 40 columns and did not trigger selection. The first sample must land within the one-cell splitter to establish OpenTUI drag capture. |
| S9 — Command-log splitter | NOT IMPLEMENTED | The spike has no Main/Command Log region or horizontal splitter, so vertical region resizing was not exercised. |
| S10 — OSC52 local | NOT RUN | No local-terminal run or client-machine paste check occurred. |
| S11 — SSH | PASS FOR V0.1 FLOOR | Selection and clipboard behavior passed in the accepted SSH+zellij workflow. SSH without a multiplexer remains untested and is not part of the initial compatibility floor. |
| S12 — tmux / zellij | PASS FOR ZELLIJ | SSH+zellij covers the accepted v0.1 workflow. tmux remains untested and must not be advertised as supported. |

## Compatibility observations

| Environment | Selection | OSC52 | Client clipboard acceptance | Required configuration |
|---|---|---|---|---|
| Local | NOT RUN | NOT RUN | NOT RUN | Not established |
| SSH, no multiplexer | NOT RUN | NOT RUN | NOT RUN | Not established |
| SSH + tmux | NOT RUN | NOT RUN | NOT RUN | Not established |
| SSH + zellij | PASS — pane-isolated selection and scrolled dragging confirmed | PASS — OpenTUI emitted OSC52 | PASS — user confirmed copied content is correct and excludes LEFT | Existing user environment; exact terminal/zellij settings not captured |

## Limitations

- OSC52 emission alone has no terminal-side acknowledgement, but the user's successful SSH+zellij paste supplies end-to-end evidence for the accepted v0.1 environment.
- Exact partial first/last-line boundaries and exhaustive wrapped/Unicode clipboard cases remain unrecorded.
- Local execution, SSH-only execution, and tmux remain untested and must not be advertised as supported compatibility.
- The one-cell vertical splitter works in both PTY injection and the user's workflow; broader splitter ergonomics remain v0.1 implementation work.
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

`ACCEPT_WITH_WORKAROUND`

Proceed with OpenTUI 0.5.6 for v0.1. The release-blocking product hypothesis—application-aware PATCH selection that does not contaminate copied text with the adjacent pane—passes in the user's real SSH+zellij workflow. Scrolled copying, terminal resize, OSC52 delivery, and the vertical splitter also cover that workflow.

The bounded workaround is explicit:

- use selectable plain `TextRenderable` until a supported selectable diff presentation supplies line numbers and syntax highlighting;
- document SSH+zellij as the initial confirmed remote compatibility floor;
- do not advertise local, SSH-only, or tmux clipboard compatibility until tested;
- keep exact partial-line, wrapped-line, and Unicode boundary cases in the v0.1 regression matrix.

S9 remains a separate implementation item: this spike contains only the LEFT/PATCH vertical splitter and has no Main/Command Log region. A reported “command-log splitter” observation cannot originate from the current spike code; if that observation refers to the LEFT/PATCH divider, it is already covered by S8.

## v0.1 follow-up checks

- [ ] Add regression coverage for exact partial first/last-line selection.
- [ ] Record exact wrapped-line and Unicode clipboard comparisons.
- [ ] Implement and verify the horizontal Main/Command Log splitter.
- [ ] Add line numbers and syntax highlighting through a selectable presentation, or revise that presentation requirement.
- [ ] Test and document additional terminal/multiplexer combinations before advertising support.
- [ ] Pin a compatible TypeScript toolchain if the peer-dependency warning recurs.

If pane isolation, logical wrapping, Unicode, scrolling, resize, or remote clipboard later regresses, reproduce it against the pinned OpenTUI version before changing frameworks.