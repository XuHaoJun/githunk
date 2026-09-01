# githunk

A review-first Git TUI for inspecting and managing changes.

## Requirements

- Node.js 26.1.0 or newer
- Git
- A terminal with interactive TUI support

`gh` is optional. When it is installed and authenticated, githunk can show GitHub pull-request status; local Git review works without it.

The installed launcher enables Node's experimental FFI support automatically for OpenTUI.

## Install

```sh
npm install --global @xuhaojun/githunk
```

## Usage

Run githunk from any directory inside a Git repository:

```sh
cd path/to/repository
githunk
```

## Development

This repository uses Bun for development and for producing the Node.js bundle published to npm:

```sh
bun install
bun run start
bun run check
bun run build
```
