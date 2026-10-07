# Clipboard Compatibility — githunk v0.1

This record is evidence-bounded: invoking the OSC52 path is not treated as proof that a client accepted or pasted the payload.

## Evidence captured

| Dimension            | Evidence                                                                                                                                          | Result                                                           |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Terminal emulator    | Workstation terminal reported by the harness: `xterm-ghostty`; emulator version was not captured (`Not available` in this run)                    | Identified; remote clipboard delivery not exercised              |
| `TERM` / `COLORTERM` | Supervised smoke process environment: `TERM=dumb`, `COLORTERM=`                                                                                   | Recorded exactly; not a client-clipboard result                  |
| Dimensions           | Requested acceptance geometry: 120×40. The smoke launcher did not expose a terminal ioctl (`stty size` returned `Inappropriate ioctl for device`) | 120×40 target recorded; measured dimensions **Not tested**       |
| SSH state            | `ssh -V`: `OpenSSH_10.5p1, OpenSSL 3.6.3 9 Jun 2026`; no SSH server/client session was used                                                       | **Not tested**                                                   |
| zellij               | `zellij 0.44.3`; configuration file present at `~/.config/zellij/config.kdl`                                                                      | Version/config path recorded; SSH+zellij behavior **Not tested** |
| tmux                 | `tmux 3.7c` is installed                                                                                                                          | tmux behavior **Not tested**                                     |
| OSC52 emission       | No remote or local clipboard harness was available during this acceptance run                                                                     | **Not tested**                                                   |
| Client paste result  | No client paste operation was performed                                                                                                           | **Not tested**                                                   |

## Scope boundaries

- The automated acceptance test verifies exact patch text produced by the production `AppController`, `GitRunner`, and working-tree loader. It does not claim clipboard delivery.
- The actual non-destructive TUI smoke launched `bun run start`, navigated targets, inspected a diff, toggled Command Log, sent splitter drag events, and quit with exit code 0. It did not provide a client clipboard observation.
- Local-only clipboard behavior, SSH-only behavior, and tmux behavior remain **Not tested**. No compatibility claim is made for those environments.
- A future compatibility run must use a real 120×40 terminal, an SSH client/server path, zellij and tmux sessions as applicable, emit OSC52, and verify paste at the client.

## Branch Review screen-text copy

- Drag-select text in the Branch Review Diff pane and press `y`. Only native screen text is copied; selected line numbers, padding and old/new columns remain. The semantic `v` range is not a copy source, and no source-code or patch conversion is performed.
- **Automated (one-off renderer harness, 2026-10-07):** a real temporary Git repository, `GitRunner`, `ReviewWorkspaceController` and `ReactReviewHost` exercised split/stack selection, cross-row/cross-side decorated payloads, empty/unsupported results, filter/composer input ownership, modal suppression and unchanged Git status. The OSC52 transport was captured with a test port, not a real client clipboard.
- **Manual smoke observed:** no live client clipboard or terminal-multiplexer delivery was observed for this feature.
- **Not tested:** real OSC52 transmission/client paste, SSH, tmux and zellij delivery for Branch Review. An emitted result is not proof that the client accepted the payload.
