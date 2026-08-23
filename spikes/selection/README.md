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

## Core manual acceptance

1. Run the spike at >= 100 columns.
2. Drag from the middle of one patch line through at least five patch rows.
3. Confirm the visible selection never highlights the left file list.
4. Confirm copied text contains `GITHUNK_PATCH_ONLY_ALPHA` when selected and contains no `M src/` file-list text.
5. Scroll the patch and repeat.
6. Narrow the right pane until the long source line wraps and repeat.

## Stress matrix

Run:

```bash
bun run spike:selection
```

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

### Manual evidence

For each run, record the case ID, terminal name and version, terminal dimensions, and exact selected/pasted text. Compare the observation with the expected outcome above. Capture every mismatch with the same details; do not mark a case as matching unless it was manually exercised.

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
