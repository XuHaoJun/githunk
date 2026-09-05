#!/bin/sh
#
# githunk installer — https://github.com/XuHaoJun/githunk
#
# Downloads the prebuilt githunk release binary for this machine, verifies it
# against the release's SHA256SUMS, and installs it into ~/.local/bin
# (or $XDG_BIN_HOME, or $GITHUNK_INSTALL_DIR), which is where user executables
# belong per the XDG Base Directory specification.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/XuHaoJun/githunk/main/install.sh | sh
#   curl -fsSL .../install.sh | sh -s -- 0.2.0
#   curl -fsSL .../install.sh | sh -s -- --no-modify-path
#
# Environment:
#   GITHUNK_VERSION           version to install (default: the newest GitHub release)
#   GITHUNK_INSTALL_DIR       directory to install the binary into
#                             (default: $XDG_BIN_HOME or $HOME/.local/bin)
#   GITHUNK_NO_MODIFY_PATH    set to 1 to leave shell startup files alone
#   GITHUNK_RELEASE_BASE      release download base URL, mainly for tests
#                             (default: https://github.com/XuHaoJun/githunk/releases/download)
#
# macOS and Linux only. On Windows, install with `npm install -g @xuhaojun/githunk`.
#
# Everything below only defines functions; the last line runs main. A partially delivered
# script therefore dies on a syntax error instead of executing a truncated prefix.

set -eu

REPO="XuHaoJun/githunk"
RELEASES_API="https://api.github.com/repos/${REPO}/releases/latest"
DEFAULT_DOWNLOAD_BASE="https://github.com/${REPO}/releases/download"

# --------------------------------------------------------------------------------------
# Output helpers
# --------------------------------------------------------------------------------------

info() {
  printf '%s\n' "$1"
}

fail() {
  printf 'error: %s\n' "$1" >&2
  exit 1
}

# --------------------------------------------------------------------------------------
# Release base
# --------------------------------------------------------------------------------------

download_base() {
  if [ -n "${GITHUNK_RELEASE_BASE:-}" ]; then
    printf '%s' "$GITHUNK_RELEASE_BASE"
  else
    printf '%s' "$DEFAULT_DOWNLOAD_BASE"
  fi
}

# --------------------------------------------------------------------------------------
# Platform detection
# --------------------------------------------------------------------------------------

# Print the release asset's OS token, or fail with the npm fallback for anything unsupported.
detect_os() {
  case "$(uname -s)" in
    Linux) printf 'linux' ;;
    Darwin) printf 'darwin' ;;
    *)
      fail "unsupported platform $(uname -s); install with \`npm install -g @xuhaojun/githunk\` instead"
      ;;
  esac
}

# Print the release asset's CPU token for this machine.
#
# On Apple silicon a Rosetta-translated shell reports x86_64 even though the native binary is
# the arm64 one, so `sysctl.proc_translated` corrects the answer back to the real hardware.
detect_arch() {
  machine="$(uname -m)"
  if [ "$machine" = "x86_64" ] && [ "$(uname -s)" = "Darwin" ]; then
    if [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || printf '0')" = "1" ]; then
      machine="arm64"
    fi
  fi
  case "$machine" in
    x86_64|amd64) printf 'x64' ;;
    arm64|aarch64) printf 'arm64' ;;
    *) fail "unsupported architecture $machine; install with \`npm install -g @xuhaojun/githunk\` instead" ;;
  esac
}

# --------------------------------------------------------------------------------------
# Downloading
# --------------------------------------------------------------------------------------

# Download one URL to one path, returning non-zero when the server refuses it.
download() {
  url="$1"
  dest="$2"
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL --proto '=https,file' -o "$dest" "$url"
  elif command -v wget >/dev/null 2>&1; then
    wget -qO "$dest" "$url"
  else
    fail "need curl or wget to download $url"
  fi
}

# Print one URL's body, returning non-zero when the server refuses it.
fetch() {
  url="$1"
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL --proto '=https,file' "$url"
  elif command -v wget >/dev/null 2>&1; then
    wget -qO- "$url"
  else
    fail "need curl or wget to download $url"
  fi
}

# Print the checksum program and its check flag: `sha256sum -c` or `shasum -a 256 -c`.
checksum_tool() {
  if command -v sha256sum >/dev/null 2>&1; then
    printf 'sha256sum'
  elif command -v shasum >/dev/null 2>&1; then
    printf 'shasum -a 256'
  else
    fail "need sha256sum or shasum to verify the download"
  fi
}

# Resolve the version to install: explicit argument, environment, or newest release.
resolve_version() {
  if [ -n "${GITHUNK_VERSION:-}" ]; then
    printf '%s' "$GITHUNK_VERSION"
    return
  fi
  tag="$(fetch "$RELEASES_API" | sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\(v[^"]*\)".*/\1/p' | head -n 1)"
  if [ -z "$tag" ]; then
    fail "could not determine the newest release from $RELEASES_API"
  fi
  # Strip the leading `v`: release tags spell `v0.2.0`, versions do not.
  printf '%s' "${tag#v}"
}

# Strip a leading `v` and surrounding whitespace for version comparisons.
normalize_version() {
  printf '%s' "$1" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' -e 's/^v//'
}

# --------------------------------------------------------------------------------------
# Install directory
# --------------------------------------------------------------------------------------

install_dir() {
  if [ -n "${GITHUNK_INSTALL_DIR:-}" ]; then
    printf '%s' "$GITHUNK_INSTALL_DIR"
  elif [ -n "${XDG_BIN_HOME:-}" ]; then
    printf '%s' "$XDG_BIN_HOME"
  else
    printf '%s' "${HOME:?HOME is not set}/.local/bin"
  fi
}

# --------------------------------------------------------------------------------------
# PATH helpers
# --------------------------------------------------------------------------------------

# Append one line to one file unless an equivalent line is already there. Prints what it did.
add_path_line() {
  file="$1"
  line="$2"
  if [ -f "$file" ] && grep -Fq "$line" "$file"; then
    info "PATH entry already present in $file"
    return
  fi
  printf '%s\n' "$line" >> "$file"
  info "Added PATH entry to $file (restart the shell to pick it up)"
}

# Escape one value for inclusion inside single quotes in shell startup syntax, so a directory
# containing shell-significant characters stays a literal path instead of becoming code.
squote() {
  printf "%s" "$1" | sed "s/'/'\\\\''/g"
}

# Print the first of the given candidate startup files that exists, or the first candidate.
first_existing() {
  for candidate in "$@"; do
    if [ -f "$candidate" ]; then
      printf '%s' "$candidate"
      return
    fi
  done
  printf '%s' "$1"
}

ensure_on_path() {
  dir="$1"
  case ":${PATH:-}:" in
    *":$dir:"*) return ;;
  esac
  if [ "${GITHUNK_NO_MODIFY_PATH:-0}" = "1" ]; then
    info "Add $dir to PATH to run githunk from anywhere"
    return
  fi
  rc="$(first_existing "$HOME/.bashrc" "$HOME/.zshrc")"
  add_path_line "$rc" "export PATH='$(squote "$dir")':\$PATH"
}

# --------------------------------------------------------------------------------------
# Main
# --------------------------------------------------------------------------------------

main() {
  requested=""
  no_modify_path="${GITHUNK_NO_MODIFY_PATH:-0}"

  for arg in "$@"; do
    case "$arg" in
      --no-modify-path) no_modify_path="1" ;;
      -h|--help)
        sed -n '2,/^#$/p' "$0" | sed 's/^# \?//'
        return 0
        ;;
      -*) fail "unknown option $arg" ;;
      *)
        if [ -n "$requested" ]; then
          fail "unexpected argument $arg"
        fi
        requested="$arg"
        ;;
    esac
  done
  GITHUNK_NO_MODIFY_PATH="$no_modify_path"

  if [ -z "$requested" ]; then
    requested="$(resolve_version)"
  fi
  version="$(normalize_version "$requested")"
  tag="v$version"

  os="$(detect_os)"
  arch="$(detect_arch)"
  asset="githunk-${os}-${arch}.tar.gz"
  base="$(download_base)"

  dir="$(install_dir)"
  mkdir -p "$dir"
  binary="$dir/githunk"

  if [ -x "$binary" ]; then
    installed="$(normalize_version "$("$binary" --version 2>/dev/null || true)")"
    if [ -n "$installed" ] && [ "$installed" = "$version" ]; then
      info "githunk $version is already installed at $binary"
      return 0
    fi
  fi

  work="$(mktemp -d)"
  # Expand now so the EXIT trap keeps working after `work` goes out of scope.
  # shellcheck disable=SC2064
  trap "rm -rf '$work'" EXIT INT TERM

  info "Downloading githunk $version ($asset)"
  download "$base/$tag/$asset" "$work/$asset"
  download "$base/$tag/SHA256SUMS" "$work/SHA256SUMS"

  info "Verifying checksum"
  ( cd "$work" && grep -F " $asset" SHA256SUMS | $(checksum_tool) -c - ) || fail "checksum mismatch for $asset"

  info "Installing to $binary"
  tar -xzf "$work/$asset" -C "$work"
  staged="$work/githunk-${os}-${arch}/githunk"
  if [ ! -f "$staged" ]; then
    fail "release archive has no githunk-${os}-${arch}/githunk binary"
  fi
  cp "$staged" "$binary"
  chmod 755 "$binary"

  info "Installed githunk $version at $binary"
  ensure_on_path "$dir"
}

main "$@"
