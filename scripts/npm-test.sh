#!/bin/sh
set -eu

ROOT=$(cd "$(dirname "$0")/.." && pwd -P)
WORK=$(cd "$(mktemp -d "${TMPDIR:-/tmp}/bandar-npm-test.XXXXXX")" && pwd -P)
PREFIX=$WORK/prefix
SCRIPTS_OFF=$WORK/scripts-off
TARBALLS=$WORK/tarballs
RELEASE_DIR=$WORK/release
STAGED=$WORK/npm
PORT_FILE=$WORK/port
checks=0
failures=0
stub=

pass() { checks=$((checks + 1)); printf 'ok   %s\n' "$*"; }
fail() { checks=$((checks + 1)); failures=$((failures + 1)); printf 'FAIL %s\n' "$*"; }
die() { printf 'npm-test: %s\n' "$*" >&2; exit 1; }
cleanup() {
  [ -z "$stub" ] || kill "$stub" 2>/dev/null || true
  rm -rf "$WORK"
}
trap cleanup EXIT INT TERM

command -v bun >/dev/null 2>&1 || die "bun is required to serve the registry stub"
command -v npm >/dev/null 2>&1 || die "npm is required to install the staged packages"
command -v node >/dev/null 2>&1 || die "node is required to run the installed loader"

VERSION=$(cd "$ROOT" && bun --eval 'process.stdout.write((await Bun.file("package.json").json()).version)')
KEY=$(bun --eval 'process.stdout.write(process.platform + "-" + process.arch)')

[ "$KEY" = linux-x64 ] || die "npm-test covers linux-x64 only, not $KEY"

sha256_of() {
  bun --eval "process.stdout.write(require('node:crypto').createHash('sha256').update(require('node:fs').readFileSync('$1')).digest('hex'))"
}

write_asset() {
  path=$1

  mkdir -p "$(dirname "$path")"
  {
    printf '#!/bin/sh\n'
    printf 'if [ "$1" = "--version" ]; then printf "%%s\\n" "%s"; exit 0; fi\n' "$VERSION"
    printf 'exit 2\n'
  } >"$path"
  chmod 755 "$path"
  printf '%s  %s\n' "$(sha256_of "$path")" "$(basename "$path")" >"$path.sha256"
}

ASSET=$RELEASE_DIR/bandar-$VERSION-linux-x64
write_asset "$ASSET"

write_asset "$RELEASE_DIR/bandar-$VERSION-windows-x64.exe"

bun "$ROOT/scripts/npm.ts" --stage --release "$RELEASE_DIR" --output "$STAGED" >"$WORK/stage.log" 2>&1 ||
  die "scripts/npm.ts --stage failed: $(cat "$WORK/stage.log")"

for name in bandar-linux-x64 bandar-windows-x64 bandar; do
  [ -f "$STAGED/$name/package.json" ] || die "scripts/npm.ts --stage left $name unstaged"
done

loader_manifest=$STAGED/bandar/package.json

if grep -q '"os"' "$loader_manifest"; then
  fail "the loader manifest carries an os field, so npm would refuse an unsupported platform"
else
  pass "the loader manifest carries no os field"
fi

lifecycle=
for name in bandar-linux-x64 bandar-windows-x64 bandar; do
  if grep -q '"scripts"' "$STAGED/$name/package.json"; then lifecycle="$lifecycle $name"; fi
done

if [ -z "$lifecycle" ]; then
  pass "no staged manifest carries a lifecycle script"
else
  fail "a lifecycle script survived staging:$lifecycle"
fi

mkdir -p "$TARBALLS"

for name in bandar-linux-x64 bandar-windows-x64 bandar; do
  (cd "$STAGED/$name" && npm pack --pack-destination "$TARBALLS" >/dev/null 2>&1) ||
    die "npm pack failed for $name"
done

bun "$ROOT/scripts/registry-stub.ts" --packages "$STAGED" --tarballs "$TARBALLS" \
  --port-file "$PORT_FILE" >"$WORK/registry.log" 2>&1 &
stub=$!

waited=0
while [ ! -s "$PORT_FILE" ]; do
  waited=$((waited + 1))
  [ "$waited" -lt 200 ] || die "the registry stub did not start: $(cat "$WORK/registry.log")"
  sleep 0.1
done
registry=http://127.0.0.1:$(cat "$PORT_FILE")

install_bandar() {
  npm install --global --prefix "$1" --registry "$registry" --cache "$WORK/cache" \
    --no-audit --no-fund --no-update-notifier --fetch-retries=0 "bandar@$VERSION"
}

if install_bandar "$PREFIX" >"$WORK/install.log" 2>&1; then
  pass "npm install -g bandar@$VERSION from the stub registry"
else
  fail "npm install -g bandar@$VERSION from the stub registry"
  sed -n '1,40p' "$WORK/install.log"
fi

bin=$PREFIX/bin/bandar
loader=$PREFIX/lib/node_modules/bandar/bin/bandar.cjs

resolve_package() {
  (cd "$PREFIX/lib/node_modules/bandar" &&
    node -e "process.stdout.write(require.resolve('$1/package.json'))" 2>/dev/null) || true
}

platform_manifest=$(resolve_package bandar-linux-x64)
[ -n "$platform_manifest" ] || die "node cannot resolve bandar-linux-x64 from the installed loader"

platform_dir=$(dirname "$platform_manifest")
installed=$platform_dir/bin/bandar

if [ -x "$bin" ] && "$bin" --version >"$WORK/version.out" 2>&1; then
  if [ "$(cat "$WORK/version.out")" = "$VERSION" ]; then
    pass "the installed shim reports $VERSION"
  else
    fail "the installed shim reported $(cat "$WORK/version.out")"
  fi
else
  fail "the installed shim did not run"
fi

if [ -n "$(resolve_package bandar-windows-x64)" ]; then
  fail "npm installed bandar-windows-x64 as well"
else
  pass "npm installed only bandar-linux-x64"
fi

if [ -f "$installed" ] && cmp -s "$installed" "$ASSET"; then
  pass "the installed binary is byte-identical to $(basename "$ASSET")"
else
  fail "the installed binary differs from $(basename "$ASSET")"
fi

direct=0
"$ASSET" --definitely-not-a-flag >/dev/null 2>&1 || direct=$?
through=0
"$bin" --definitely-not-a-flag >/dev/null 2>&1 || through=$?

if [ "$direct" = "$through" ]; then
  pass "exit status $through reached the caller unchanged"
else
  fail "the shim exited $through where the binary exited $direct"
fi

cp "$installed" "$WORK/real-binary"
cat >"$installed" <<FAKE
#!/bin/sh
trap 'kill \$sleeper 2>/dev/null; printf trapped >"$WORK/trap"; exit 7' TERM
sleep 30 &
sleeper=\$!
wait
FAKE
chmod 755 "$installed"

"$bin" >/dev/null 2>&1 &
shim=$!
sleep 1
kill -TERM "$shim"
status=0
wait "$shim" || status=$?

if [ "$status" = 7 ] && [ -f "$WORK/trap" ]; then
  pass "SIGTERM reached the child and exit status 7 came back"
else
  fail "SIGTERM forwarding gave status $status"
fi

cp "$WORK/real-binary" "$installed"

if install_bandar "$SCRIPTS_OFF" --ignore-scripts >"$WORK/ignore.log" 2>&1 &&
  [ "$("$SCRIPTS_OFF/bin/bandar" --version)" = "$VERSION" ]; then
  pass "--ignore-scripts installs the same working copy"
else
  fail "--ignore-scripts changed the install"
  sed -n '1,40p' "$WORK/ignore.log"
fi

cat >"$WORK/fake-darwin.cjs" <<'PRELOAD'
Object.defineProperty(process, "platform", { value: "darwin" });
PRELOAD

status=0
node --require "$WORK/fake-darwin.cjs" "$loader" --version >"$WORK/unsupported.out" \
  2>"$WORK/unsupported.err" || status=$?

if [ "$status" = 1 ] && [ ! -s "$WORK/unsupported.out" ] &&
  [ "$(wc -l <"$WORK/unsupported.err")" -eq 1 ] &&
  grep -q 'no npm build for darwin-x64' "$WORK/unsupported.err" &&
  grep -q 'npm ships linux-x64, win32-x64' "$WORK/unsupported.err"; then
  pass "an unsupported platform refuses in one line"
else
  fail "an unsupported platform said: $(cat "$WORK/unsupported.err")"
fi

mv "$platform_dir" "$WORK/hidden"
status=0
"$bin" --version >"$WORK/absent.out" 2>"$WORK/absent.err" || status=$?
mv "$WORK/hidden" "$platform_dir"

if [ "$status" = 1 ] && [ ! -s "$WORK/absent.out" ] &&
  [ "$(wc -l <"$WORK/absent.err")" -eq 1 ] &&
  grep -q 'bandar-linux-x64' "$WORK/absent.err" &&
  grep -q 'npm install -g bandar@latest' "$WORK/absent.err" &&
  grep -q 'install.sh' "$WORK/absent.err"; then
  pass "a missing platform package refuses in one line"
else
  fail "a missing platform package said: $(cat "$WORK/absent.err")"
fi

cp -R "$PREFIX" "$WORK/mixed"
mixed_platform=$(cd "$WORK/mixed/lib/node_modules/bandar" &&
  node -e "process.stdout.write(require.resolve('bandar-linux-x64/package.json'))")
node -e 'fs=require("node:fs");p=process.argv[1];m=JSON.parse(fs.readFileSync(p,"utf8"));m.version="0.0.0";fs.writeFileSync(p,JSON.stringify(m,null,2))' "$mixed_platform"

status=0
node "$WORK/mixed/lib/node_modules/bandar/bin/bandar.cjs" --version \
  >"$WORK/mismatch.out" 2>"$WORK/mismatch.err" || status=$?

if [ "$status" = 1 ] && [ ! -s "$WORK/mismatch.out" ] &&
  [ "$(wc -l <"$WORK/mismatch.err")" -eq 1 ] &&
  grep -q 'bandar-linux-x64 is 0.0.0' "$WORK/mismatch.err" &&
  grep -q "loader is $VERSION" "$WORK/mismatch.err"; then
  pass "a platform package at another version refuses in one line"
else
  fail "a platform package at another version said: $(cat "$WORK/mismatch.err")"
fi

printf 'npm-test: %s checks, %s failures\n' "$checks" "$failures"
[ "$failures" -eq 0 ]
