#!/bin/sh
# Runs the real install.sh against a stub release served from 127.0.0.1, so no
# case can reach github.com.
set -eu

ROOT=$(cd "$(dirname "$0")/.." && pwd -P)
INSTALLER=$ROOT/install.sh
VERSION=9.9.9
WORK=$(cd "$(mktemp -d "${TMPDIR:-/tmp}/bandar-install-test.XXXXXX")" && pwd -P)
STUB=$WORK/stub
PORT_FILE=$WORK/port
checks=0
failures=0

command -v bun >/dev/null 2>&1 || {
  printf 'install-test: bun is required to serve the stub release\n' >&2
  exit 1
}

printf '%s\n' 'const root = process.argv[2] ?? "";
const portFile = process.argv[3] ?? "";
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const path = root + decodeURIComponent(new URL(request.url).pathname);
    const file = Bun.file(path);
    if (!(await file.exists())) return new Response("not found\n", { status: 404 });
    return new Response(file);
  },
});
await Bun.write(portFile, String(server.port));' >"$WORK/server.ts"

bun "$WORK/server.ts" "$STUB" "$PORT_FILE" >"$WORK/server.log" 2>&1 &
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

publish() {
  publish_version=$1
  publish_body=$2
  publish_asset=bandar-$publish_version-$os-$arch$exe
  publish_dir=$STUB/download/v$publish_version

  mkdir -p "$publish_dir"
  cp "$publish_body" "$publish_dir/$publish_asset"
  ( cd "$publish_dir" && sha256_of "$publish_asset" >"$publish_asset.sha256" )
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

asset=$(publish "$VERSION" "$WORK/service.sh")
publish 9.9.8 "$WORK/no-command.sh" >/dev/null
publish 9.9.7 "$WORK/hangs.sh" >/dev/null
publish 9.9.6 "$WORK/serves.sh" >/dev/null
printf '0000000000000000000000000000000000000000000000000000000000000000  %s\n' \
  "bandar-9.9.6-$os-$arch$exe" >"$STUB/download/v9.9.6/bandar-9.9.6-$os-$arch$exe.sha256"

mkdir -p "$STUB/releases"
printf '{\n  "tag_name": "v%s",\n  "assets": [\n    {"name": "%s"},\n    {"name": "%s.sha256"}\n  ]\n}\n' \
  "$VERSION" "$asset" "$asset" >"$STUB/releases/latest"

RUN_STATUS=0
RUN_OUTPUT=

run_install() {
  case_dir=$1
  shift

  RUN_STATUS=0
  RUN_OUTPUT=$(env BANDAR_VERSION= BANDAR_SCOPE= BANDAR_SERVICE_TIMEOUT= \
    TMPDIR="$case_dir/tmp" BANDAR_INSTALL_DIR="$case_dir/bin" \
    BANDAR_CONFIG_DIR="$case_dir/config" \
    BANDAR_RELEASE_BASE_URL="$base/download/v${PINNED:-$VERSION}" \
    BANDAR_RELEASE_API_URL="$base/releases/latest" \
    "$@" sh "$INSTALLER" 2>&1) || RUN_STATUS=$?
}

run_piped() {
  case_dir=$1
  shift

  RUN_STATUS=0
  # The pipe is the invocation under test: "curl | sh" has no script path.
  # shellcheck disable=SC2002
  RUN_OUTPUT=$(cat "$INSTALLER" | env BANDAR_VERSION= BANDAR_SCOPE= BANDAR_SERVICE_TIMEOUT= \
    TMPDIR="$case_dir/tmp" BANDAR_INSTALL_DIR="$case_dir/bin" \
    BANDAR_CONFIG_DIR="$case_dir/config" \
    BANDAR_RELEASE_BASE_URL="$base/download/v${PINNED:-$VERSION}" \
    BANDAR_RELEASE_API_URL="$base/releases/latest" \
    "$@" sh 2>&1) || RUN_STATUS=$?
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

case_dir=$WORK/latest
mkdir -p "$case_dir/bin" "$case_dir/config" "$case_dir/tmp"
PINNED=
run_piped "$case_dir"
expect_status "latest: exits 0" 0
expect_installed "latest: installs the binary" "$case_dir/bin/$binary"
expect_manifest "latest: records source, version, and path" "$case_dir/config/install.json" \
  "$VERSION" "$case_dir/bin/$binary"
expect_mode "latest: config dir is mode 700" "$case_dir/config" 700
expect_empty_dir "latest: removes its temp dir" "$case_dir/tmp"

case_dir=$WORK/pinned
mkdir -p "$case_dir/bin" "$case_dir/config" "$case_dir/tmp"
PINNED=$VERSION
run_install "$case_dir" BANDAR_VERSION="$VERSION"
expect_status "pinned: direct executable exits 0" 0
expect_installed "pinned: installs the binary" "$case_dir/bin/$binary"
expect_manifest "pinned: records the pinned version" "$case_dir/config/install.json" \
  "$VERSION" "$case_dir/bin/$binary"

case_dir=$WORK/service
mkdir -p "$case_dir/bin" "$case_dir/config" "$case_dir/tmp"
PINNED=$VERSION
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

case_dir=$WORK/no-command
mkdir -p "$case_dir/bin" "$case_dir/config" "$case_dir/tmp"
PINNED=9.9.8
run_install "$case_dir" BANDAR_VERSION=9.9.8 BANDAR_SCOPE=system
expect_status "no install-service: still exits 0" 0
expect_installed "no install-service: installs the binary" "$case_dir/bin/$binary"
expect_contains "no install-service: reports the skip" "skipped the service step"

case_dir=$WORK/hangs
mkdir -p "$case_dir/bin" "$case_dir/config" "$case_dir/tmp"
PINNED=9.9.7
started=$(date +%s)
run_install "$case_dir" BANDAR_VERSION=9.9.7 BANDAR_SCOPE=user BANDAR_SERVICE_TIMEOUT=2
elapsed=$(($(date +%s) - started))
expect_status "hanging install-service: still exits 0" 0
expect_contains "hanging install-service: reports the skip" "skipped the service step"
if [ "$elapsed" -le 15 ]; then
  pass "hanging install-service: stops after the timeout"
else
  fail "hanging install-service: stops after the timeout" "took $elapsed s"
fi

case_dir=$WORK/bad-checksum
mkdir -p "$case_dir/bin" "$case_dir/config" "$case_dir/tmp"
PINNED=9.9.6
run_install "$case_dir" BANDAR_VERSION=9.9.6
expect_status "bad checksum: exits 1" 1
expect_missing "bad checksum: installs nothing" "$case_dir/bin/$binary"
expect_contains "bad checksum: names the mismatch" "checksum mismatch"
expect_empty_dir "bad checksum: removes its temp dir" "$case_dir/tmp"
printf '\ninstall.sh output on a bad checksum:\n'
printf '%s\n' "$RUN_OUTPUT" | sed 's/^/  /'

case_dir=$WORK/readonly
mkdir -p "$case_dir/bin" "$case_dir/config" "$case_dir/tmp"
chmod 500 "$case_dir/bin"
PINNED=
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
PINNED=
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
