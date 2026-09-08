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

## Finishing a review

`validateFinishReview` reads the live set (`status !== "retired"`). Retired items
stay in the artifact as a record of what was raised but stop gating the decision,
because their anchor is often legitimately gone — the code they objected to was
deleted. Before the ledger the only exit from a moved anchor was `a` (re-anchor),
which is the wrong verb when the objection is settled; `-` is the missing one.

The gates that follow from this, all observed:

| situation | Finish |
| --- | --- |
| an `addressed` item still live | refused, `feedback-needs-reanchor` |
| that item retired with `-` | allowed |
| Approve with an `UNTOUCHED` **blocking** item live | refused, `approve-has-blocking-feedback` |
| that item retired with `-` | allowed |

The third row is the one worth keeping: you cannot approve a branch while a
blocking objection sits on lines nobody touched.

## Not built

- `githunk skill path` (the mailbox markdown carries the instructions instead)
- `unaddressed` filter scope on `f`
- the `disputed` verdict from the design conversation
