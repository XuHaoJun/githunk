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

if (import.meta.main) {
  const channel = resolveReleaseChannel({
    event: readFlag(process.argv.slice(2), "--event"),
    ref: readFlag(process.argv.slice(2), "--ref"),
    requestedTag: readFlag(process.argv.slice(2), "--requested-tag"),
    currentLatest: readFlag(process.argv.slice(2), "--current-latest"),
  })
  console.log(JSON.stringify(channel))
}
