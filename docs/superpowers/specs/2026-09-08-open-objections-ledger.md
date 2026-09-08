# Open-objections ledger — prototype notes

Prototype on `prototype/open-objections-ledger`. Not production: no schema
migration, no parity-matrix entry, no release notes.

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
| `resolved` | any | `resolved` |

`resolution` is already recomputed every generation by `reconcileAnchor`, so the
verdict costs no extra Git.

## Try it

```bash
bun test tests/acceptance/branch-review-ledger.integration.test.ts
```

In the TUI: `b` (Branch Review) → `c` on a line to leave feedback → `A` to hand
off → let an agent commit → reopen → the header and the feedback rows carry the
verdict. `-` resolves the item you have looked at.

The agent reads `githunk handoff` / `githunk handoff --json`. That CLI is
read-only on purpose: an agent that could mark its own work addressed would make
`untouched` worthless.

## Seeing what the agent actually changed

The verdict says an objection was addressed; it does not show the change. On the
aggregate that change is buried in the whole branch, so `s` now opens its lens
from a **handoff** as well as from a finished review — whichever stamp is later.
A handoff is the sharper checkpoint of the two: it is the moment the reviewer
asked someone to change things, so `handoff..HEAD` is exactly the agent's work.
The header says `[Since handoff]` rather than `[Since last review]` when that is
what it measured from.

Observed in `smoke.ts`: with no review ever finished, the checkpoint resolves to
the handoff and the lens narrows an 8-file branch to `app.ts +1/-1`.

Note that `R` (finish) clears the feedback list — see
review-artifact-store.ts:157 — so a finished review closes the round and the
record moves into the artifact. Do not finish until the verdicts satisfy you.

## Finishing a review

`validateFinishReview` reads the live set (`status !== "resolved"`). Resolved items
stay in the artifact as a record of what was raised but stop gating the decision,
because their anchor is often legitimately gone — the code they objected to was
deleted. Before the ledger the only exit from a moved anchor was `a` (re-anchor),
which is the wrong verb when the objection is settled; `-` is the missing one.

The gates that follow from this, all observed:

| situation | Finish |
| --- | --- |
| an `addressed` item still live | refused, `feedback-needs-reanchor` |
| that item resolved with `-` | allowed |
| Approve with an `UNTOUCHED` **blocking** item live | refused, `approve-has-blocking-feedback` |
| that item resolved with `-` | allowed |

The third row is the one worth keeping: you cannot approve a branch while a
blocking objection sits on lines nobody touched.

## Not built

- `githunk skill path` (the mailbox markdown carries the instructions instead)
- `unaddressed` filter scope on `f`
- a per-objection before/after: the ledger keeps `contextDigest`, not the text,
  so it can say an anchor moved but cannot show what the line used to be
- the `disputed` verdict from the design conversation
