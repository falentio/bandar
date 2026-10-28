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
Install a released bandar binary. The repository is public, so no token is needed.

  curl -fsSL https://raw.githubusercontent.com/falentio/bandar/main/install.sh | sh

Environment:
  BANDAR_VERSION           Version to install, such as 0.1.0. Default: the latest release.
  BANDAR_INSTALL_DIR       Directory that receives the binary. Default: /usr/local/bin
  BANDAR_SCOPE             user or system: also register the service. Default: unset, no service step.
  BANDAR_CONFIG_DIR        Directory that receives install.json. Default: ~/.config/bandar.
                           Must be an absolute path.
  BANDAR_SERVICE_TIMEOUT   Seconds the service step may run. Default: 30
  BANDAR_RELEASE_WEB_URL   Origin that serves the release page and the downloads, for a mirror
                           or a test server. Default: https://github.com/falentio/bandar
  BANDAR_RELEASE_API_URL   Latest-release JSON of a private fork. Set it, plus a token, to install
                           from a private repository instead of the public release.
  BANDAR_GITHUB_TOKEN      Optional token for the private fork selected by BANDAR_RELEASE_API_URL.
                           GH_TOKEN and GITHUB_TOKEN are read too, in that order. A public
                           download never reads a token.

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

# The same rule the server applies at boot: a config directory has to be absolute, because the
# manifest it holds is what "bandar update" resolves the installed binary through.
if [ -n "${BANDAR_CONFIG_DIR+given}" ]; then
  config_dir=$(printf '%s' "${BANDAR_CONFIG_DIR}" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')
  if [ -z "$config_dir" ]; then
    die "BANDAR_CONFIG_DIR must be an absolute path, got a blank value"
  fi
  case $config_dir in
    /*) ;;
    [A-Za-z]:\\* | [A-Za-z]:/*) ;;
    *) die "BANDAR_CONFIG_DIR must be an absolute path, got '$config_dir'" ;;
  esac
else
  if [ -z "${HOME:-}" ]; then
    die "HOME is unset; set BANDAR_CONFIG_DIR to the directory that holds install.json"
  fi
  config_dir=$HOME/.config/bandar
fi

install_dir=${BANDAR_INSTALL_DIR:-/usr/local/bin}

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

  if [ -n "$api" ]; then
    hint="$hint BANDAR_RELEASE_API_URL=\"$api\" BANDAR_GITHUB_TOKEN=\"...\""
  fi

  if run_in_place; then
    printf '%s sh "%s"' "$hint" "$(cd "$(dirname "$0")" && pwd -P)/$(basename "$0")"
  else
    printf 'curl -fsSL %s | %s sh' "$RAW_INSTALLER" "$hint"
  fi
}

# A token is only ever read for the private fork that BANDAR_RELEASE_API_URL names.
token=${BANDAR_GITHUB_TOKEN:-${GH_TOKEN:-${GITHUB_TOKEN:-}}}
api=${BANDAR_RELEASE_API_URL:-}
web=${BANDAR_RELEASE_WEB_URL:-https://github.com/$REPO}
web=${web%/}
latest_release_page=$web/releases/latest

if [ -n "$api" ] && [ -z "$token" ]; then
  die "BANDAR_RELEASE_API_URL reads a private fork, so it needs a GitHub token: set BANDAR_GITHUB_TOKEN"
fi

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

fetch_err=$tmp/fetch.err

http_not_found() {
  grep -q ' 404' "$fetch_err" 2>/dev/null
}

download_plain() {
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL -o "$2" "$1" 2>"$fetch_err"
  elif command -v wget >/dev/null 2>&1; then
    wget -O "$2" "$1" 2>"$fetch_err"
  else
    die "neither curl nor wget is installed"
  fi
}

plain_or_die() {
  if download_plain "$1" "$2"; then
    return 0
  fi
  if http_not_found; then
    die "cannot download $1: no such asset. A private fork installs with BANDAR_RELEASE_API_URL and a GitHub token; a mirror sets BANDAR_RELEASE_WEB_URL"
  fi
  die "cannot download $1"
}

header_config() {
  headers=$tmp/headers
  (
    umask 077
    printf 'header = "Authorization: Bearer %s"\n' "${token:?token is required}" >"$headers"
    printf 'header = "Accept: %s"\n' "$1" >>"$headers"
  )
  printf '%s' "$headers"
}

curl_config=0
if command -v curl >/dev/null 2>&1; then
  curl_help=$(curl --help all 2>/dev/null || true)
  case $curl_help in
    *--config*) curl_config=1 ;;
  esac
fi

download_authed() {
  accept=${3:-application/octet-stream}

  if command -v curl >/dev/null 2>&1; then
    if [ "$curl_config" -eq 1 ]; then
      curl -fsSL -K "$(header_config "$accept")" -o "$2" "$1" 2>"$fetch_err"
    else
      curl -fsSL -H "Authorization: Bearer ${token:?}" -H "Accept: $accept" -o "$2" "$1" 2>"$fetch_err"
    fi
  elif command -v wget >/dev/null 2>&1; then
    wget --header="Authorization: Bearer ${token:?}" --header="Accept: $accept" -O "$2" "$1" 2>"$fetch_err"
  else
    die "neither curl nor wget is installed"
  fi
}

# Prints the Location header of a redirect without following it, so the latest tag costs one page
# request instead of an API call: no rate limit, no credential.
fetch_location() {
  if command -v curl >/dev/null 2>&1; then
    : >"$tmp/headers"
    curl -sS -o /dev/null -D "$tmp/headers" "$1" 2>"$fetch_err" || return 1
    sed -n 's/^[Ll]ocation:[[:space:]]*//p' "$tmp/headers" | tr -d '\r' | tail -n 1
    return 0
  fi

  if command -v wget >/dev/null 2>&1; then
    : >"$tmp/headers"
    # -S prints the response headers to stderr, and 0 redirects keeps wget from following them.
    wget -q -S -O /dev/null --max-redirect=0 "$1" 2>"$tmp/headers" || true
    sed -n 's/^[[:space:]]*[Ll]ocation:[[:space:]]*//p' "$tmp/headers" | tr -d '\r' | tail -n 1
    return 0
  fi

  die "neither curl nor wget is installed"
}

version_from_location() {
  tag=$(printf '%s' "$1" | sed -n 's#.*/releases/tag/\([^/?#]*\).*#\1#p')

  [ -n "$tag" ] || return 1

  printf '%s' "${tag#v}"
}

check_version() {
  case $1 in
    '' | */* | *' '*) die "the latest release page did not redirect to a version tag: $latest_release_page" ;;
  esac
}

host_of() {
  case $1 in
    *://*) host=${1#*://} ;;
    *) return 1 ;;
  esac

  host=${host%%/*}
  host=${host##*@}
  printf '%s' "$host" | tr '[:upper:]' '[:lower:]'
}

asset_url_of() {
  awk -v target="$2" '
    BEGIN { RS = "}" }
    {
      record = $0
      gsub(/[[:space:]]/, "", record)
      head = substr(record, 1, index(record, "\"name\":\"" target "\""))
      url = ""
      while (match(head, /"url":"[^"]*"/)) {
        url = substr(head, RSTART, RLENGTH)
        head = substr(head, RSTART + RLENGTH)
      }
      if (url == "") next
      sub(/^"url":"/, "", url)
      sub(/"$/, "", url)
      print url
      exit
    }
  ' "$1"
}

# The allowlist "bandar update" already applies: a feed may rename an asset, but it does not get to
# name a host that would receive the token.
require_allowed_asset() {
  asset_host=$(host_of "$1" || true)

  if [ -n "$asset_host" ] && asset_host_allowed "$asset_host"; then
    return 0
  fi

  die "asset $2 is served from ${asset_host:-an unparsable url}, which is not api.github.com, github.com, objects.githubusercontent.com, release-assets.githubusercontent.com, or the BANDAR_RELEASE_API_URL host: not sending the token there"
}

asset_host_allowed() {
  case $1 in
    api.github.com | github.com | objects.githubusercontent.com | release-assets.githubusercontent.com) return 0 ;;
  esac

  [ "$1" = "$feed_host" ]
}

if [ -n "${BANDAR_VERSION:-}" ]; then
  version=${BANDAR_VERSION#v}
  case $version in
    '' | */* | *' '*) die "BANDAR_VERSION must look like 0.1.0, got '$BANDAR_VERSION'" ;;
  esac
elif [ -n "$api" ]; then
  download_authed "$api" "$tmp/latest.json" application/vnd.github+json ||
    die "cannot read the latest release from $api"

  tag=$(sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$tmp/latest.json" | head -n 1)
  [ -n "$tag" ] || die "no tag_name in the response from $api"
  version=${tag#v}
else
  location=$(fetch_location "$latest_release_page") ||
    die "cannot read the latest release page: $latest_release_page"

  version=$(version_from_location "$location") ||
    die "the latest release page did not redirect to a version tag: $latest_release_page"
  check_version "$version"
fi

asset=bandar-$version-$os-$arch
binary=bandar
if [ "$os" = windows ]; then
  asset=$asset.exe
  binary=bandar.exe
fi
asset_sha=$asset.sha256

if [ -n "$api" ]; then
  feed_host=$(host_of "$api" || true)

  case $api in
    */latest) tags_url=${api%/latest}/tags/v$version ;;
    *) tags_url=${api%/}/tags/v$version ;;
  esac

  download_authed "$tags_url" "$tmp/release.json" application/vnd.github+json ||
    die "cannot read release v$version from $tags_url"

  asset_url=$(asset_url_of "$tmp/release.json" "$asset")
  [ -n "$asset_url" ] || die "release v$version publishes no $asset asset"
  require_allowed_asset "$asset_url" "$asset"

  sha_url=$(asset_url_of "$tmp/release.json" "$asset_sha")
  [ -n "$sha_url" ] || die "release v$version publishes no $asset_sha asset"
  require_allowed_asset "$sha_url" "$asset_sha"

  printf 'bandar: downloading %s %s\n' "$version" "$asset"
  download_authed "$asset_url" "$tmp/$asset" || die "cannot download the $asset asset from the API"
  download_authed "$sha_url" "$tmp/$asset_sha" || die "cannot download the $asset_sha asset from the API"
else
  base=$web/releases/download/v$version
  printf 'bandar: downloading %s/%s\n' "$base" "$asset"
  plain_or_die "$base/$asset" "$tmp/$asset"
  plain_or_die "$base/$asset_sha" "$tmp/$asset_sha"
fi

expected=$(awk 'NR == 1 { print $1 }' "$tmp/$asset_sha")
[ -n "$expected" ] || die "$asset_sha is empty"
case $expected in
  *[!0-9a-fA-F]*) die "$asset_sha does not start with a sha256 digest" ;;
esac
expected=$(printf '%s' "$expected" | tr 'A-F' 'a-f')
actual=$(sha256_of "$tmp/$asset")

[ "$actual" = "$expected" ] || die "checksum mismatch for $asset: published $expected, downloaded $actual"

target=$install_dir/$binary
staged=$install_dir/.$binary.$$
manifest=$config_dir/install.json
staged_manifest=$config_dir/.install.json.$$
previous=$tmp/install.json.previous
had_manifest=0

restore_manifest() {
  if [ "$had_manifest" -eq 1 ]; then
    mv -f "$previous" "$manifest" 2>/dev/null || true
  else
    rm -f "$manifest" 2>/dev/null || true
  fi
}

mkdir -p "$config_dir" || die "cannot create $config_dir"
chmod 700 "$config_dir" || die "cannot set mode 700 on $config_dir"

if [ -f "$manifest" ]; then
  cp "$manifest" "$previous" || die "cannot read $manifest"
  had_manifest=1
fi

# A quote, a backslash, or a control character in the path has to reach install.json escaped. An
# unescaped one writes a manifest that "bandar update" calls unreadable from then on, and the binary
# it points at can never be replaced again.
json_escape() {
  printf '%s' "$1" | awk '
    BEGIN { RS = "\001"; ORS = ""; bs = "\\"; dq = "\"" }
    {
      escaped = ""
      for (i = 1; i <= length($0); i += 1) {
        character = substr($0, i, 1)
        if (character == bs) escaped = escaped bs bs
        else if (character == dq) escaped = escaped bs dq
        else if (character == "\n") escaped = escaped bs "n"
        else if (character == "\r") escaped = escaped bs "r"
        else if (character == "\t") escaped = escaped bs "t"
        else escaped = escaped character
      }
      printf "%s", escaped
    }'
}

# The manifest lands before the binary. A manifest that cannot be written must leave no new binary,
# because a binary with no manifest is one "bandar update" can never replace; the reverse order
# fails the other way, and the manifest is restored if the binary step fails.
printf '{"source":"install-script","version":"%s","path":"%s"}\n' \
  "$version" "$(json_escape "$target")" >"$staged_manifest" ||
  die "cannot write $staged_manifest"
mv -f "$staged_manifest" "$manifest" || {
  rm -f "$staged_manifest"
  die "cannot write $manifest"
}

cp "$tmp/$asset" "$staged" || {
  rm -f "$staged"
  restore_manifest
  die "cannot copy the binary into $install_dir"
}
chmod 755 "$staged" || {
  rm -f "$staged"
  restore_manifest
  die "cannot make $staged executable"
}
mv -f "$staged" "$target" || {
  rm -f "$staged"
  restore_manifest
  die "cannot move the binary into place at $target"
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
