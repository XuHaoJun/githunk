#!/usr/bin/env bun

import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import path from "node:path"
import {
  binaryFilenameForSpec,
  buildOptionalDependencyMap,
  buildPlatformPackageManifest,
  getHostPlatformPackageSpec,
  getPlatformPackageSpecByName,
  listStagedPackageDirs,
  releaseNpmDir,
  sortPlatformPackageSpecs,
  type PlatformPackageSpec,
} from "./prebuilt-package-helpers"

type RootPackageJson = {
  readonly name: string
  readonly version: string
  readonly description?: string
  readonly type?: string
  readonly keywords?: readonly string[]
  readonly homepage?: string
  readonly bugs?: unknown
  readonly repository?: unknown
  readonly engines?: Record<string, string>
  readonly dependencies?: Record<string, string>
  readonly license?: string
}

type BinaryArtifactMetadata = {
  readonly packageName: string
}

function parseArgs(argv: readonly string[]): { artifactRoot: string | undefined } {
  let artifactRoot: string | undefined

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === "--artifact-root") {
      artifactRoot = argv[index + 1]
      index += 1
    } else {
      throw new Error(`Unknown argument: ${arg}`)
    }
  }

  return { artifactRoot }
}

function loadRootPackage(repoRoot: string): RootPackageJson {
  return JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8")) as RootPackageJson
}

function ensureDirectory(directory: string): void {
  mkdirSync(directory, { recursive: true })
}

function writeJson(filePath: string, value: unknown): void {
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`)
}

function stageMetaPackage(
  repoRoot: string,
  rootPackage: RootPackageJson,
  releaseRoot: string,
  specs: readonly PlatformPackageSpec[],
): void {
  for (const required of ["bin/githunk.js", "dist/githunk.js", "README.md", "LICENSE"]) {
    if (!existsSync(path.join(repoRoot, required))) {
      throw new Error(`Missing ${required}. Run \`bun run build\` before staging the npm release.`)
    }
  }

  const metaDir = path.join(releaseRoot, rootPackage.name)
  ensureDirectory(path.join(metaDir, "bin"))
  ensureDirectory(path.join(metaDir, "dist"))
  cpSync(path.join(repoRoot, "bin", "githunk.js"), path.join(metaDir, "bin", "githunk.js"))
  cpSync(path.join(repoRoot, "dist", "githunk.js"), path.join(metaDir, "dist", "githunk.js"))
  cpSync(path.join(repoRoot, "README.md"), path.join(metaDir, "README.md"))
  cpSync(path.join(repoRoot, "LICENSE"), path.join(metaDir, "LICENSE"))

  writeJson(path.join(metaDir, "package.json"), {
    name: rootPackage.name,
    version: rootPackage.version,
    ...(rootPackage.description === undefined ? {} : { description: rootPackage.description }),
    bin: {
      githunk: "bin/githunk.js",
    },
    files: ["bin", "dist", "README.md", "LICENSE"],
    ...(rootPackage.type === undefined ? {} : { type: rootPackage.type }),
    ...(rootPackage.keywords === undefined ? {} : { keywords: rootPackage.keywords }),
    ...(rootPackage.repository === undefined ? {} : { repository: rootPackage.repository }),
    ...(rootPackage.homepage === undefined ? {} : { homepage: rootPackage.homepage }),
    ...(rootPackage.bugs === undefined ? {} : { bugs: rootPackage.bugs }),
    ...(rootPackage.engines === undefined ? {} : { engines: rootPackage.engines }),
    ...(rootPackage.dependencies === undefined ? {} : { dependencies: rootPackage.dependencies }),
    optionalDependencies: buildOptionalDependencyMap(rootPackage.version, specs),
    ...(rootPackage.license === undefined ? {} : { license: rootPackage.license }),
    publishConfig: {
      access: "public",
    },
  })
}

function stagePlatformPackage(
  rootPackage: RootPackageJson,
  releaseRoot: string,
  repoRoot: string,
  spec: PlatformPackageSpec,
  compiledBinary: string,
): void {
  if (!existsSync(compiledBinary)) {
    throw new Error(`Missing compiled binary at ${compiledBinary}`)
  }

  const packageDir = path.join(releaseRoot, spec.packageName)
  const binaryName = binaryFilenameForSpec(spec)

  ensureDirectory(path.join(packageDir, "bin"))
  const stagedBinary = path.join(packageDir, "bin", binaryName)
  cpSync(compiledBinary, stagedBinary)
  if (spec.os !== "windows") {
    chmodSync(stagedBinary, 0o755)
  }
  cpSync(path.join(repoRoot, "LICENSE"), path.join(packageDir, "LICENSE"))

  writeJson(path.join(packageDir, "package.json"), buildPlatformPackageManifest(rootPackage, spec))
}

function collectArtifactSpecs(artifactRoot: string): { spec: PlatformPackageSpec; compiledBinary: string }[] {
  const directories = listStagedPackageDirs(artifactRoot)

  if (directories.length === 0) {
    throw new Error(`No artifact directories found in ${artifactRoot}`)
  }

  return directories.map((directory) => {
    const metadata = JSON.parse(readFileSync(path.join(directory, "metadata.json"), "utf8")) as BinaryArtifactMetadata
    const spec = getPlatformPackageSpecByName(metadata.packageName)
    if (spec === undefined) {
      throw new Error(`Unknown platform package in artifact metadata: ${metadata.packageName}`)
    }

    return {
      spec,
      compiledBinary: path.join(directory, binaryFilenameForSpec(spec)),
    }
  })
}

const repoRoot = path.resolve(import.meta.dir, "..")
const options = parseArgs(process.argv.slice(2))
const rootPackage = loadRootPackage(repoRoot)
const releaseRoot = releaseNpmDir(repoRoot)
const artifactRoot = options.artifactRoot === undefined ? undefined : path.resolve(options.artifactRoot)

rmSync(releaseRoot, { recursive: true, force: true })
ensureDirectory(releaseRoot)

function hostArtifact(): { spec: PlatformPackageSpec; compiledBinary: string }[] {
  const spec = getHostPlatformPackageSpec()
  return [{ spec, compiledBinary: path.join(repoRoot, "dist", binaryFilenameForSpec(spec)) }]
}

const artifacts = artifactRoot === undefined ? hostArtifact() : collectArtifactSpecs(artifactRoot)

const stagedSpecs = sortPlatformPackageSpecs(artifacts.map((artifact) => artifact.spec))
stageMetaPackage(repoRoot, rootPackage, releaseRoot, stagedSpecs)

for (const artifact of artifacts) {
  stagePlatformPackage(rootPackage, releaseRoot, repoRoot, artifact.spec, artifact.compiledBinary)
}

console.log(`Staged prebuilt npm packages in ${releaseRoot}`)
console.log(`- ${path.join(releaseRoot, rootPackage.name)}`)
for (const spec of stagedSpecs) {
  console.log(`- ${path.join(releaseRoot, spec.packageName)}`)
}
if (artifactRoot === undefined) {
  const first = artifacts[0]
  console.log(`Artifacts source: ${first === undefined ? releaseRoot : first.compiledBinary}`)
} else {
  console.log(`Artifacts source: ${artifactRoot}`)
}
