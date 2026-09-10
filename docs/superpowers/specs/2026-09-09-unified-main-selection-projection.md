# Unified main-pane selection projection — design

Date: 2026-09-09
Branch: `fix/copy-virtual-commit-preamble`
Status: approved design; implementation planned

## Goal

Make main-pane selection deterministic for commit previews and every other content source. A mouse drag must resolve against the exact text buffer the user selected, then produce one semantic selection consumed by copy, stage and discard. Eager and virtual rendering must not maintain competing selection interpretations.

The reported failure is panel 4 commit selection followed by a drag over the diff: copying rejects the selection while selecting the commit ID succeeds. The existing implementation can make both simple eager and simple virtual drags work, but correctness depends on which of three states happens to survive: OpenTUI's native range, the virtual pane's raw pointer range, or the keyboard line range. That conditional ownership is the defect.

Out of scope: changing copy-mode semantics, changing OSC52 delivery, changing line-range keybindings, changing diff rendering, adding dependencies, or changing the documented lazygit compatibility status.

## Current failure model

`RootView.copyMainMode()` currently chooses among:

1. `VirtualMainPane.rawSelection`, created independently from mouse row/column coordinates;
2. `MainDiffLineSelection`, created by keyboard line-range actions;
3. OpenTUI's native selection range, resolved later against a reconstructed diff/preamble string.

The first non-empty state wins. A virtual mouse drag also causes OpenTUI to maintain a native selection over the bounded text buffer. If virtual raw mapping fails, is cleared, or does not describe the selected region, copy falls through to that native range. The fallback then has to guess whether the offsets belong to UTF-16 or UTF-8, an eager full document or a bounded virtual window, and a preamble or diff body. `displayPrefix`, `nativeCopySource()` and conditional source ordering encode those guesses.

This violates one invariant: the offsets and the text used to interpret them must come from the same rendered buffer generation.

## Chosen architecture

### Exact render projection

Every installed main-pane buffer has one immutable projection:

```ts
export type MainSelectionProjection = {
  readonly generation: number
  readonly document?: DiffDocument
  readonly text: string
  readonly segments: readonly MainSelectionProjectionSegment[]
}

export type MainSelectionProjectionSegment =
  | {
      readonly kind: "document"
      readonly displayStartUtf16: number
      readonly displayEndUtf16: number
      readonly rawStartUtf16: number
      readonly rawEndUtf16: number
      readonly lineIndex: number
    }
  | {
      readonly kind: "text"
      readonly displayStartUtf16: number
      readonly displayEndUtf16: number
    }
  | {
      readonly kind: "decoration"
      readonly displayStartUtf16: number
      readonly displayEndUtf16: number
    }
```

`text` is byte-for-byte the plain string installed in the active `TextRenderable` buffer. Segment offsets are UTF-16 indexes into that exact string.

Segment meanings:

- `document`: visible characters backed by a contiguous raw `DiffDocument` range;
- `text`: copy-ready preamble, ANSI-stripped output or plain output;
- `decoration`: line-number gutters and virtual row padding. Decorations participate in native range validation but do not widen a raw document range.

Newlines backed by `DiffLine.raw` belong to `document`. Synthetic newlines introduced only to join a preamble or bounded virtual rows are `text` or `decoration` according to the adjacent region. Segments form an ordered, non-overlapping partition of `text`; every UTF-16 code unit belongs to exactly one segment.

### Projection ownership

Projection construction lives beside rendering because only the renderer knows the exact installed buffer.

- Eager diff: `installDiffText` receives normalized preamble plus `renderDiff(document).displayText`; its projection contains text segments for the preamble, document segments copied from `RenderedDiff.segments`, and decoration segments for uncovered gutters.
- Virtual diff: each `renderWindow()` builds a projection for that bounded window only. It uses the same padded rows and newlines passed to `installDiffText`; document segments are derived from each `VirtualDiffRow` and its `rawStartUtf16`/`rawEndUtf16` values. Overscan rows are included because they are present in the native buffer.
- ANSI content: the exact normalized preamble and ANSI-stripped body are text segments.
- Plain content and placeholders: the installed plain string is one text segment.

`main-pane.ts` stores the active projection in the same lifecycle as `installedContents`. Reinstall, resize-driven virtual re-render, source change and too-small placeholder replacement publish a new generation atomically with the buffer text. Copy never reconstructs a source from `MainPaneContent`.

### Native range resolution

One pure resolver accepts only a projection, the OpenTUI native range and `getSelectedText()`:

```ts
resolveMainSelection(
  projection: MainSelectionProjection,
  nativeRange: NativeSelectionRange,
  selectedText: string,
): MainSelection
```

It tries the reported offsets as UTF-16 and as UTF-8 boundaries against `projection.text`. A candidate is accepted only when slicing the projection yields exactly `selectedText`. There is no second full-document or raw-document candidate.

The accepted display range resolves as follows:

- overlap with one or more document segments and no text segment: map the minimum and maximum overlapping raw offsets to `DocumentSelection`; decoration overlap is ignored;
- overlap with a text segment: return a text selection containing the exact selected string; this includes a range crossing from preamble into the diff for `text` mode;
- decoration only, invalid boundaries, stale generation or text mismatch: return an invalid selection.

```ts
export type MainSelection =
  | { readonly valid: true; readonly kind: "document"; readonly selection: DocumentSelection }
  | { readonly valid: true; readonly kind: "text"; readonly text: string }
  | { readonly valid: false; readonly reason: "native/display selection mismatch" }
```

### Single semantic state

The pane stores at most one semantic selection, tagged with the projection generation that produced it:

```ts
type StoredMainSelection = {
  readonly projectionGeneration: number
  readonly value: MainSelection
}
```

- Mouse drag/up: OpenTUI updates the visual native range first; `RootView` resolves it through the active projection and stores the result.
- Keyboard line range: store a document selection directly and paint it through the existing line-range path.
- A source replacement clears every stored selection.
- A projection generation change clears text and invalid selections.
- A valid document selection may survive a virtual window generation change only when the projection still references the same `DiffDocument`; the pane retags it with the new generation and repaints the visible overlap from its raw offsets.
- A text selection never survives a generation change because its offsets and content belong to one exact buffer.
- A zero-length click clears the semantic mouse selection and leaves cursor fallback behavior unchanged.

Copy, stage and discard consume a stored selection only when its generation equals the active projection. They do not call `getSelection()` independently and do not choose among pointer/native states at action time.

### Copy-mode behavior

- `text` + document selection: preserve the current raw document slice behavior.
- `text` + text selection: copy the selected visible text exactly.
- `added`, `removed` and `patch`: require a document selection; a text selection is rejected.
- `hunk` and `file`: retain cursor-target fallback when there is no active document selection. A text selection is rejected rather than silently selecting the cursor's hunk or file.
- Empty and invalid selections produce `No text selected` or the existing rejection title without emitting OSC52.

### Stage and discard behavior

`mainChangeSelection()` consumes the same document selection used by copy. Text and invalid selections do not select diff lines. Keyboard line ranges and cursor fallback retain their existing precedence only when no active semantic mouse selection exists.

This guarantees that Ctrl+O, stage selected lines and discard selected lines agree about what the mouse selected.

## Clean cutover

The implementation removes the competing paths rather than preserving aliases:

- remove `RenderableCopySource.displayPrefix` and source reconstruction in `getMainPaneCopySource()`;
- remove `VirtualMainPane.nativeCopySource()`;
- remove copy-time calls that independently inspect `getMainPointerSelection()` and `pane.text.getSelection()`;
- replace virtual-only screen-coordinate selection ownership with projection resolution;
- retain only raw document selection state needed to preserve a document selection across virtual scrolls;
- migrate `mainChangeSelection()` and `copyMainMode()` together;
- delete tests that directly call `TextRenderable.setSelection()` to simulate an end-user drag when a renderer mouse gesture can exercise the contract.

No compatibility shim, deprecated export or fallback source remains.

## Tests

Tests use `createShellHarness` and real `MockMouse.drag` events.

Required behavioral cases:

1. panel 4, eager commit preview: drag one diff substring and copy it;
2. panel 4, eager commit preview: drag across two diff lines and copy the corresponding raw range;
3. panel 4, virtual commit preview: scroll into the diff, drag a substring and copy it;
4. panel 4, virtual commit preview: select commit-ID text at the top and text in a scrolled tall preamble;
5. virtual diff document selection survives a window change and still copies the same raw range;
6. a preamble/diff boundary selection works only for `text`; document-only modes reject it;
7. UTF-8 text before the selected region and wide/combining characters inside it resolve against the exact projection;
8. stage/discard line derivation and text copy consume the same resolved document selection.

Each regression test asserts the clipboard payload or selected changed-line indexes, not internal projection field copies. Unit tests cover projection resolution boundaries and UTF conversion; integration tests cover real mouse routing and virtual window generation.

Verification gates:

```bash
bun test tests/domain/diff/selection.test.ts
bun test tests/ui/main-diff.integration.test.ts
bun test tests/ui/branch-preview.integration.test.ts
bun run check
```

## Risks and controls

- **Projection drift:** renderer and projection must be produced by the same function call from the same strings. Tests compare real mouse selection results, not separately reconstructed expected display offsets.
- **Virtual performance:** projection size is bounded by the current virtual window, not the full diff. Segment creation is linear in bounded rows and must reuse existing row metadata.
- **Wide characters:** native range normalization validates against the exact buffer string before semantic mapping; raw mapping uses UTF-16 offsets while row hit-testing continues to use display-cell widths.
- **Stale state:** every projection has a monotonically increasing generation. A selection from another generation is never consumed.
- **Behavioral cutover:** copy and mutation callers migrate in the same change so no action retains the old priority ladder.

## Documentation and delivery

This is a correctness repair inside githunk's existing main-pane selection/copy review extension. `docs/lazygit-compatibility-v0.1.md` remains unchanged because the feature classification and claimed compatibility status do not change.

Implementation lands as one `fix:` commit after focused tests and `bun run check` pass. The commit body records that selection offsets are now resolved against the exact installed projection; no lazygit citation is required because this repairs a githunk review extension rather than parity behavior.
