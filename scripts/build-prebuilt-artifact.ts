#!/usr/bin/env bun

import { chmodSync, cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"
import {
  binaryFilenameForSpec,
  getHostPlatformPackageSpec,
  releaseArtifactsDir,
} from "./prebuilt-package-helpers"

function parseArgs(argv: readonly string[]): { outputRoot: string | undefined; expectedPackage: string | undefined } {
  let outputRoot: string | undefined
  let expectedPackage: string | undefined

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === "--output-root") {
      outputRoot = argv[index + 1]
      index += 1
    } else if (arg === "--expect-package") {
      expectedPackage = argv[index + 1]
      index += 1
    } else {
      throw new Error(`Unknown argument: ${arg}`)
    }
  }

  return { outputRoot, expectedPackage }
}

export type StagePrebuiltArtifactOptions = {
  readonly repoRoot?: string
  readonly outputRoot?: string
  readonly expectedPackage?: string
}

/** Stage one standalone prebuilt release artifact for the current host. */
export function stagePrebuiltArtifact(options: StagePrebuiltArtifactOptions = {}): string {
  const repoRoot = path.resolve(options.repoRoot ?? path.resolve(import.meta.dir, ".."))
  const spec = getHostPlatformPackageSpec()
  const binaryName = binaryFilenameForSpec(spec)
  const compiledBinary = path.join(repoRoot, "dist", binaryName)
  const outputRoot = path.resolve(options.outputRoot ?? releaseArtifactsDir(repoRoot))
  const outputDir = path.join(outputRoot, spec.packageName)

  if (options.expectedPackage !== undefined && options.expectedPackage !== spec.packageName) {
    throw new Error(`Expected package ${options.expectedPackage} but this host builds ${spec.packageName}`)
  }

  if (!existsSync(compiledBinary)) {
    throw new Error(
      `Missing compiled binary at ${compiledBinary}. Run \`bun run build:bin\` first.`,
    )
  }

  rmSync(outputDir, { recursive: true, force: true })
  mkdirSync(outputDir, { recursive: true })

  const stagedBinary = path.join(outputDir, binaryName)
  cpSync(compiledBinary, stagedBinary)
  if (spec.os !== "windows") {
    chmodSync(stagedBinary, 0o755)
  }

  writeFileSync(
    path.join(outputDir, "metadata.json"),
    `${JSON.stringify({ packageName: spec.packageName, version: 1 }, null, 2)}\n`,
  )

  return outputDir
}

if (import.meta.main) {
  const options = parseArgs(process.argv.slice(2))
  const outputDir = stagePrebuiltArtifact({
    ...(options.outputRoot === undefined ? {} : { outputRoot: options.outputRoot }),
    ...(options.expectedPackage === undefined ? {} : { expectedPackage: options.expectedPackage }),
  })
  console.log(`Staged prebuilt artifact in ${outputDir}`)
}
