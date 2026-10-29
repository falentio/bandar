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
LOADER_NAME=@falentio/bandar
PLATFORM_NAME=$LOADER_NAME-linux-x64
WINDOWS_NAME=$LOADER_NAME-windows-x64

# The staged directory of a scoped package is its flattened name, the one npm pack would give it.
slug() { printf '%s' "$1" | sed 's#^@##; s#/#-#'; }
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

for name in "$PLATFORM_NAME" "$WINDOWS_NAME" "$LOADER_NAME"; do
  [ -f "$STAGED/$(slug "$name")/package.json" ] || die "scripts/npm.ts --stage left $name unstaged"
done

loader_manifest=$STAGED/$(slug "$LOADER_NAME")/package.json

if grep -q '"os"' "$loader_manifest"; then
  fail "the loader manifest carries an os field, so npm would refuse an unsupported platform"
else
  pass "the loader manifest carries no os field"
fi

lifecycle=
for name in "$PLATFORM_NAME" "$WINDOWS_NAME" "$LOADER_NAME"; do
  if grep -q '"scripts"' "$STAGED/$(slug "$name")/package.json"; then lifecycle="$lifecycle $name"; fi
done

if [ -z "$lifecycle" ]; then
  pass "no staged manifest carries a lifecycle script"
else
  fail "a lifecycle script survived staging:$lifecycle"
fi

provenance=
for name in "$PLATFORM_NAME" "$WINDOWS_NAME" "$LOADER_NAME"; do
  if grep -q '"provenance"' "$STAGED/$(slug "$name")/package.json"; then provenance="$provenance $name"; fi
done

if [ -z "$provenance" ]; then
  pass "no staged manifest asks npm to sign provenance"
else
  fail "a staged manifest asks for provenance, which a publish outside the workflow cannot sign:$provenance"
fi

mkdir -p "$TARBALLS"

for name in "$PLATFORM_NAME" "$WINDOWS_NAME" "$LOADER_NAME"; do
  (cd "$STAGED/$(slug "$name")" && npm pack --pack-destination "$TARBALLS" >/dev/null 2>&1) ||
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
    --no-audit --no-fund --no-update-notifier --fetch-retries=0 "$LOADER_NAME@$VERSION"
}

if install_bandar "$PREFIX" >"$WORK/install.log" 2>&1; then
  pass "npm install -g $LOADER_NAME@$VERSION from the stub registry"
else
  fail "npm install -g $LOADER_NAME@$VERSION from the stub registry"
  sed -n '1,40p' "$WORK/install.log"
fi

bin=$PREFIX/bin/bandar
loader=$PREFIX/lib/node_modules/@falentio/bandar/bin/bandar.cjs

resolve_package() {
  (cd "$PREFIX/lib/node_modules/@falentio/bandar" &&
    node -e "process.stdout.write(require.resolve('$1/package.json'))" 2>/dev/null) || true
}

platform_manifest=$(resolve_package "$PLATFORM_NAME")
[ -n "$platform_manifest" ] || die "node cannot resolve $PLATFORM_NAME from the installed loader"

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

if [ -n "$(resolve_package "$WINDOWS_NAME")" ]; then
  fail "npm installed $WINDOWS_NAME as well"
else
  pass "npm installed only $PLATFORM_NAME"
fi

windows=$(node -e '
const path = require("node:path");
const { resolveBinary } = require(process.argv[1]);

process.stdout.write(
  JSON.stringify(
    resolveBinary("win32", "x64", (request) =>
      path.join(process.argv[2], request.replace(/^@/u, "").replace("/", "-")),
    ),
  ),
);
' "$loader" "$STAGED")

case "$windows" in
*'"kind":"ready"'*'"path":"'*'bandar-windows-x64/bin/bandar.exe"'*)
  pass "resolveBinary picks the windows package's bin/bandar.exe for win32-x64"
  ;;
*)
  fail "resolveBinary for win32-x64 said: $windows"
  ;;
esac

windows_manifest=$(node -e '
const manifest = require(process.argv[1]);

process.stdout.write(
  JSON.stringify({ os: manifest.os, libc: manifest.libc, files: manifest.files }),
);
' "$STAGED/$(slug "$WINDOWS_NAME")/package.json")

if [ "$windows_manifest" = '{"os":["win32"],"files":["bin/bandar.exe"]}' ]; then
  pass "the windows manifest declares win32, no libc, and bin/bandar.exe"
else
  fail "the windows manifest declares $windows_manifest"
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

cat >"$WORK/fake-musl.cjs" <<'PRELOAD'
const report = process.report.getReport();

Object.defineProperty(process, "report", {
  value: {
    getReport: () => ({ ...report, header: { ...report.header, glibcVersionRuntime: undefined } }),
  },
});
PRELOAD

mv "$platform_dir" "$WORK/hidden"
status=0
"$bin" --version >"$WORK/absent.out" 2>"$WORK/absent.err" || status=$?
musl=0
node --require "$WORK/fake-musl.cjs" "$loader" --version >"$WORK/musl.out" 2>"$WORK/musl.err" ||
  musl=$?
mv "$WORK/hidden" "$platform_dir"

if [ "$status" = 1 ] && [ ! -s "$WORK/absent.out" ] &&
  [ "$(wc -l <"$WORK/absent.err")" -eq 1 ] &&
  grep -q '@falentio/bandar-linux-x64' "$WORK/absent.err" &&
  grep -q 'npm install -g @falentio/bandar@latest' "$WORK/absent.err" &&
  grep -q 'install.sh' "$WORK/absent.err"; then
  pass "a missing platform package refuses in one line"
else
  fail "a missing platform package said: $(cat "$WORK/absent.err")"
fi

if [ "$musl" = 1 ] && [ ! -s "$WORK/musl.out" ] &&
  [ "$(wc -l <"$WORK/musl.err")" -eq 1 ] &&
  grep -q 'links glibc' "$WORK/musl.err" &&
  grep -q 'this Linux uses musl' "$WORK/musl.err" &&
  grep -q 'neither npm nor install.sh can install one' "$WORK/musl.err"; then
  pass "a musl Linux with only the glibc package installed is refused as unsupported"
else
  fail "a musl Linux said: $(cat "$WORK/musl.err")"
fi

cp -R "$PREFIX" "$WORK/mixed"
mixed_platform=$(cd "$WORK/mixed/lib/node_modules/@falentio/bandar" &&
  node -e "process.stdout.write(require.resolve('@falentio/bandar-linux-x64/package.json'))")
node -e 'fs=require("node:fs");p=process.argv[1];m=JSON.parse(fs.readFileSync(p,"utf8"));m.version="0.0.0";fs.writeFileSync(p,JSON.stringify(m,null,2))' "$mixed_platform"

status=0
node "$WORK/mixed/lib/node_modules/@falentio/bandar/bin/bandar.cjs" --version \
  >"$WORK/mismatch.out" 2>"$WORK/mismatch.err" || status=$?

if [ "$status" = 1 ] && [ ! -s "$WORK/mismatch.out" ] &&
  [ "$(wc -l <"$WORK/mismatch.err")" -eq 1 ] &&
  grep -q '@falentio/bandar-linux-x64 is 0.0.0' "$WORK/mismatch.err" &&
  grep -q "loader is $VERSION" "$WORK/mismatch.err"; then
  pass "a platform package at another version refuses in one line"
else
  fail "a platform package at another version said: $(cat "$WORK/mismatch.err")"
fi

# actions/download-artifact drops the exec bit, so preflight meets the release asset mode 644, and a
# registry it cannot reach must still report rather than crash.
NOEXEC=$WORK/noexec
mkdir -p "$NOEXEC/release"
{
  printf '#!/bin/sh\n'
  printf 'if [ "$1" = "--version" ]; then printf "%%s\\n" "0.0.0"; exit 0; fi\n'
  printf 'exit 2\n'
} >"$NOEXEC/release/bandar-$VERSION-linux-x64"
chmod 644 "$NOEXEC/release/bandar-$VERSION-linux-x64"

status=0
NPM_CONFIG_REGISTRY=http://127.0.0.1:1/ NPM_CONFIG_FETCH_RETRIES=0 bun "$ROOT/scripts/npm.ts" --preflight \
  --release "$NOEXEC/release" --output "$STAGED" >"$WORK/noexec.log" 2>&1 || status=$?

if [ "$status" = 1 ] && ! grep -q 'EACCES' "$WORK/noexec.log" &&
  grep -q 'the release binary reports 0.0.0' "$WORK/noexec.log" &&
  grep -q 'could not ask npm about' "$WORK/noexec.log"; then
  pass "a preflight reads a release asset that arrived without the exec bit"
else
  fail "a preflight on a non-executable asset said: $(head -3 "$WORK/noexec.log" | tr '\n' ' ')"
fi

printf 'npm-test: %s checks, %s failures\n' "$checks" "$failures"
[ "$failures" -eq 0 ]
