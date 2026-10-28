#!/usr/bin/env bash
# Proves bandar update against a loopback stub release feed. Nothing here reaches the network.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if ! command -v bun >/dev/null 2>&1; then
  echo "update-test: bun is not on PATH" >&2
  exit 1
fi

host="$(bun -e 'process.stdout.write(`${process.platform}-${process.arch}`)')"

if [ "$host" != "linux-x64" ]; then
  echo "update-test: SKIP, the stub names linux-x64 assets and this host is $host"
  exit 0
fi

unset BANDAR_GITHUB_TOKEN GH_TOKEN GITHUB_TOKEN BANDAR_UPDATE_URL BANDAR_CONFIG_DIR || true

work="$(mktemp -d)"
stub_pid=""

cleanup() {
  if [ -n "$stub_pid" ]; then kill "$stub_pid" 2>/dev/null || true; fi
  rm -rf "$work"
}

trap cleanup EXIT

mkdir -p "$work/site" "$work/logs"
STUB_TOKEN="stub-token"

cat >"$work/stub.ts" <<'STUB'
import { appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const site = Bun.env.STUB_SITE ?? "";
const log = Bun.env.STUB_LOG ?? "";
const latest = "/repos/falentio/bandar/releases/latest";

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(request) {
    const path = new URL(request.url).pathname;
    const authorization = request.headers.get("authorization") ?? "none";

    appendFileSync(log, `${path} ${authorization}\n`);

    const name =
      path === latest ? "latest.json" : path.startsWith("/asset/") ? path.slice(7) : "";
    const file = join(site, name);

    if (name === "" || name.includes("..") || !existsSync(file))
      return new Response("not found", { status: 404 });

    return new Response(Bun.file(file));
  },
});

console.log(server.port);
STUB

STUB_SITE="$work/site" STUB_LOG="$work/logs/requests.log" bun "$work/stub.ts" \
  >"$work/port" 2>"$work/stub.err" &
stub_pid=$!

for _ in $(seq 1 200); do
  if [ -s "$work/port" ]; then break; fi
  sleep 0.05
done

if [ ! -s "$work/port" ]; then
  echo "update-test: the stub server did not start" >&2

  cat "$work/stub.err" >&2

  exit 1
fi

API="http://127.0.0.1:$(cat "$work/port")"
installed="$(bun -e 'process.stdout.write((await Bun.file("package.json").json()).version)')"

echo "update-test: stub release feed at $API, installed version $installed"

failures=0

ok() { printf 'ok   %s\n' "$1"; }

fail() {
  printf 'FAIL %s - %s\n' "$1" "$2"
  failures=$((failures + 1))
}

status=0

run() {
  local name="$1"
  shift
  set +e
  "$@" >"$work/logs/$name.out" 2>"$work/logs/$name.err"
  status=$?
  set -e
}

expect_exit() {
  local name="$1" expected="$2"

  if [ "$status" -eq "$expected" ]; then
    ok "$name: exits $expected"
  else
    fail "$name" "exit $status, wanted $expected; stderr: $(tr '\n' '|' <"$work/logs/$name.err")"
  fi
}

expect_stdout() {
  local name="$1" text="$2"

  if grep -qxF -- "$text" "$work/logs/$name.out"; then
    ok "$name: prints $text"
  else
    fail "$name" "stdout missing '$text'; got: $(tr '\n' '|' <"$work/logs/$name.out")"
  fi
}

expect_stdout_empty() {
  local name="$1"

  if [ -s "$work/logs/$name.out" ]; then
    fail "$name" "stdout is not empty: $(tr '\n' '|' <"$work/logs/$name.out")"
  else
    ok "$name: prints nothing on stdout"
  fi
}

expect_stderr() {
  local name="$1" text="$2"

  if grep -qF -- "$text" "$work/logs/$name.err"; then
    ok "$name: stderr says $text"
  else
    fail "$name" "stderr missing '$text'; got: $(tr '\n' '|' <"$work/logs/$name.err")"
  fi
}

expect_stderr_lines() {
  local name="$1" expected="$2" lines

  lines="$(wc -l <"$work/logs/$name.err")"

  if [ "$lines" -eq "$expected" ]; then
    ok "$name: stderr holds $expected line"
  else
    fail "$name" "stderr holds $lines lines; got: $(tr '\n' '|' <"$work/logs/$name.err")"
  fi
}

expect_same() {
  local left="$1" right="$2" label="$3"

  if cmp -s "$left" "$right"; then
    ok "$label"
  else
    fail "$label" "$left differs from $right"
  fi
}

expect_mode() {
  local file="$1" expected="$2" label="$3" mode

  mode="$(stat -c %a "$file")"

  if [ "$mode" = "$expected" ]; then
    ok "$label: mode $expected"
  else
    fail "$label" "mode $mode, wanted $expected"
  fi
}

expect_no_temp() {
  local directory="$1" label="$2" found

  found="$(find "$directory" -maxdepth 1 -name '*.tmp' -print -quit)"

  if [ -z "$found" ]; then
    ok "$label: no temp file left"
  else
    fail "$label" "left $found"
  fi
}

expect_missing() {
  local path="$1" label="$2"

  if [ -e "$path" ]; then
    fail "$label" "$path was written"
  else
    ok "$label: $path stays absent"
  fi
}

sha256_of() {
  FILE="$1" bun -e 'import { readFileSync } from "node:fs"; process.stdout.write(new Bun.CryptoHasher("sha256").update(readFileSync(Bun.env.FILE ?? "")).digest("hex"))'
}

stage_release() {
  local version="$1" payload="$2" digest="${3:-}"
  local asset="bandar-$version-linux-x64"

  rm -rf "$work/site"
  mkdir -p "$work/site"
  printf '%s' "$payload" >"$work/site/$asset"

  if [ -z "$digest" ]; then digest="$(sha256_of "$work/site/$asset")"; fi

  printf '%s  %s\n' "$digest" "$asset" >"$work/site/$asset.sha256"
  printf '{"tag_name":"v%s","assets":[{"name":"%s","url":"%s/asset/%s"},{"name":"%s.sha256","url":"%s/asset/%s.sha256"}]}\n' \
    "$version" "$asset" "$API" "$asset" "$asset" "$API" "$asset" >"$work/site/latest.json"
}

write_manifest() {
  local directory="$1" source="$2"

  mkdir -p "$directory/config"
  printf '{"source":"%s","version":"0.1.0","path":"%s"}\n' \
    "$source" "$directory/bin/bandar" >"$directory/config/install.json"
}

seed_case() {
  local directory="$1" source="${2:-}"

  mkdir -p "$directory/bin" "$directory/config"
  printf 'old binary\n' >"$directory/bin/bandar"

  if [ -n "$source" ]; then write_manifest "$directory" "$source"; fi
}

case_dir() {
  CASE_DIR="$work/$1"
  seed_case "$CASE_DIR" "${2:-}"
}

printf 'old binary\n' >"$work/logs/expected-old"

echo
echo "case: happy path"
case_dir happy install-script
printf 'sqlite-bytes' >"$CASE_DIR/bandar.db"
printf 'duckdb-bytes' >"$CASE_DIR/bandar.duckdb"
cp "$CASE_DIR/bandar.db" "$work/logs/happy.db"
cp "$CASE_DIR/bandar.duckdb" "$work/logs/happy.duckdb"
cp "$CASE_DIR/config/install.json" "$work/logs/happy.json"
stage_release 0.2.0 'new binary payload'
: >"$work/logs/requests.log"
run happy env "BANDAR_CONFIG_DIR=$CASE_DIR/config" "BANDAR_UPDATE_URL=$API" \
  "BANDAR_GITHUB_TOKEN=$STUB_TOKEN" "BANDAR_DB=$CASE_DIR/bandar.db" \
  "BANDAR_DUCKDB=$CASE_DIR/bandar.duckdb" bun src/server/main.ts update
expect_exit happy 0
expect_stdout happy "bandar 0.2.0 installed at $CASE_DIR/bin/bandar"
expect_same "$CASE_DIR/bin/bandar" "$work/site/bandar-0.2.0-linux-x64" "happy: the binary is the release asset"
expect_mode "$CASE_DIR/bin/bandar" 755 happy
expect_no_temp "$CASE_DIR/bin" happy
expect_same "$CASE_DIR/bandar.db" "$work/logs/happy.db" "happy: bandar.db is untouched"
expect_same "$CASE_DIR/bandar.duckdb" "$work/logs/happy.duckdb" "happy: bandar.duckdb is untouched"
expect_same "$CASE_DIR/config/install.json" "$work/logs/happy.json" "happy: the manifest is untouched"

if cut -d' ' -f1 "$work/logs/requests.log" | grep -qF -- "$STUB_TOKEN"; then
  fail happy "the token appears in a request URL"
else
  ok "happy: the token stays out of request URLs"
fi

if grep -qF -- "Bearer $STUB_TOKEN" "$work/logs/requests.log"; then
  ok "happy: the token rides in the Authorization header"
else
  fail happy "no Bearer header reached the stub"
fi

if grep -qF -- "$STUB_TOKEN" "$work/logs/happy.out" "$work/logs/happy.err"; then
  fail happy "the token was printed"
else
  ok "happy: the token stays out of the output"
fi

echo
echo "case: checksum mismatch"
case_dir mismatch install-script
stage_release 0.3.0 'tampered payload' "$(printf '0%.0s' $(seq 1 64))"
run mismatch env "BANDAR_CONFIG_DIR=$CASE_DIR/config" "BANDAR_UPDATE_URL=$API" \
  "BANDAR_GITHUB_TOKEN=$STUB_TOKEN" bun src/server/main.ts update
expect_exit mismatch 1
expect_stderr mismatch "checksum mismatch"
expect_same "$CASE_DIR/bin/bandar" "$work/logs/expected-old" "mismatch: the binary keeps its bytes"
expect_no_temp "$CASE_DIR/bin" mismatch

echo
echo "case: unknown install source"
case_dir unknown
stage_release 0.2.0 'new binary payload'
run unknown env "BANDAR_CONFIG_DIR=$CASE_DIR/config" "BANDAR_UPDATE_URL=$API" \
  "BANDAR_GITHUB_TOKEN=$STUB_TOKEN" bun src/server/main.ts update
expect_exit unknown 1
expect_stdout_empty unknown
expect_stderr_lines unknown 1
expect_stderr unknown "install.sh"
expect_same "$CASE_DIR/bin/bandar" "$work/logs/expected-old" "unknown: the binary keeps its bytes"
expect_missing "$CASE_DIR/config/install.json" "unknown"
expect_missing "$CASE_DIR/bin/.bandar.tmp" "unknown"

echo
echo "case: same version"
case_dir same install-script
stage_release "$installed" 'same version payload'
: >"$work/logs/requests.log"
run same env "BANDAR_CONFIG_DIR=$CASE_DIR/config" "BANDAR_UPDATE_URL=$API" \
  "BANDAR_GITHUB_TOKEN=$STUB_TOKEN" bun src/server/main.ts update
expect_exit same 0
expect_stdout same "bandar $installed is up to date"
expect_same "$CASE_DIR/bin/bandar" "$work/logs/expected-old" "same: the binary keeps its bytes"

if grep -qF -- "/asset/" "$work/logs/requests.log"; then
  fail same "the update downloaded an asset"
else
  ok "same: no asset download"
fi

echo
echo "case: --check entry point"
case_dir check install-script
stage_release 0.2.0 'new binary payload'
env "BANDAR_CONFIG_DIR=$CASE_DIR/config" "BANDAR_UPDATE_URL=$API" "BANDAR_GITHUB_TOKEN=$STUB_TOKEN" \
  bun -e 'import { run } from "./src/server/cli/update.ts"; process.exitCode = await run(["update", "--check"], Bun.env);' \
  >"$work/logs/check.out" 2>"$work/logs/check.err"
status=$?
expect_exit check 0
expect_stdout check "installed $installed"
expect_stdout check "latest 0.2.0"
expect_stdout check "update-available"

echo
echo "case: --check without a token"
run notokencheck env "BANDAR_CONFIG_DIR=$CASE_DIR/config" "BANDAR_UPDATE_URL=$API" \
  bun -e 'import { run } from "./src/server/cli/update.ts"; process.exitCode = await run(["update", "--check"], Bun.env);'
expect_exit notokencheck 1
expect_stderr notokencheck "a GitHub token is required: set BANDAR_GITHUB_TOKEN"
expect_stdout notokencheck "latest unknown"

echo
echo "case: update without a token"
case_dir notoken install-script
run notoken env "BANDAR_CONFIG_DIR=$CASE_DIR/config" "BANDAR_UPDATE_URL=$API" \
  bun src/server/main.ts update
expect_exit notoken 1
expect_stderr_lines notoken 1
expect_stderr notoken "a GitHub token is required: set BANDAR_GITHUB_TOKEN"

echo
echo "case: --archive offline"
case_dir archive install-script
ARCHIVE="$work/logs/bandar-0.4.0-linux-x64"
printf 'offline binary payload' >"$ARCHIVE"
printf '%s  %s\n' "$(sha256_of "$ARCHIVE")" "$(basename "$ARCHIVE")" >"$ARCHIVE.sha256"
run archive env "BANDAR_CONFIG_DIR=$CASE_DIR/config" "ARCHIVE=$ARCHIVE" \
  bun -e 'import { run } from "./src/server/cli/update.ts"; process.exitCode = await run(["update", "--archive", Bun.env.ARCHIVE ?? ""], Bun.env);'
expect_exit archive 0
expect_same "$CASE_DIR/bin/bandar" "$ARCHIVE" "archive: the binary is the archive"
expect_mode "$CASE_DIR/bin/bandar" 755 archive
expect_no_temp "$CASE_DIR/bin" archive

echo
echo "case: unwritable target"

if [ "$(id -u)" -eq 0 ]; then
  echo "skip: running as root, so a mode change cannot deny the write"
else
  case_dir readonly install-script
  chmod 500 "$CASE_DIR/bin"
  run readonly env "BANDAR_CONFIG_DIR=$CASE_DIR/config" "BANDAR_UPDATE_URL=$API" \
    "BANDAR_GITHUB_TOKEN=$STUB_TOKEN" bun src/server/main.ts update
  expect_exit readonly 1
  expect_stderr readonly "sudo bandar update"
  expect_same "$CASE_DIR/bin/bandar" "$work/logs/expected-old" "readonly: the binary keeps its bytes"
  chmod 700 "$CASE_DIR/bin"
fi

echo

if [ "$failures" -ne 0 ]; then
  printf 'update-test: %d failure(s)\n' "$failures"

  exit 1
fi

printf 'update-test: all cases passed\n'
