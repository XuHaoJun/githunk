#!/usr/bin/env bun

import { readdirSync } from "node:fs"
import os from "node:os"
import path from "node:path"

export type SupportedPlatform = "darwin" | "linux" | "windows"
export type SupportedArch = "x64" | "arm64"

export type PlatformPackageSpec = {
  readonly packageName: string
  readonly os: SupportedPlatform
  readonly cpu: SupportedArch
  readonly binaryName: string
  readonly binaryRelativePath: string
}

const PLATFORM_NAME_MAP: Partial<Record<NodeJS.Platform, SupportedPlatform>> = {
  darwin: "darwin",
  linux: "linux",
  win32: "windows",
}

const ARCH_NAME_MAP: Partial<Record<NodeJS.Architecture, SupportedArch>> = {
  x64: "x64",
  arm64: "arm64",
}

/** Platforms published as optional prebuilt binary packages. */
export const PLATFORM_PACKAGE_MATRIX: readonly PlatformPackageSpec[] = [
  {
    packageName: "@xuhaojun/githunk-darwin-arm64",
    os: "darwin",
    cpu: "arm64",
    binaryName: "githunk",
    binaryRelativePath: "bin/githunk",
  },
  {
    packageName: "@xuhaojun/githunk-darwin-x64",
    os: "darwin",
    cpu: "x64",
    binaryName: "githunk",
    binaryRelativePath: "bin/githunk",
  },
  {
    packageName: "@xuhaojun/githunk-linux-arm64",
    os: "linux",
    cpu: "arm64",
    binaryName: "githunk",
    binaryRelativePath: "bin/githunk",
  },
  {
    packageName: "@xuhaojun/githunk-linux-x64",
    os: "linux",
    cpu: "x64",
    binaryName: "githunk",
    binaryRelativePath: "bin/githunk",
  },
  {
    packageName: "@xuhaojun/githunk-windows-x64",
    os: "windows",
    cpu: "x64",
    binaryName: "githunk",
    binaryRelativePath: "bin/githunk.exe",
  },
]

/** Normalize a Node platform string into the package naming vocabulary. */
export function normalizeHostPlatform(platform: NodeJS.Platform): SupportedPlatform | undefined {
  return PLATFORM_NAME_MAP[platform]
}

/** Normalize a Node architecture string into the package naming vocabulary. */
export function normalizeHostArch(arch: NodeJS.Architecture): SupportedArch | undefined {
  return ARCH_NAME_MAP[arch]
}

/** Find one known prebuilt package spec by package name. */
export function getPlatformPackageSpecByName(packageName: string): PlatformPackageSpec | undefined {
  return PLATFORM_PACKAGE_MATRIX.find((candidate) => candidate.packageName === packageName)
}

/** Resolve the published package spec for a given Node platform/architecture pair. */
export function getPlatformPackageSpecForHost(
  platform: NodeJS.Platform,
  arch: NodeJS.Architecture,
): PlatformPackageSpec {
  const osName = normalizeHostPlatform(platform)
  const archName = normalizeHostArch(arch)
  const spec = PLATFORM_PACKAGE_MATRIX.find((candidate) => candidate.os === osName && candidate.cpu === archName)
  if (spec === undefined) {
    throw new Error(`Unsupported platform for prebuilt githunk binaries: ${platform} ${arch}`)
  }
  return spec
}

/** Return the package spec that matches the current machine. */
export function getHostPlatformPackageSpec(): PlatformPackageSpec {
  return getPlatformPackageSpecForHost(os.platform(), os.arch())
}

/** Build the optional dependency map for the meta package. */
export function buildOptionalDependencyMap(
  version: string,
  specs: readonly PlatformPackageSpec[] = PLATFORM_PACKAGE_MATRIX,
): Record<string, string> {
  return Object.fromEntries(specs.map((spec) => [spec.packageName, version]))
}

/** Return the executable filename for a platform package. */
export function binaryFilenameForSpec(spec: PlatformPackageSpec): string {
  return spec.os === "windows" ? `${spec.binaryName}.exe` : spec.binaryName
}

/**
 * Build the published manifest for one prebuilt platform package.
 *
 * Declaring the native executable in `bin` makes npm restore its execute bits
 * during installation, including when release artifact transfer strips the
 * staged mode before publishing.
 */
export function buildPlatformPackageManifest(
  rootPackage: {
    readonly version: string
    readonly description?: string
    readonly repository?: unknown
    readonly homepage?: string
    readonly bugs?: unknown
    readonly license?: string
  },
  spec: PlatformPackageSpec,
): Record<string, unknown> {
  return {
    name: spec.packageName,
    version: rootPackage.version,
    ...(rootPackage.description === undefined
      ? {}
      : { description: `${rootPackage.description} (${spec.os} ${spec.cpu} binary)` }),
    os: [spec.os === "windows" ? "win32" : spec.os],
    cpu: [spec.cpu],
    bin: {
      githunk: spec.binaryRelativePath,
    },
    files: ["bin", "LICENSE"],
    ...(rootPackage.repository === undefined ? {} : { repository: rootPackage.repository }),
    ...(rootPackage.homepage === undefined ? {} : { homepage: rootPackage.homepage }),
    ...(rootPackage.bugs === undefined ? {} : { bugs: rootPackage.bugs }),
    ...(rootPackage.license === undefined ? {} : { license: rootPackage.license }),
    publishConfig: {
      access: "public",
    },
  }
}

/** Resolve a path under the generated prebuilt npm release directory. */
export function releaseNpmDir(repoRoot: string): string {
  return path.join(repoRoot, "dist", "release", "npm")
}

/** Resolve a path under the generated prebuilt binary artifact directory. */
export function releaseArtifactsDir(repoRoot: string): string {
  return path.join(repoRoot, "dist", "release", "artifacts")
}

/** Sort package specs into stable npm publish order. */
export function sortPlatformPackageSpecs(specs: readonly PlatformPackageSpec[]): PlatformPackageSpec[] {
  return [...specs].sort((left, right) => left.packageName.localeCompare(right.packageName))
}

/**
 * List staged package directories under one root, descending into `@scope`
 * directories. Scoped platform package names (e.g. `@xuhaojun/githunk-linux-x64`)
 * stage as nested paths, so a flat directory read would only find the scope.
 */
export function listStagedPackageDirs(root: string): string[] {
  const packages: string[] = []
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    if (entry.name.startsWith("@")) {
      for (const nested of readdirSync(path.join(root, entry.name), { withFileTypes: true })) {
        if (nested.isDirectory()) packages.push(path.join(root, entry.name, nested.name))
      }
    } else {
      packages.push(path.join(root, entry.name))
    }
  }
  return packages
}
