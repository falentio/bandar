#!/bin/sh
# Installs a released bandar binary: verifies its published sha256, records the
# install source for "bandar update", and optionally hands off to install-service.
set -eu

REPO=falentio/bandar
RAW_INSTALLER=https://raw.githubusercontent.com/falentio/bandar/main/install.sh

die() {
  printf 'bandar: %s\n' "$*" >&2
  exit 1
}

usage() {
  cat <<'EOF'
Install a released bandar binary.

  curl -fsSL https://raw.githubusercontent.com/falentio/bandar/main/install.sh | sh

Environment:
  BANDAR_VERSION           Version to install, such as 0.1.0. Default: the latest release.
  BANDAR_INSTALL_DIR       Directory that receives the binary. Default: /usr/local/bin
  BANDAR_SCOPE             user or system: also register the service. Default: unset, no service step.
  BANDAR_CONFIG_DIR        Directory that receives install.json. Default: ~/.config/bandar
  BANDAR_SERVICE_TIMEOUT   Seconds the service step may run. Default: 30
  BANDAR_RELEASE_BASE_URL  Directory that holds the release assets. Include the version.
                           Default: https://github.com/falentio/bandar/releases/download/v<version>
  BANDAR_RELEASE_API_URL   Latest-release JSON. Default: the GitHub API for this repository.

Docs: docs/install.md
EOF
}

case ${1:-} in
  -h | --help)
    usage
    exit 0
    ;;
  '') ;;
  *) die "install.sh takes no arguments, got '$1'; see --help" ;;
esac

raw_os=$(uname -s)
raw_arch=$(uname -m)

case $raw_os in
  Linux) os=linux ;;
  MINGW* | MSYS* | CYGWIN*) os=windows ;;
  *) os=$(printf '%s' "$raw_os" | tr '[:upper:]' '[:lower:]') ;;
esac

case $raw_arch in
  x86_64 | amd64 | AMD64) arch=x64 ;;
  aarch64 | arm64 | ARM64) arch=arm64 ;;
  *) arch=$(printf '%s' "$raw_arch" | tr '[:upper:]' '[:lower:]') ;;
esac

case $os in
  linux | windows) ;;
  *) die "no release for $os-$arch: bandar ships linux and windows binaries" ;;
esac

case $arch in
  x64 | arm64) ;;
  *) die "no release for $os-$arch: bandar ships x64 and arm64 binaries" ;;
esac

scope=${BANDAR_SCOPE:-}

case $scope in
  '' | user | system) ;;
  *) die "BANDAR_SCOPE must be user or system, got '$scope'" ;;
esac

if [ -z "${BANDAR_CONFIG_DIR:-}" ] && [ -z "${HOME:-}" ]; then
  die "HOME is unset; set BANDAR_CONFIG_DIR to the directory that holds install.json"
fi

install_dir=${BANDAR_INSTALL_DIR:-/usr/local/bin}
config_dir=${BANDAR_CONFIG_DIR:-${HOME:-/root}/.config/bandar}

if command -v sha256sum >/dev/null 2>&1; then
  hasher=sha256sum
elif command -v shasum >/dev/null 2>&1; then
  hasher=shasum
else
  die "sha256sum or shasum is required to verify the download"
fi

sha256_of() {
  if [ "$hasher" = sha256sum ]; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

fetch() {
  url=$1
  dest=$2

  if command -v curl >/dev/null 2>&1; then
    curl -fsSL -o "$dest" "$url"
  elif command -v wget >/dev/null 2>&1; then
    wget -q -O "$dest" "$url"
  else
    die "neither curl nor wget is installed"
  fi
}

run_with_timeout() {
  timeout_seconds=$1
  shift

  "$@" < /dev/null &
  timeout_pid=$!

  (
    i=0
    while [ "$i" -lt "$timeout_seconds" ]; do
      sleep 1
      kill -0 "$timeout_pid" 2>/dev/null || exit 0
      i=$((i + 1))
    done
    kill -TERM "$timeout_pid" 2>/dev/null || exit 0
    j=0
    while [ "$j" -lt 5 ]; do
      sleep 1
      kill -0 "$timeout_pid" 2>/dev/null || exit 0
      j=$((j + 1))
    done
    kill -KILL "$timeout_pid" 2>/dev/null
  ) < /dev/null > /dev/null 2>&1 &
  watchdog_pid=$!

  timeout_status=0
  wait "$timeout_pid" || timeout_status=$?
  kill "$watchdog_pid" 2>/dev/null || true
  wait "$watchdog_pid" 2>/dev/null || true

  return "$timeout_status"
}

run_in_place() {
  [ -f "$0" ] || return 1

  case $0 in
    sh | bash | dash | ash | ksh | zsh) return 1 ;;
  esac

  return 0
}

sudo_hint() {
  hint="sudo BANDAR_INSTALL_DIR=\"$install_dir\" BANDAR_CONFIG_DIR=\"$config_dir\""

  if [ -n "${BANDAR_VERSION:-}" ]; then
    hint="$hint BANDAR_VERSION=\"$BANDAR_VERSION\""
  fi

  if [ -n "$scope" ]; then
    hint="$hint BANDAR_SCOPE=\"$scope\""
  fi

  if run_in_place; then
    printf '%s sh "%s"' "$hint" "$(cd "$(dirname "$0")" && pwd -P)/$(basename "$0")"
  else
    printf 'curl -fsSL %s | %s sh' "$RAW_INSTALLER" "$hint"
  fi
}

if [ ! -d "$install_dir" ]; then
  mkdir -p "$install_dir" 2>/dev/null || true
fi

if [ ! -d "$install_dir" ] || [ ! -w "$install_dir" ]; then
  if [ "$(id -u)" -eq 0 ]; then
    die "cannot write to $install_dir"
  fi
  printf 'bandar: %s is not writable\n' "$install_dir" >&2
  printf 'rerun with sudo:\n  %s\n' "$(sudo_hint)" >&2
  exit 1
fi

install_dir=$(cd "$install_dir" && pwd -P)

tmp=$(mktemp -d "${TMPDIR:-/tmp}/bandar-install.XXXXXX") || die "cannot create a temp directory"

trap 'rm -rf "$tmp"' EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

if [ -n "${BANDAR_VERSION:-}" ]; then
  version=${BANDAR_VERSION#v}
  case $version in
    '' | */* | *' '*) die "BANDAR_VERSION must look like 0.1.0, got '$BANDAR_VERSION'" ;;
  esac
else
  api=${BANDAR_RELEASE_API_URL:-https://api.github.com/repos/$REPO/releases/latest}
  fetch "$api" "$tmp/latest.json" || die "cannot read the latest release from $api"
  tag=$(sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$tmp/latest.json" | head -n 1)
  [ -n "$tag" ] || die "no tag_name in the response from $api"
  version=${tag#v}
fi

asset=bandar-$version-$os-$arch
binary=bandar
if [ "$os" = windows ]; then
  asset=$asset.exe
  binary=bandar.exe
fi

base=${BANDAR_RELEASE_BASE_URL:-https://github.com/$REPO/releases/download/v$version}
base=${base%/}

printf 'bandar: downloading %s/%s\n' "$base" "$asset"

fetch "$base/$asset" "$tmp/$asset" || die "cannot download $base/$asset"
fetch "$base/$asset.sha256" "$tmp/$asset.sha256" || die "cannot download $base/$asset.sha256"

expected=$(awk 'NR == 1 { print $1 }' "$tmp/$asset.sha256")
[ -n "$expected" ] || die "$asset.sha256 is empty"
case $expected in
  *[!0-9a-fA-F]*) die "$asset.sha256 does not start with a sha256 digest" ;;
esac
expected=$(printf '%s' "$expected" | tr 'A-F' 'a-f')
actual=$(sha256_of "$tmp/$asset")

[ "$actual" = "$expected" ] || die "checksum mismatch for $asset: published $expected, downloaded $actual"

target=$install_dir/$binary
staged=$install_dir/.$binary.$$

cp "$tmp/$asset" "$staged" || die "cannot copy the binary into $install_dir"
chmod 755 "$staged" || {
  rm -f "$staged"
  die "cannot make $staged executable"
}
mv -f "$staged" "$target" || {
  rm -f "$staged"
  die "cannot move the binary into place at $target"
}

mkdir -p "$config_dir" || die "cannot create $config_dir"
chmod 700 "$config_dir" || die "cannot set mode 700 on $config_dir"

json_escape() {
  printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'
}

manifest=$config_dir/install.json
staged_manifest=$manifest.$$

printf '{"source":"install-script","version":"%s","path":"%s"}\n' \
  "$version" "$(json_escape "$target")" >"$staged_manifest" ||
  die "cannot write $staged_manifest"
mv -f "$staged_manifest" "$manifest" || {
  rm -f "$staged_manifest"
  die "cannot write $manifest"
}

if [ -z "$scope" ]; then
  printf 'bandar: installed %s to %s\n' "$version" "$target"
  exit 0
fi

service_timeout=${BANDAR_SERVICE_TIMEOUT:-30}
case $service_timeout in
  *[!0-9]*) die "BANDAR_SERVICE_TIMEOUT must be a number of seconds, got '$service_timeout'" ;;
esac

if run_with_timeout "$service_timeout" "$target" install-service --scope "$scope"; then
  printf 'bandar: installed %s to %s with the %s service registered\n' "$version" "$target" "$scope"
  exit 0
fi

printf 'bandar: installed %s to %s; skipped the service step because install-service is missing or failed\n' \
  "$version" "$target"
exit 0
