# githunk

A review-first Git TUI that mixes [lazygit](https://github.com/jesseduffield/lazygit)’s everyday Git workflow with [hunk](https://github.com/modem-dev/hunk)’s focused diff review.
![githunk — lazygit panels with hunk review](assets/demo/githunk-review-hunk.gif)

## Install

```sh
npm install --global @xuhaojun/githunk
```

## Requirements

- Node.js 26.1.0 or newer
- Git
- A terminal with interactive TUI support

`gh` is optional. When it is installed and authenticated, githunk can show GitHub pull-request status; local Git review works without it.

The installed launcher enables Node's experimental FFI support automatically for OpenTUI.

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

## Development

This repository uses Bun for development and for producing the Node.js bundle published to npm:

```sh
bun install
bun run start
bun run check
bun run build
```
