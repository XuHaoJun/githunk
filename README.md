# githunk

A review-first Git TUI that mixes [lazygit](https://github.com/jesseduffield/lazygit)’s everyday Git workflow with [hunk](https://github.com/modem-dev/hunk)’s focused diff review.
![githunk — lazygit panels with hunk review](assets/demo/githunk-review-hunk.gif)

## Install

No Node.js required — githunk ships as a standalone binary:

```sh
curl -fsSL https://raw.githubusercontent.com/XuHaoJun/githunk/main/install.sh | sh
```

This installs the newest release into `~/.local/bin` (or `$XDG_BIN_HOME`, or `$GITHUNK_INSTALL_DIR`), verifying its checksum first. Pin a version with `sh -s -- 0.2.0`, or pass `--no-modify-path` to skip shell-startup PATH wiring. macOS and Linux only.

Alternative via npm (needs Node.js 26.4.0 or newer just to install):

```sh
npm install --global @xuhaojun/githunk
```

## Requirements

- Git
- A terminal with interactive TUI support

`gh` is optional. When it is installed and authenticated, githunk can show GitHub pull-request status; local Git review works without it.

The launcher prefers the prebuilt binary. On platforms without one it falls back to the Node.js bundle, which needs Node.js 26.4.0 or newer; the launcher enables Node's experimental FFI support automatically for OpenTUI.

## Update

```sh
githunk update            # newest release
githunk update 0.3.0      # a specific version
githunk update --check    # report without installing
```

Standalone installs replace their own binary after checksum verification. npm installs update through npm instead: `npm update --global @xuhaojun/githunk`.

Installer knobs: `GITHUNK_VERSION` pins the version, `GITHUNK_INSTALL_DIR` overrides the install directory, `GITHUNK_NO_MODIFY_PATH=1` skips shell-startup PATH wiring.

## Usage

Run githunk from any directory inside a Git repository:

```sh
cd path/to/repository
githunk
```

Or point it at a repository from anywhere:

```sh
githunk --path path/to/repository
githunk path/to/repository
```

`githunk --help` prints all options; `githunk --version` prints the installed version.

## Open objections

An agent writes four hundred lines, you leave five objections, and it comes back
saying it addressed them all. Which anchors moved, and which lines stayed the same?
Today the honest answers are "re-read the whole diff" or "take its word for it".

githunk records each objection and computes whether its anchor moved or stayed
byte-identical. It cannot decide whether a changed implementation satisfies the
request; that remains your review.

### Load the agent skill

githunk ships its handoff skill with source, npm and standalone installs. For a
one-off session, ask the agent to load the installed file:

```text
Run `githunk skill path`, read the returned SKILL.md, then process
`githunk handoff --json` in the current repository.
```

`githunk skill show` prints the same document to stdout for sandboxes that
cannot read the installed path. Loading the bundled file directly keeps the
agent workflow in sync when githunk is upgraded; a project-local or global copy
does not update automatically.

### A round

Press `b` for Branch Review, `c` on a line to object, then `A` to hand off:

```sh
githunk handoff          # what the reviewer wants changed, as markdown
githunk handoff --json   # the same thing, with ids and line numbers
```

Your agent reads that, changes what it changes, and commits. Reopen githunk:

```
feature → [main ▾]  ·  2 commits · 1 files · +2 −1  [Aggregate]
Reviewed 0/1 · 1 reviewing · 2 pending  ·  1 addressed · 1 UNTOUCHED

  2 +   return store.find(e => e.key === key) ?? null
addressed stale ! note — filter()[0] allocates the whole array — use find() — cache.ts new:2
    was d9937c4 │   return store.filter(e => e.key === key)[0]
    now d85d5d6 │   return store.find(e => e.key === key) ?? null
  6 +   store.sort((a, b) => a.key < b.key ? -1 : 1)
UNTOUCHED active ! note — sorting on every put is O(n log n) per write — cache.ts new:6
```

The header is the ledger's one-line summary. Each objection sits under the line it
was written against, carrying its verdict and — once the code moves — what it used
to say and what stands there now.

`UNTOUCHED` is the one you could not have learned any other way: those lines are
byte-identical to when you handed them off. No summary can talk it away, because
it is a fact about the code and not a claim about the work.

Press `L` for the list of objections and Enter to jump to one, `-` to resolve one
you have looked at, `a` to re-anchor one, and `s` to see only what changed since
the handoff.

### When the agent disagrees

Skipping an objection and disagreeing with it are different things, so an agent
can say which it is:

```sh
githunk handoff reply --id <id> --body "the sort is needed for the range query"
```

The answer appears under your objection. It settles nothing: an answered objection
whose lines are unchanged reads `DISPUTED` rather than `UNTOUCHED` — it argued
instead of complying, which is a question for you.

There is deliberately no CLI verb that marks an objection done. An agent that
could mark its own work addressed would make the whole ledger worthless, so the
verdict is computed from the code and nothing an agent writes can move it.

### Where the ledger lives

Under the Git directory, never the worktree, so reviewing never dirties
`git status`:

```
.git/githunk/review-state-v2.json      your objections, across sessions
.git/githunk/handoff/pending.json      githunk writes · agent reads
.git/githunk/handoff/replies.json      agent writes   · githunk reads
```

Two files with two owners means neither side needs a lock and no daemon has to be
running. Quit githunk, come back in two days, and the ledger is still there.

### Compared with hunk

githunk's review renderer is derived from [hunk](https://github.com/modem-dev/hunk),
which is the better tool for reviewing beside a live agent: it can drive your
window, jump you to a hunk, highlight the expression under discussion, and answer
inline. githunk does none of that.

What githunk adds is memory. hunk's review notes live in the process — quitting
ends them — so it cannot ask whether the lines an objection pointed at survived
someone else's commit. githunk re-anchors every objection against every new
generation, which is what makes `UNTOUCHED`, `DISPUTED` and "since the handoff"
possible at all.

Reviewing in one sitting: use hunk. Handing work to an agent and verifying it
later: that is what this is for.

## Development

This repository uses Bun for development and for producing the Node.js bundle published to npm:

```sh
bun install
bun run start
bun run check
bun run build
```
