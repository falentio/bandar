#!/usr/bin/env bash
# Proves bandar update against a loopback stub release feed. Nothing here reaches the network.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if ! command -v bun >/dev/null 2>&1; then
  echo "update-test: bun is not on PATH" >&2
  exit 1
fi

host="$(bun -e 'process.stdout.write(process.platform + "-" + process.arch)')"

if [ "$host" != "linux-x64" ]; then
  echo "update-test: SKIP, the stub names linux-x64 assets and this host is $host"
  exit 0
fi

unset BANDAR_GITHUB_TOKEN GH_TOKEN GITHUB_TOKEN BANDAR_RELEASE_API_URL \
  BANDAR_RELEASE_WEB_URL BANDAR_CONFIG_DIR || true

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

const file = (path: string): Response => {
  if (path.includes("..") || !existsSync(path)) return new Response("not found", { status: 404 });

  return new Response(Bun.file(path));
};

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname;
    const authorization = request.headers.get("authorization") ?? "none";
    const accept = request.headers.get("accept") ?? "";

    appendFileSync(log, path + " " + authorization + "\n");

    if (path === "/releases/latest" && !accept.includes("vnd.github")) {
      const latestFile = join(site, "latest");

      if (!existsSync(latestFile)) return new Response("not found", { status: 404 });

      const version = (await Bun.file(latestFile).text()).trim();

      return new Response(null, {
        status: 302,
        headers: { location: "/releases/tag/v" + version },
      });
    }

    if (path === "/api/releases/latest" || path === "/api/releases/foreign")
      return file(join(site, path === "/api/releases/latest" ? "feed.json" : "foreign.json"));

    if (path.startsWith("/api/assets/")) return file(join(site, "assets", path.slice(12)));

    if (path.startsWith("/releases/download/"))
      return file(join(site, "rel", path.slice("/releases/download/".length)));

    return new Response("not found", { status: 404 });
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
feed="$API/api/releases/latest"
installed="$(bun -e 'process.stdout.write((await Bun.file("package.json").json()).version)')"

# A staged release is always a bump of the version this binary compiles in, which scripts/gen.ts
# reads from package.json. A hardcoded release falls behind a version bump and turns an available
# update into the correct "up to date" answer, failing the case for the wrong reason.
bump() {
  local core="$1" part="$2" major minor patch

  core="$(printf '%s' "$core" | cut -d- -f1)"
  IFS=. read -r major minor patch <<<"$core"

  case "$part" in
    patch) patch=$((patch + 1)) ;;
    minor) minor=$((minor + 1)) patch=0 ;;
    major) major=$((major + 1)) minor=0 patch=0 ;;
    *) echo "update-test: unknown bump part $part" >&2; exit 1 ;;
  esac

  printf '%s.%s.%s\n' "$major" "$minor" "$patch"
}

newer="$(bump "$installed" patch)"
newer_minor="$(bump "$installed" minor)"
newer_major="$(bump "$installed" major)"

echo "update-test: stub release feed at $API, installed version $installed, staging $newer, $newer_minor, and $newer_major"

checks=0
failures=0

ok() {
  checks=$((checks + 1))
  printf 'ok   %s\n' "$1"
}

fail() {
  checks=$((checks + 1))
  failures=$((failures + 1))
  printf 'FAIL %s - %s\n' "$1" "$2"
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
  mkdir -p "$work/site/rel/v$version" "$work/site/assets"
  printf '%s' "$payload" >"$work/site/rel/v$version/$asset"

  if [ -z "$digest" ]; then digest="$(sha256_of "$work/site/rel/v$version/$asset")"; fi

  printf '%s  %s\n' "$digest" "$asset" >"$work/site/rel/v$version/$asset.sha256"
  printf '%s\n' "$version" >"$work/site/latest"
  cp "$work/site/rel/v$version/$asset" "$work/site/assets/$asset"
  cp "$work/site/rel/v$version/$asset.sha256" "$work/site/assets/$asset.sha256"
  printf '{"tag_name":"v%s","assets":[{"url":"%s/api/assets/%s","name":"%s"},{"url":"%s/api/assets/%s.sha256","name":"%s.sha256"}]}\n' \
    "$version" "$API" "$asset" "$asset" "$API" "$asset" "$asset" >"$work/site/feed.json"
}

stage_foreign_release() {
  local version="$1" asset="bandar-$1-linux-x64"

  printf '{"tag_name":"v%s","assets":[{"url":"http://foreign.test/%s","name":"%s"},{"url":"http://foreign.test/%s.sha256","name":"%s.sha256"}]}\n' \
    "$version" "$asset" "$asset" "$asset" "$asset" >"$work/site/foreign.json"
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

# The public flow: the release page answers a redirect and every asset is anonymous.
public() {
  local name="$1"
  shift
  run "$name" env "BANDAR_CONFIG_DIR=$CASE_DIR/config" "BANDAR_RELEASE_WEB_URL=$API" "$@" \
    bun src/server/main.ts update
}

# The private-fork override: the API feed is selected and the token rides in the header.
private() {
  local name="$1"
  shift
  run "$name" env "BANDAR_CONFIG_DIR=$CASE_DIR/config" "BANDAR_RELEASE_API_URL=$feed" \
    "BANDAR_GITHUB_TOKEN=$STUB_TOKEN" "$@" bun src/server/main.ts update
}

printf 'old binary\n' >"$work/logs/expected-old"

echo
echo "case: anonymous update"
case_dir happy install-script
printf 'sqlite-bytes' >"$CASE_DIR/bandar.db"
printf 'duckdb-bytes' >"$CASE_DIR/bandar.duckdb"
cp "$CASE_DIR/bandar.db" "$work/logs/happy.db"
cp "$CASE_DIR/bandar.duckdb" "$work/logs/happy.duckdb"
cp "$CASE_DIR/config/install.json" "$work/logs/happy.json"
stage_release "$newer" 'new binary payload'
: >"$work/logs/requests.log"
public happy "BANDAR_DB=$CASE_DIR/bandar.db" "BANDAR_DUCKDB=$CASE_DIR/bandar.duckdb"
expect_exit happy 0
expect_stdout happy "bandar $newer installed at $CASE_DIR/bin/bandar"
expect_same "$CASE_DIR/bin/bandar" "$work/site/rel/v$newer/bandar-$newer-linux-x64" "happy: the binary is the release asset"
expect_mode "$CASE_DIR/bin/bandar" 755 happy
expect_no_temp "$CASE_DIR/bin" happy
expect_same "$CASE_DIR/bandar.db" "$work/logs/happy.db" "happy: bandar.db is untouched"
expect_same "$CASE_DIR/bandar.duckdb" "$work/logs/happy.duckdb" "happy: bandar.duckdb is untouched"
expect_same "$CASE_DIR/config/install.json" "$work/logs/happy.json" "happy: the manifest is untouched"

if grep -q '^/releases/latest ' "$work/logs/requests.log"; then
  ok "happy: the tag came from the release page"
else
  fail happy "the release page was not read"
fi

if grep -qv ' none$' "$work/logs/requests.log"; then
  fail happy "an Authorization header reached the stub: $(grep -v ' none$' "$work/logs/requests.log")"
else
  ok "happy: no Authorization header was sent"
fi

if grep -qF -- "$STUB_TOKEN" "$work/logs/happy.out" "$work/logs/happy.err"; then
  fail happy "a token was printed"
else
  ok "happy: no token in the output"
fi

echo
echo "case: private fork override"
case_dir fork install-script
stage_release "$newer" 'private fork payload'
: >"$work/logs/requests.log"
private fork
expect_exit fork 0
expect_stdout fork "bandar $newer installed at $CASE_DIR/bin/bandar"
expect_same "$CASE_DIR/bin/bandar" "$work/site/assets/bandar-$newer-linux-x64" "fork: the binary is the feed asset"
expect_no_temp "$CASE_DIR/bin" fork

if grep -q "^/api/releases/latest Bearer $STUB_TOKEN$" "$work/logs/requests.log"; then
  ok "fork: the token rides in the Authorization header to the feed host"
else
  fail fork "no Bearer header reached the feed: $(cat "$work/logs/requests.log")"
fi

if cut -d' ' -f1 "$work/logs/requests.log" | grep -qF -- "$STUB_TOKEN"; then
  fail fork "the token appears in a request URL"
else
  ok "fork: the token stays out of request URLs"
fi

if grep -q '^/releases/latest ' "$work/logs/requests.log"; then
  fail fork "the public page was read even though the API feed is configured"
else
  ok "fork: the public page is never read"
fi

if grep -qF -- "$STUB_TOKEN" "$work/logs/fork.out" "$work/logs/fork.err"; then
  fail fork "the token was printed"
else
  ok "fork: the token stays out of the output"
fi

echo
echo "case: the API override without a token"
case_dir apinotoken install-script
stage_release "$newer" 'new binary payload'
: >"$work/logs/requests.log"
run apinotoken env "BANDAR_CONFIG_DIR=$CASE_DIR/config" "BANDAR_RELEASE_API_URL=$feed" \
  bun src/server/main.ts update
expect_exit apinotoken 1
expect_stderr_lines apinotoken 1
expect_stderr apinotoken "BANDAR_RELEASE_API_URL reads a private fork, so it needs a GitHub token: set BANDAR_GITHUB_TOKEN"
expect_same "$CASE_DIR/bin/bandar" "$work/logs/expected-old" "apinotoken: the binary keeps its bytes"

if [ -s "$work/logs/requests.log" ]; then
  fail apinotoken "a request was sent without a token: $(cat "$work/logs/requests.log")"
else
  ok "apinotoken: no request is sent"
fi

echo
echo "case: checksum mismatch"
case_dir mismatch install-script
stage_release "$newer_minor" 'tampered payload' "$(printf '0%.0s' $(seq 1 64))"
public mismatch
expect_exit mismatch 1
expect_stderr mismatch "checksum mismatch"
expect_same "$CASE_DIR/bin/bandar" "$work/logs/expected-old" "mismatch: the binary keeps its bytes"
expect_no_temp "$CASE_DIR/bin" mismatch

echo
echo "case: foreign asset host"
case_dir foreign install-script
stage_release "$newer_major" 'foreign payload'
stage_foreign_release "$newer_major"
: >"$work/logs/requests.log"
run foreign env "BANDAR_CONFIG_DIR=$CASE_DIR/config" "BANDAR_RELEASE_API_URL=$API/api/releases/foreign" \
  "BANDAR_GITHUB_TOKEN=$STUB_TOKEN" bun src/server/main.ts update
expect_exit foreign 1
expect_stderr foreign "not an allowed asset host"
expect_same "$CASE_DIR/bin/bandar" "$work/logs/expected-old" "foreign: the binary keeps its bytes"
requests="$(wc -l <"$work/logs/requests.log")"

if [ "$requests" -eq 1 ]; then
  ok "foreign: the token went to no other host"
else
  fail foreign "the stub saw $requests requests, wanted only the release feed"
fi

echo
echo "case: unknown install source"
case_dir unknown
stage_release "$newer" 'new binary payload'
public unknown
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
public same
expect_exit same 0
expect_stdout same "bandar $installed is up to date"
expect_same "$CASE_DIR/bin/bandar" "$work/logs/expected-old" "same: the binary keeps its bytes"

if grep -qF -- "/releases/download/" "$work/logs/requests.log"; then
  fail same "the update downloaded an asset"
else
  ok "same: no asset download"
fi

echo
echo "case: --check"
case_dir check install-script
stage_release "$newer" 'new binary payload'
run check env "BANDAR_CONFIG_DIR=$CASE_DIR/config" "BANDAR_RELEASE_WEB_URL=$API" \
  bun src/server/main.ts update --check
expect_exit check 0
expect_stdout check "installed $installed"
expect_stdout check "latest $newer"
expect_stdout check "update-available"

echo
echo "case: --check with no published release"
case_dir norelease install-script
rm -rf "$work/site"
mkdir -p "$work/site"
run norelease env "BANDAR_CONFIG_DIR=$CASE_DIR/config" "BANDAR_RELEASE_WEB_URL=$API" \
  bun src/server/main.ts update --check
expect_exit norelease 0
expect_stdout norelease "latest unknown"
expect_stdout norelease "unknown"

echo
echo "case: --archive offline"
case_dir archive install-script
ARCHIVE="$work/logs/bandar-$newer-linux-x64"
printf 'offline binary payload' >"$ARCHIVE"
printf '%s  %s\n' "$(sha256_of "$ARCHIVE")" "$(basename "$ARCHIVE")" >"$ARCHIVE.sha256"
run archive env "BANDAR_CONFIG_DIR=$CASE_DIR/config" \
  bun src/server/main.ts update --archive "$ARCHIVE"
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
  public readonly
  expect_exit readonly 1
  expect_stderr readonly "sudo bandar update"
  expect_same "$CASE_DIR/bin/bandar" "$work/logs/expected-old" "readonly: the binary keeps its bytes"
  chmod 700 "$CASE_DIR/bin"
fi

echo

if [ "$failures" -ne 0 ]; then
  printf 'update-test: %d of %d checks failed\n' "$failures" "$checks"

  exit 1
fi

printf 'update-test: all %d checks passed\n' "$checks"
