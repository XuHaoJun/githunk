# Open-objections ledger

Branch Review's fifth githunk review extension
(`docs/lazygit-compatibility-v0.1.md` row 14a). lazygit has no counterpart: it
has no review feedback model at all.

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
| `handed-off`, answered | `active` | **`disputed`** — it argued instead of changing the lines |
| `resolved` | any | `resolved` |


### Range attribution

Mailbox ranges use inclusive, one-based source-line numbers on the diff side named
by `side` (`old` or `new`). They are source coordinates, never terminal row
indexes. `pending.json` stores `side`, `startLine`, and `endLine` as separate
fields; `pending.md` repeats the side after the path and range, for example
`src/cache.ts:2-3 (new side)`. File-level objections have no side or line range.
`resolution` is already recomputed every generation by `reconcileAnchor`, so the
verdict costs no extra Git.

## Keys

| Key | Does |
| --- | --- |
| `c` | object to the selected line (existing) |
| `A` | hand off every open objection and write the mailbox |
| `-` | resolve one you have looked at |
| `a` | re-anchor one whose code moved (existing) |
| `L` | list objections, `j`/`k` to move, Enter to jump |
| `s` | narrow to what changed since the last handoff or finished review |

`H` and `x` are reserved for lazygit parity (main-scroll-left, extension panes)
and `l` cycles the layout, which is why the two new keys are `A` and `-`.

## Tests

| File | Pins |
| --- | --- |
| `tests/review/core/ledger.test.ts` | the verdict truth table, checkpoint selection, mailbox contract, reply parsing |
| `tests/review/core/reducer.test.ts` | handoff stamping, re-handoff keeping the original checkpoint, resolve being terminal |
| `tests/review/storage/schemas.test.ts` | round-tripping status/handoff/excerpt, the legacy status name, the excerpt cap |
| `tests/cli/args.test.ts` | that no CLI verb writes a verdict |
| `tests/acceptance/branch-review-ledger.integration.test.ts` | the loop against a real repository, across a restart |
| `tests/ui/review-workspace/react-review-workspace.integration.test.tsx` | the `L` list, the jump landing on the objection, the finish dialog reporting a failed submit |

In the TUI: `b` (Branch Review) → `c` on a line to leave feedback → `A` to hand
off → let an agent commit → reopen → the header and the feedback rows carry the
verdict. `-` resolves the item you have looked at.

The agent reads `githunk handoff` / `githunk handoff --json`. That CLI is
read-only on purpose: an agent that could mark its own work addressed would make
`untouched` worthless.

## When the agent disagrees

The rule is not "the agent cannot write" — it is **the agent cannot write the
verdict**. Words are its own, status and resolution are not. So replies live in
a second file the agent owns:

```
.git/githunk/handoff/pending.json   githunk writes · agent reads
.git/githunk/handoff/replies.json   agent writes   · githunk reads
```

Separate owners, so neither needs a lock. `githunk handoff reply --id <id>
--body <text>` appends one; githunk reads them with the document and renders
each under its objection, and the mailbox markdown tells the agent the command.

A reply settles nothing. An answered objection whose anchored lines are
unchanged reads `disputed` rather than `untouched`: it means the agent argued
rather than complied, which is the one outcome that needs the reviewer to read
instead of merely look. An objection whose code did change stays `addressed`
whether or not it was answered.

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
- an `unaddressed` filter scope on `f`
- agent-driven navigation and highlighting. Both need a live connection to a
  running window — hunk spends roughly 10,650 lines on that daemon and its own
  guide documents debugging an agent sandbox that blocks the port — and both
  only mean anything while the reviewer is present, which is the premise this
  ledger gives up on purpose.
