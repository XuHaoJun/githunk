# Prototype spike — open-objections ledger

Throwaway code answering one question: does the ledger *feel* right?
Not production. No unit tests of its own, no schema migration, no docs update.

## The question

An agent says "all done". Which of your objections did it actually act on?
Today nothing answers that without re-reading the whole diff.

## The mechanic

`ReviewFeedback.resolution` ("can this comment still find its lines") was never
enough on its own. The prototype adds a second axis, `status` ("has anyone been
asked to act"), and derives the verdict from the pair in
`src/review/core/ledger.ts`:

| status | resolution | verdict |
| --- | --- | --- |
| absent / `open` | any | `open` |
| `handed-off`, HEAD still at handoff | any | `waiting` |
| `handed-off` | `active` | **`untouched`** — those exact lines were not changed |
| `handed-off` | `stale` / `orphaned` | `addressed` — the code moved (NOT "is correct") |
| `retired` | any | `retired` |

`resolution` is already recomputed every generation by `reconcileAnchor`, so the
verdict costs no extra Git.

## Try it

```bash
bun run spikes/ledger/smoke.ts     # end-to-end against a real temp repo
```

In the TUI: `b` (Branch Review) → `c` on a line to leave feedback → `A` to hand
off → let an agent commit → reopen → the header and the feedback rows carry the
verdict. `-` retires the item you have looked at.

The agent reads `githunk handoff` / `githunk handoff --json`. That CLI is
read-only on purpose: an agent that could mark its own work addressed would make
`untouched` worthless.

## Not built

- `githunk skill path` (the mailbox markdown carries the instructions instead)
- `unaddressed` filter scope on `f`
- relaxing `validateFinishReview` so an orphaned handed-off item can be retired
  rather than blocking Finish
- the `disputed` verdict from the design conversation
