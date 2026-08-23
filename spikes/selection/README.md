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
