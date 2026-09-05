#!/usr/bin/env bun

export type ReleaseChannelInput = {
  readonly event: string
  readonly ref: string
  readonly requestedTag: string
  readonly currentLatest: string
}

export type ReleaseChannel = {
  readonly npmTag: string
  readonly makeLatest: boolean
}

/** Decide the npm dist-tag and the GitHub "latest" flag for one release run. */
export function resolveReleaseChannel(input: ReleaseChannelInput): ReleaseChannel {
  if (input.event !== "push") {
    return { npmTag: input.requestedTag, makeLatest: input.requestedTag === "latest" }
  }
  if (/(?:^|[/-])(alpha|beta|rc)(?:[.-]|$)/.test(input.ref)) {
    return { npmTag: "beta", makeLatest: false }
  }
  return { npmTag: "latest", makeLatest: true }
}

function readFlag(argv: readonly string[], name: string): string {
  const index = argv.indexOf(name)
  const value = index === -1 ? undefined : argv[index + 1]
  if (value === undefined || value === "") {
    throw new Error(`Missing required flag ${name}`)
  }
  return value
}

function readOptionalFlag(argv: readonly string[], name: string): string {
  const index = argv.indexOf(name)
  const value = index === -1 ? undefined : argv[index + 1]
  return value ?? ""
}

if (import.meta.main) {
  const argv = process.argv.slice(2)
  const channel = resolveReleaseChannel({
    event: readFlag(argv, "--event"),
    ref: readFlag(argv, "--ref"),
    requestedTag: readFlag(argv, "--requested-tag"),
    currentLatest: readOptionalFlag(argv, "--current-latest"),
  })
  console.log(JSON.stringify(channel))
}
