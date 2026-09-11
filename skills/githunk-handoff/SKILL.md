---
name: githunk-handoff
description: Use when a human reviewer asks an agent to handle githunk open objections, review handoff feedback, or respond to disputed Branch Review comments.
---

# Githunk Handoff

## Overview

Treat the handoff as the human reviewer's durable work queue. Change code or record a disagreement; never decide that an objection is resolved.

## Workflow

1. From the repository being reviewed, read the canonical mailbox through the CLI:

   ```bash
   githunk handoff --json
   ```

2. For every item, use its `path`, `side`, `startLine`, and `endLine` to inspect the current code and relevant diff. `replacement` is a proposed edit: apply it only when it remains correct in context.
3. Implement every objection you accept. Follow the repository's normal implementation and verification rules.
4. If you disagree or intentionally leave an item unchanged, persist the reason with its exact `id`:

   ```bash
   githunk handoff reply --id <id> --body "why this change should not be made"
   ```

5. Report each item as **changed** or **replied**, plus verification evidence. Never report an item as resolved or addressed; the reviewer decides after inspecting the next revision.
6. Commit only when the user or repository workflow calls for a commit. The ledger remains `WAITING` until `HEAD` advances; after that, the reviewer reopens Branch Review to inspect the result.

## Quick reference

| Need                           | Command or action                                 |
| ------------------------------ | ------------------------------------------------- |
| Structured objections          | `githunk handoff --json`                          |
| Human-readable objections      | `githunk handoff`                                 |
| Disagree or intentionally skip | `githunk handoff reply --id <id> --body <reason>` |
| Accept an objection            | Edit and verify the code; write no reply          |
| Resolve an objection           | Do not do this; only the reviewer can resolve it  |

`UNTOUCHED` means the anchored lines stayed byte-identical after `HEAD` advanced. `DISPUTED` means those lines stayed unchanged and the agent replied. Neither is an agent-controlled status.

## No handoff exists

If the CLI reports no handoff, ask the user to open githunk, press `b` for Branch Review, add objections with `c`, and press `A` to hand them off. githunk does not need to remain running while the agent works; the mailbox lives under Git metadata.

## Common mistakes

- Do not read or edit `.git/githunk/handoff/*.json` directly; use the CLI.
- Do not write status, resolution, or a synthetic completion record.
- Do not reply to accepted items merely to say they were changed; replies are for disagreements or intentional non-changes.
- Do not silently skip an unsafe or obsolete suggestion; reply with the reason.
- Do not assume a suggested replacement is correct without inspecting surrounding code.
