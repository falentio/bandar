#!/bin/sh
# Runs the real install.sh against a stub release served from 127.0.0.1, so no
# case can reach github.com.
set -eu

ROOT=$(cd "$(dirname "$0")/.." && pwd -P)
INSTALLER=$ROOT/install.sh
VERSION=9.9.9
STUB_TOKEN=stub-token-123
WORK=$(cd "$(mktemp -d "${TMPDIR:-/tmp}/bandar-install-test.XXXXXX")" && pwd -P)
STUB=$WORK/stub
PORT_FILE=$WORK/port
REQUEST_LOG=$WORK/requests.log
checks=0
failures=0

command -v bun >/dev/null 2>&1 || {
  printf 'install-test: bun is required to serve the stub release\n' >&2
  exit 1
}

raw_os=$(uname -s)
case $raw_os in
  Linux) os=linux ;;
  MINGW* | MSYS* | CYGWIN*) os=windows ;;
  *) os=$(printf '%s' "$raw_os" | tr '[:upper:]' '[:lower:]') ;;
esac
raw_arch=$(uname -m)
case $raw_arch in
  x86_64 | amd64 | AMD64) arch=x64 ;;
  aarch64 | arm64 | ARM64) arch=arm64 ;;
  *) arch=$(printf '%s' "$raw_arch" | tr '[:upper:]' '[:lower:]') ;;
esac
exe=
if [ "$os" = windows ]; then
  exe=.exe
fi
binary=bandar$exe
asset=bandar-$VERSION-$os-$arch$exe
asset_sha=$asset.sha256

cat >"$WORK/server.ts" <<'TSSERVER'
import { appendFileSync } from "node:fs";

const root = process.argv[2] ?? "";
const portFile = process.argv[3] ?? "";
const logFile = process.argv[4] ?? "";
const token = process.argv[5] ?? "";
const osArch = process.argv[6] ?? "";
const extension = osArch.startsWith("windows") ? ".exe" : "";

const latest = async (): Promise<string> =>
  (await Bun.file(root + "/latest").text()).trim();

const assetName = (version: string): string =>
  "bandar-" + version + "-" + osArch + extension;

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const url = new URL(request.url);
    const origin = "http://127.0.0.1:" + server.port;
    const auth = request.headers.get("authorization") ?? "";
    const accept = request.headers.get("accept") ?? "";
    appendFileSync(logFile, url.pathname + url.search + " auth=" + auth + " accept=" + accept + "\n");

    if (url.pathname === "/releases/latest" && !accept.includes("vnd.github")) {
      const version = await latest();
      return new Response(null, {
        status: 302,
        headers: { location: origin + "/releases/tag/v" + version },
      });
    }

    if (url.pathname === "/releases/latest" || url.pathname.startsWith("/releases/tags/")) {
      if (auth !== "Bearer " + token) return new Response("unauthorized\n", { status: 401 });
      const version =
        url.pathname === "/releases/latest"
          ? await latest()
          : url.pathname.slice("/releases/tags/v".length);
      const asset = assetName(version);
      return Response.json({
        tag_name: "v" + version,
        assets: [
          { url: origin + "/api/assets/v" + version + "/binary", name: asset },
          { url: origin + "/api/assets/v" + version + "/checksum", name: asset + ".sha256" },
        ],
      });
    }

    if (url.pathname.startsWith("/api/assets/")) {
      if (auth !== "Bearer " + token) return new Response("unauthorized\n", { status: 401 });
      const parts = url.pathname.split("/");
      const version = (parts[3] ?? "").replace(/^v/, "");
      const kind = parts[4] === "checksum" ? "checksum" : "binary";
      const name = assetName(version) + (kind === "checksum" ? ".sha256" : "");
      const file = Bun.file(root + "/rel/v" + version + "/" + name);
      if (!(await file.exists())) return new Response("not found\n", { status: 404 });
      return new Response(file);
    }

    if (url.pathname.startsWith("/releases/download/")) {
      const file = Bun.file(root + "/rel" + decodeURIComponent(url.pathname.replace("/releases/download", "")));
      if (!(await file.exists())) return new Response("not found\n", { status: 404 });
      return new Response(file);
    }

    return new Response("not found\n", { status: 404 });
  },
});
await Bun.write(portFile, String(server.port));
TSSERVER

bun "$WORK/server.ts" "$STUB" "$PORT_FILE" "$REQUEST_LOG" "$STUB_TOKEN" "$os-$arch" \
  >"$WORK/server.log" 2>&1 &
server_pid=$!

cleanup() {
  kill "$server_pid" 2>/dev/null || true
  rm -rf "$WORK"
}

trap cleanup EXIT

i=0
while [ ! -s "$PORT_FILE" ]; do
  i=$((i + 1))
  if [ "$i" -gt 10 ]; then
    printf 'install-test: the stub server did not start\n' >&2
    cat "$WORK/server.log" >&2
    exit 1
  fi
  sleep 1
done

base=http://127.0.0.1:$(cat "$PORT_FILE")

pass() {
  checks=$((checks + 1))
  printf 'ok   %s\n' "$1"
}

fail() {
  checks=$((checks + 1))
  failures=$((failures + 1))
  printf 'FAIL %s: %s\n' "$1" "$2"
}

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

mode_of() {
  if stat -c %a "$1" >/dev/null 2>&1; then
    stat -c %a "$1"
  else
    stat -f %Lp "$1"
  fi
}

publish() {
  publish_version=$1
  publish_body=$2
  publish_asset=bandar-$publish_version-$os-$arch$exe
  publish_dir=$STUB/rel/v$publish_version

  mkdir -p "$publish_dir"
  cp "$publish_body" "$publish_dir/$publish_asset"
  ( cd "$publish_dir" && sha256_of "$publish_asset" >"$publish_asset.sha256" )
  printf '%s\n' "$publish_version" >"$STUB/latest"
  printf '%s\n' "$publish_asset"
}

cat >"$WORK/serves.sh" <<'STUB'
#!/bin/sh
printf 'bandar: listening\n'
STUB

cat >"$WORK/service.sh" <<'STUB'
#!/bin/sh
if [ "${1:-}" = "install-service" ]; then
  printf '%s\n' "$*" >>"$BANDAR_STUB_LOG"
  exit 0
fi
printf 'bandar: listening\n'
STUB

cat >"$WORK/no-command.sh" <<'STUB'
#!/bin/sh
if [ "${1:-}" = "install-service" ]; then
  printf 'bandar: unknown command "%s"\n' "$1" >&2
  exit 127
fi
printf 'bandar: listening\n'
STUB

cat >"$WORK/hangs.sh" <<'STUB'
#!/bin/sh
if [ "${1:-}" = "install-service" ]; then
  exec sleep 60
fi
printf 'bandar: listening\n'
STUB

publish "$VERSION" "$WORK/service.sh" >/dev/null
publish 9.9.8 "$WORK/no-command.sh" >/dev/null
publish 9.9.7 "$WORK/hangs.sh" >/dev/null
publish 9.9.6 "$WORK/serves.sh" >/dev/null
printf '0000000000000000000000000000000000000000000000000000000000000000  %s\n' \
  "bandar-9.9.6-$os-$arch$exe" >"$STUB/rel/v9.9.6/bandar-9.9.6-$os-$arch$exe.sha256"
printf '%s\n' "$VERSION" >"$STUB/latest"

RUN_STATUS=0
RUN_OUTPUT=

# The anonymous path: no token, and the web override points every request at the stub.
run_install() {
  case_dir=$1
  shift

  RUN_STATUS=0
  RUN_OUTPUT=$(env BANDAR_VERSION= BANDAR_SCOPE= BANDAR_SERVICE_TIMEOUT= \
    BANDAR_GITHUB_TOKEN= GH_TOKEN= GITHUB_TOKEN= BANDAR_RELEASE_API_URL= \
    TMPDIR="$case_dir/tmp" BANDAR_INSTALL_DIR="$case_dir/bin" \
    BANDAR_CONFIG_DIR="$case_dir/config" \
    BANDAR_RELEASE_WEB_URL="$base" \
    "$@" sh "$INSTALLER" 2>&1) || RUN_STATUS=$?
}

run_piped() {
  case_dir=$1
  shift

  RUN_STATUS=0
  # The pipe is the invocation under test: "curl | sh" has no script path.
  # shellcheck disable=SC2002
  RUN_OUTPUT=$(cat "$INSTALLER" | env BANDAR_VERSION= BANDAR_SCOPE= BANDAR_SERVICE_TIMEOUT= \
    BANDAR_GITHUB_TOKEN= GH_TOKEN= GITHUB_TOKEN= BANDAR_RELEASE_API_URL= \
    TMPDIR="$case_dir/tmp" BANDAR_INSTALL_DIR="$case_dir/bin" \
    BANDAR_CONFIG_DIR="$case_dir/config" \
    BANDAR_RELEASE_WEB_URL="$base" \
    "$@" sh 2>&1) || RUN_STATUS=$?
}

# The private-fork path: the API feed is selected, so a token is required and sent.
run_api() {
  case_dir=$1
  shift

  RUN_STATUS=0
  RUN_OUTPUT=$(env BANDAR_VERSION= BANDAR_SCOPE= BANDAR_SERVICE_TIMEOUT= \
    BANDAR_GITHUB_TOKEN= GH_TOKEN= GITHUB_TOKEN= \
    TMPDIR="$case_dir/tmp" BANDAR_INSTALL_DIR="$case_dir/bin" \
    BANDAR_CONFIG_DIR="$case_dir/config" BANDAR_RELEASE_WEB_URL="$base" \
    BANDAR_RELEASE_API_URL="$base/releases/latest" \
    "$@" sh "$INSTALLER" 2>&1) || RUN_STATUS=$?
}

expect_status() {
  if [ "$2" -eq "$RUN_STATUS" ]; then
    pass "$1"
  else
    fail "$1" "exit $RUN_STATUS, expected $2; output:
$RUN_OUTPUT"
  fi
}

expect_contains() {
  case $RUN_OUTPUT in
    *"$2"*) pass "$1" ;;
    *) fail "$1" "output does not contain '$2': $RUN_OUTPUT" ;;
  esac
}

expect_absent() {
  case $RUN_OUTPUT in
    *"$2"*) fail "$1" "output contains '$2': $RUN_OUTPUT" ;;
    *) pass "$1" ;;
  esac
}

expect_installed() {
  if [ -x "$2" ]; then
    pass "$1"
  else
    fail "$1" "no executable at $2; output:
$RUN_OUTPUT"
  fi
}

expect_missing() {
  if [ -e "$2" ]; then
    fail "$1" "$2 exists"
  else
    pass "$1"
  fi
}

expect_manifest() {
  expect_want=$(printf '{"source":"install-script","version":"%s","path":"%s"}' "$3" "$4")
  expect_got=$(cat "$2" 2>/dev/null || true)
  if [ "$expect_want" = "$expect_got" ]; then
    pass "$1"
  else
    fail "$1" "install.json is [$expect_got], expected [$expect_want]"
  fi
}

expect_mode() {
  expect_got_mode=$(mode_of "$2")
  if [ "$expect_got_mode" = "$3" ]; then
    pass "$1"
  else
    fail "$1" "$2 has mode $expect_got_mode, expected $3"
  fi
}

expect_empty_dir() {
  if [ -z "$(ls -A "$2" 2>/dev/null)" ]; then
    pass "$1"
  else
    fail "$1" "$2 still holds: $(ls -A "$2")"
  fi
}

request_field() {
  sed -n "s/.* $1=\([^ ]*\).*/\1/p" "$REQUEST_LOG"
}

printf 'case: anonymous latest install (piped)\n'
case_dir=$WORK/latest
mkdir -p "$case_dir/bin" "$case_dir/config" "$case_dir/tmp"
: >"$REQUEST_LOG"
run_piped "$case_dir"
expect_status "latest: exits 0" 0
expect_installed "latest: installs the binary" "$case_dir/bin/$binary"
expect_manifest "latest: records source, version, and path" "$case_dir/config/install.json" \
  "$VERSION" "$case_dir/bin/$binary"
expect_mode "latest: config dir is mode 700" "$case_dir/config" 700
expect_empty_dir "latest: removes its temp dir" "$case_dir/tmp"
if grep -q '^/releases/latest ' "$REQUEST_LOG"; then
  pass "latest: reads the release page for the tag"
else
  fail "latest: reads the release page for the tag" "$(cat "$REQUEST_LOG")"
fi
if grep -q "^/releases/download/v$VERSION/bandar-$VERSION-$os-$arch$exe " "$REQUEST_LOG"; then
  pass "latest: downloads the public asset path"
else
  fail "latest: downloads the public asset path" "$(cat "$REQUEST_LOG")"
fi
if [ -z "$(request_field auth | grep -v '^$' | head -n 1)" ]; then
  pass "latest: sends no Authorization header"
else
  fail "latest: sends no Authorization header" "$(grep -v 'auth= ' "$REQUEST_LOG")"
fi
expect_absent "latest: never mentions a token" "token"

printf '\ncase: pinned public version (direct executable)\n'
case_dir=$WORK/pinned
mkdir -p "$case_dir/bin" "$case_dir/config" "$case_dir/tmp"
run_install "$case_dir" BANDAR_VERSION="$VERSION"
expect_status "pinned: direct executable exits 0" 0
expect_installed "pinned: installs the binary" "$case_dir/bin/$binary"
expect_manifest "pinned: records the pinned version" "$case_dir/config/install.json" \
  "$VERSION" "$case_dir/bin/$binary"

printf '\ncase: service handoff\n'
case_dir=$WORK/service
mkdir -p "$case_dir/bin" "$case_dir/config" "$case_dir/tmp"
publish "$VERSION" "$WORK/service.sh" >/dev/null
run_install "$case_dir" BANDAR_SCOPE=user BANDAR_STUB_LOG="$case_dir/service.log"
expect_status "service: exits 0" 0
expect_installed "service: installs the binary" "$case_dir/bin/$binary"
expect_want=$(cat "$case_dir/service.log" 2>/dev/null || true)
if [ "$expect_want" = "install-service --scope user" ]; then
  pass "service: calls install-service with the scope"
else
  fail "service: calls install-service with the scope" "stub saw [$expect_want]"
fi
expect_contains "service: reports the registration" "service registered"

printf '\ncase: a binary without install-service\n'
case_dir=$WORK/no-command
mkdir -p "$case_dir/bin" "$case_dir/config" "$case_dir/tmp"
publish 9.9.8 "$WORK/no-command.sh" >/dev/null
run_install "$case_dir" BANDAR_SCOPE=system
expect_status "no install-service: still exits 0" 0
expect_installed "no install-service: installs the binary" "$case_dir/bin/$binary"
expect_contains "no install-service: reports the skip" "skipped the service step"

printf '\ncase: a hanging install-service\n'
case_dir=$WORK/hangs
mkdir -p "$case_dir/bin" "$case_dir/config" "$case_dir/tmp"
publish 9.9.7 "$WORK/hangs.sh" >/dev/null
started=$(date +%s)
run_install "$case_dir" BANDAR_SCOPE=user BANDAR_SERVICE_TIMEOUT=2
elapsed=$(($(date +%s) - started))
expect_status "hanging install-service: still exits 0" 0
expect_contains "hanging install-service: reports the skip" "skipped the service step"
if [ "$elapsed" -le 15 ]; then
  pass "hanging install-service: stops after the timeout"
else
  fail "hanging install-service: stops after the timeout" "took $elapsed s"
fi

printf '\ncase: private fork override\n'
case_dir=$WORK/token
mkdir -p "$case_dir/bin" "$case_dir/config" "$case_dir/tmp"
: >"$REQUEST_LOG"
run_api "$case_dir" BANDAR_VERSION="$VERSION" BANDAR_GITHUB_TOKEN="$STUB_TOKEN"
expect_status "token: exits 0" 0
expect_installed "token: installs the binary" "$case_dir/bin/$binary"
expect_manifest "token: records source, version, and path" "$case_dir/config/install.json" \
  "$VERSION" "$case_dir/bin/$binary"
if grep -q '^/releases/tags/v'"$VERSION"' ' "$REQUEST_LOG"; then
  pass "token: resolves the release through the tags API"
else
  fail "token: resolves the release through the tags API" "$(cat "$REQUEST_LOG")"
fi
if grep -q "auth=Bearer $STUB_TOKEN" "$REQUEST_LOG"; then
  pass "token: sends the Authorization header"
else
  fail "token: sends the Authorization header" "$(cat "$REQUEST_LOG")"
fi
if grep -q 'accept=application/octet-stream' "$REQUEST_LOG"; then
  pass "token: asks for the asset bytes"
else
  fail "token: asks for the asset bytes" "$(cat "$REQUEST_LOG")"
fi
if grep -q '^/api/assets/' "$REQUEST_LOG"; then
  pass "token: downloads from the asset api url"
else
  fail "token: downloads from the asset api url" "$(cat "$REQUEST_LOG")"
fi
if grep -q 'token=' "$REQUEST_LOG"; then
  fail "token: never appears in a URL" "$(grep 'token=' "$REQUEST_LOG")"
else
  pass "token: never appears in a URL"
fi
expect_absent "token: stays out of the output" "$STUB_TOKEN"
if grep -rq "$STUB_TOKEN" "$case_dir/bin" "$case_dir/config" 2>/dev/null; then
  fail "token: is never written next to the install" "$(grep -rl "$STUB_TOKEN" "$case_dir/bin" "$case_dir/config")"
else
  pass "token: is never written next to the install"
fi

printf '\ncase: private fork override resolving the latest version\n'
printf '%s\n' "$VERSION" >"$STUB/latest"
case_dir=$WORK/token-latest
mkdir -p "$case_dir/bin" "$case_dir/config" "$case_dir/tmp"
run_api "$case_dir" BANDAR_GITHUB_TOKEN="$STUB_TOKEN"
expect_status "token latest: exits 0" 0
expect_installed "token latest: installs the binary" "$case_dir/bin/$binary"
expect_manifest "token latest: records the resolved version" "$case_dir/config/install.json" \
  "$VERSION" "$case_dir/bin/$binary"

printf '\ncase: the API override without a token\n'
case_dir=$WORK/api-no-token
mkdir -p "$case_dir/bin" "$case_dir/config" "$case_dir/tmp"
: >"$REQUEST_LOG"
run_api "$case_dir" BANDAR_VERSION="$VERSION"
expect_status "api without a token: exits 1" 1
expect_contains "api without a token: names the variable and the token variable" \
  "BANDAR_RELEASE_API_URL reads a private fork, so it needs a GitHub token: set BANDAR_GITHUB_TOKEN"
expect_missing "api without a token: installs nothing" "$case_dir/bin/$binary"
if [ -s "$REQUEST_LOG" ]; then
  fail "api without a token: sends no request" "$(cat "$REQUEST_LOG")"
else
  pass "api without a token: sends no request"
fi

printf '\ncase: the token stays out of argv\n'
real_curl=$(command -v curl || true)
if [ -n "$real_curl" ]; then
  mkdir -p "$WORK/shim"
  cat >"$WORK/shim/curl" <<SHIM
#!/bin/sh
printf '%s\n' "\$*" >>"$WORK/curl-argv.log"
exec "$real_curl" "\$@"
SHIM
  chmod 755 "$WORK/shim/curl"

  case_dir=$WORK/token-argv
  mkdir -p "$case_dir/bin" "$case_dir/config" "$case_dir/tmp"
  : >"$WORK/curl-argv.log"
  run_api "$case_dir" PATH="$WORK/shim:$PATH" \
    BANDAR_VERSION="$VERSION" BANDAR_GITHUB_TOKEN="$STUB_TOKEN"
  expect_status "token argv: exits 0 through a curl shim" 0
  if grep -q -- '-K ' "$WORK/curl-argv.log"; then
    if grep -q "$STUB_TOKEN" "$WORK/curl-argv.log"; then
      fail "token: stays out of the curl arguments" "$(grep "$STUB_TOKEN" "$WORK/curl-argv.log")"
    else
      pass "token: stays out of the curl arguments"
    fi
  else
    printf 'skip token argv: this curl read the header from its arguments\n'
  fi
fi

printf '\ncase: GH_TOKEN and GITHUB_TOKEN\n'
case_dir=$WORK/token-gh
mkdir -p "$case_dir/bin" "$case_dir/config" "$case_dir/tmp"
run_api "$case_dir" BANDAR_VERSION="$VERSION" GH_TOKEN="$STUB_TOKEN"
expect_status "GH_TOKEN: exits 0" 0
expect_installed "GH_TOKEN: installs the binary" "$case_dir/bin/$binary"

case_dir=$WORK/token-github
mkdir -p "$case_dir/bin" "$case_dir/config" "$case_dir/tmp"
run_api "$case_dir" BANDAR_VERSION="$VERSION" GITHUB_TOKEN="$STUB_TOKEN"
expect_status "GITHUB_TOKEN: exits 0" 0
expect_installed "GITHUB_TOKEN: installs the binary" "$case_dir/bin/$binary"

case_dir=$WORK/token-precedence
mkdir -p "$case_dir/bin" "$case_dir/config" "$case_dir/tmp"
run_api "$case_dir" BANDAR_VERSION="$VERSION" \
  BANDAR_GITHUB_TOKEN=wrong-token GH_TOKEN="$STUB_TOKEN"
expect_status "BANDAR_GITHUB_TOKEN wins over GH_TOKEN" 1
expect_missing "precedence: installs nothing with the rejected token" "$case_dir/bin/$binary"
expect_absent "precedence: keeps the rejected token out of the output" "wrong-token"

printf '\ncase: a missing public asset\n'
case_dir=$WORK/missing
mkdir -p "$case_dir/bin" "$case_dir/config" "$case_dir/tmp"
run_install "$case_dir" BANDAR_VERSION=9.9.5
expect_status "missing asset: exits 1 on a 404" 1
expect_contains "missing asset: names the asset" "releases/download/v9.9.5/bandar-9.9.5-$os-$arch$exe"
expect_contains "missing asset: names the private-fork override" "BANDAR_RELEASE_API_URL"
expect_absent "missing asset: does not fall through to a checksum error" "checksum"
expect_missing "missing asset: installs nothing" "$case_dir/bin/$binary"
printf '\ninstall.sh output for a missing asset:\n'
printf '%s\n' "$RUN_OUTPUT" | sed 's/^/  /'

printf '\ncase: a bad checksum\n'
case_dir=$WORK/bad-checksum
mkdir -p "$case_dir/bin" "$case_dir/config" "$case_dir/tmp"
run_install "$case_dir" BANDAR_VERSION=9.9.6
expect_status "bad checksum: exits 1" 1
expect_missing "bad checksum: installs nothing" "$case_dir/bin/$binary"
expect_contains "bad checksum: names the mismatch" "checksum mismatch"
expect_empty_dir "bad checksum: removes its temp dir" "$case_dir/tmp"
printf '\ninstall.sh output on a bad checksum:\n'
printf '%s\n' "$RUN_OUTPUT" | sed 's/^/  /'

printf '\ncase: a relative config directory\n'
case_dir=$WORK/relative-config
mkdir -p "$case_dir/bin" "$case_dir/tmp"
run_install "$case_dir" BANDAR_VERSION="$VERSION" BANDAR_CONFIG_DIR=relative/config
expect_status "relative config dir: exits 1" 1
expect_contains "relative config dir: names the absolute-path rule" \
  "BANDAR_CONFIG_DIR must be an absolute path, got 'relative/config'"
expect_missing "relative config dir: installs nothing" "$case_dir/bin/$binary"

printf '\ncase: a blank config directory\n'
case_dir=$WORK/blank-config
mkdir -p "$case_dir/bin" "$case_dir/tmp"
run_install "$case_dir" BANDAR_VERSION="$VERSION" BANDAR_CONFIG_DIR=" "
expect_status "blank config dir: exits 1" 1
expect_contains "blank config dir: names the rule" "BANDAR_CONFIG_DIR must be an absolute path"
expect_missing "blank config dir: installs nothing" "$case_dir/bin/$binary"

printf '\ncase: a config directory at a file path\n'
case_dir=$WORK/config-is-file
mkdir -p "$case_dir/bin" "$case_dir/tmp"
printf 'not a directory\n' >"$case_dir/config"
run_install "$case_dir" BANDAR_VERSION="$VERSION"
expect_status "unwritable config dir: exits 1" 1
expect_missing "unwritable config dir: installs no binary" "$case_dir/bin/$binary"

printf '\ncase: the manifest cannot be written\n'
case_dir=$WORK/manifest-failure
mkdir -p "$case_dir/bin" "$case_dir/config" "$case_dir/tmp" "$WORK/shim-mv"
cat >"$WORK/shim-mv/mv" <<'SHIM'
#!/bin/sh
for argument in "$@"; do
  case $argument in
    */install.json) printf 'mv: refusing to write install.json\n' >&2; exit 1 ;;
  esac
done
exec /bin/mv "$@"
SHIM
chmod 755 "$WORK/shim-mv/mv"
run_install "$case_dir" PATH="$WORK/shim-mv:$PATH" BANDAR_VERSION="$VERSION"
expect_status "manifest failure: exits 1" 1
expect_contains "manifest failure: says it cannot write the manifest" "cannot write"
expect_missing "manifest failure: leaves no binary behind" "$case_dir/bin/$binary"
expect_missing "manifest failure: leaves no manifest behind" "$case_dir/config/install.json"

printf '\ncase: the binary cannot be moved into place\n'
case_dir=$WORK/binary-failure
mkdir -p "$case_dir/bin" "$case_dir/config" "$case_dir/tmp" "$WORK/shim-mv2"
printf '{"source":"manual","version":"0.0.1","path":"/old/bin/bandar"}\n' >"$case_dir/config/install.json"
cp "$case_dir/config/install.json" "$WORK/binary-failure.expected"
cat >"$WORK/shim-mv2/mv" <<'SHIM'
#!/bin/sh
for argument in "$@"; do
  case $argument in
    */bin/bandar) printf 'mv: refusing to replace the binary\n' >&2; exit 1 ;;
  esac
done
exec /bin/mv "$@"
SHIM
chmod 755 "$WORK/shim-mv2/mv"
run_install "$case_dir" PATH="$WORK/shim-mv2:$PATH" BANDAR_VERSION="$VERSION"
expect_status "binary failure: exits 1" 1
expect_contains "binary failure: says it cannot move the binary" "cannot move the binary into place"
expect_missing "binary failure: leaves no binary behind" "$case_dir/bin/$binary"
if cmp -s "$case_dir/config/install.json" "$WORK/binary-failure.expected"; then
  pass "binary failure: restores the previous manifest"
else
  fail "binary failure: restores the previous manifest" "$(cat "$case_dir/config/install.json")"
fi

printf '\ncase: an unwritable install directory\n'
case_dir=$WORK/readonly
mkdir -p "$case_dir/bin" "$case_dir/config" "$case_dir/tmp"
chmod 500 "$case_dir/bin"
if [ "$(id -u)" -eq 0 ]; then
  printf 'skip readonly target: running as root, who can write anywhere\n'
else
  run_install "$case_dir" BANDAR_INSTALL_DIR="$case_dir/bin"
  expect_status "readonly target: exits 1" 1
  expect_contains "readonly target: prints the sudo command" "rerun with sudo:"
  expect_contains "readonly target: names the install dir" "sudo BANDAR_INSTALL_DIR=\"$case_dir/bin\""
  expect_missing "readonly target: installs nothing" "$case_dir/bin/$binary"
fi
chmod 700 "$case_dir/bin"

printf '\ncase: an unsupported platform\n'
case_dir=$WORK/unsupported
mkdir -p "$case_dir/bin" "$case_dir/config" "$case_dir/tmp" "$WORK/fakebin"
cat >"$WORK/fakebin/uname" <<'STUB'
#!/bin/sh
case $1 in
  -s) printf 'Darwin\n' ;;
  -m) printf 'x86_64\n' ;;
  *) printf 'Darwin\n' ;;
esac
STUB
chmod 755 "$WORK/fakebin/uname"
run_install "$case_dir" PATH="$WORK/fakebin:$PATH"
expect_status "unsupported os: exits 1" 1
expect_contains "unsupported os: names the pair" "no release for darwin-x64"
expect_missing "unsupported os: installs nothing" "$case_dir/bin/$binary"
printf '\ninstall.sh output on an unsupported platform:\n'
printf '%s\n' "$RUN_OUTPUT" | sed 's/^/  /'

printf '\n%s checks, %s failed\n' "$checks" "$failures"

if [ "$failures" -ne 0 ]; then
  exit 1
fi
