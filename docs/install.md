# Install bandar

bandar releases live in a public repository. The installer reads the latest released version,
downloads the asset for the running platform, checks the published sha256, moves the binary into
place, and records where it came from so `bandar update` can replace it later.

No token is needed. A token is only for a private fork, and only when the installer is told to read
one through `BANDAR_RELEASE_API_URL`.

## One-liner

```sh
curl -fsSL https://raw.githubusercontent.com/falentio/bandar/main/install.sh | sh
```

No sudo is needed. The target directory is chosen in this order:

1. `BANDAR_INSTALL_DIR`, when it is set.
2. The directory `install.json` already records, when that record is still this binary in the
   directory chosen below. An upgrade replaces the binary `bandar update` already knows about
   instead of starting a second copy.
3. `/usr/local/bin`, when it exists and is writable.
4. `$XDG_BIN_HOME`, when it is set.
5. `$HOME/.local/bin`, created when missing.

So a normal user lands in `~/.local/bin` and never needs root. When that directory is not on
`PATH`, the installer says so and adds one `export` line to the shell profile it finds for
`$SHELL` (`~/.zshrc` for zsh, `~/.bashrc` for bash, `~/.config/fish/config.fish` for fish).
Pass `--no-modify-path` to leave every profile alone and get the line printed for you to place
yourself:

```sh
curl -fsSL https://raw.githubusercontent.com/falentio/bandar/main/install.sh | sh -s -- --no-modify-path
```

To choose the directory yourself, export it on the right of the pipe, because that is the side that
reaches `sh`:

```sh
curl -fsSL https://raw.githubusercontent.com/falentio/bandar/main/install.sh \
  | BANDAR_INSTALL_DIR="$HOME/.local/bin" sh
```

From a checkout, run the script directly:

```sh
./install.sh
./install.sh --no-modify-path
```

## How the installer reaches the release

Unless `BANDAR_VERSION` is set, the installer requests
`https://github.com/falentio/bandar/releases/latest` and reads the `Location` header of its 302
response. That header names the tag, such as `.../releases/tag/v0.1.0`. This is a page request,
not an API call: it needs no credential and it does not spend the 60-per-hour API rate limit.

It then downloads two files, anonymously:

```text
https://github.com/falentio/bandar/releases/download/v<version>/<asset>
https://github.com/falentio/bandar/releases/download/v<version>/<asset>.sha256
```

GitHub answers those with a redirect to `release-assets.githubusercontent.com`, and the installer
follows it. The checksum line is `<hex>  <filename>`; a mismatch exits 1 before anything is
replaced.

With `BANDAR_VERSION` set, the release page is not read at all.

A tag becomes a version only when it is letters, digits, dot, dash, or plus: `1.2.3`,
`1.2.3-rc.1`, `1.2.3+build.5`. Any other tag exits 1 with one line that names it, before any asset
is downloaded, because that version is also a JSON value in `install.json` and a path segment in
the asset name. The same rule covers `BANDAR_VERSION` and a private fork's `tag_name`.

### A private fork

A private fork keeps the API route. Point `BANDAR_RELEASE_API_URL` at its latest-release JSON and
set a token; the installer then reads `/releases/tags/v<version>` and the asset `url`s that feed
lists, with `Accept: application/octet-stream`:

```sh
BANDAR_RELEASE_API_URL=https://api.github.com/repos/you/bandar/releases/latest \
BANDAR_GITHUB_TOKEN="$TOKEN" ./install.sh
```

The token is read from `BANDAR_GITHUB_TOKEN`, then `GH_TOKEN`, then `GITHUB_TOKEN`; the first
one that is set wins, even when a later one holds a better token. Setting the API URL without a
token exits 1 before any request.

The token travels only in the `Authorization` header. It is never printed, never placed in a URL,
and never written to `install.json`. A curl that advertises `--config` reads the header from a
mode-600 config file, so the token stays out of the process arguments. An older curl, and wget,
receive it as a header argument instead.

Every asset `url` in that feed has to be on `api.github.com`, `github.com`,
`objects.githubusercontent.com`, `release-assets.githubusercontent.com`, or the host of
`BANDAR_RELEASE_API_URL`. An installer that sends a token to a host outside that list would hand
the token to whoever the feed names, so any other host exits 1 before the request. `bandar update`
applies the same rule.

### A mirror or a test server

`BANDAR_RELEASE_WEB_URL` replaces `https://github.com/falentio/bandar` as the origin for both the
release page and the downloads. A server that answers `/releases/latest` with a `Location` header
and serves `/releases/download/v<version>/<asset>` stands in for GitHub, and needs no token.

## What the installer writes

- The binary at `$BANDAR_INSTALL_DIR/bandar`, renamed `bandar.exe` on Windows. It lands
  through a temporary name in the same directory, so a failure never leaves a half written binary
  at the final path.
- `$BANDAR_CONFIG_DIR/install.json` with the install source, for `bandar update`:

  ```json
  { "source": "install-script", "version": "0.1.0", "path": "/usr/local/bin/bandar" }
  ```

  The directory is created with mode 700 and defaults to `~/.config/bandar`. The path is
  JSON-escaped, so a directory name holding a quote, a backslash, or a control character still
  writes a manifest `bandar update` can read.

The manifest is written before the binary is moved into place, because a binary with no manifest is
one `bandar update` can never replace. When the manifest cannot be written, the installer exits 1
and leaves no new binary. When the binary cannot be moved into place, the installer restores the
previous manifest and exits 1.

Nothing is written outside those two directories, and the installer never calls sudo. The one
exception is the `PATH` line described above, which `--no-modify-path` turns off.

`BANDAR_CONFIG_DIR` must be an absolute path, the same rule the server applies at boot. A
relative or blank value exits 1 before anything is downloaded.

## Environment variables

| Variable                 | Default                                           | Meaning                                                                                                       |
| ------------------------ | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `BANDAR_VERSION`         | the latest release                                | Version to install. A leading `v` is allowed.                                                                 |
| `BANDAR_INSTALL_DIR`     | see [the target directory](#the-target-directory) | Directory that receives the binary. Created when missing.                                                     |
| `BANDAR_SCOPE`           | unset                                             | `user` or `system`. After the install, run `bandar install-service --scope <scope>`.                          |
| `BANDAR_CONFIG_DIR`      | `~/.config/bandar`                                | Directory that receives `install.json`. Must be absolute.                                                     |
| `BANDAR_SERVICE_TIMEOUT` | `30`                                              | Seconds the service step may run before the installer gives up and exits 0.                                   |
| `BANDAR_RELEASE_WEB_URL` | `https://github.com/falentio/bandar`              | Origin that serves the release page and the downloads, for a mirror or a test server. Needs no token.         |
| `BANDAR_RELEASE_API_URL` | unset                                             | Latest-release JSON of a private fork. Setting it selects the API route, which needs a token.                 |
| `BANDAR_GITHUB_TOKEN`    | unset                                             | Token for the fork selected by `BANDAR_RELEASE_API_URL`, highest precedence. A public install never reads it. |
| `GH_TOKEN`               | unset                                             | Same token, read when `BANDAR_GITHUB_TOKEN` is unset.                                                         |
| `GITHUB_TOKEN`           | unset                                             | Same token, read when neither of the others is set.                                                           |

The platform pair comes from `uname`. Any pair other than Linux or Windows on x64 or arm64 exits 1
with one line before anything is downloaded.

Those variables configure the installer, not the installed server. The binary reads its runtime
settings from `config.json` under `BANDAR_HOME`, which defaults to `~/.bandar`, and writes the
schema and the file's `$schema` key on its first read. The installer's
`BANDAR_RELEASE_WEB_URL` and `BANDAR_RELEASE_API_URL` are not written anywhere. To point
`bandar update` at the same mirror, set `update.webUrl` or `update.apiUrl` in that file, or
export the variable when the command runs. Read
[`README.md`](../README.md#configuration) for the settings.

## Verify a download by hand

Assets are named `bandar-<version>-<os>-<arch>`, with `.exe` on Windows only. Each has a sibling
`.sha256` file whose line is `<hex>  <filename>`. No credential is involved:

```sh
version=$(curl -fsSL -o /dev/null -w '%{redirect_url}' \
  https://github.com/falentio/bandar/releases/latest | sed -n 's#.*/releases/tag/v##p')
curl -fsSL -O "https://github.com/falentio/bandar/releases/download/v$version/bandar-$version-linux-x64"
curl -fsSL -O "https://github.com/falentio/bandar/releases/download/v$version/bandar-$version-linux-x64.sha256"
sha256sum -c "bandar-$version-linux-x64.sha256"
```

On macOS, where `sha256sum` is absent, use `shasum -a 256 -c`. The installer accepts either tool
and refuses to install when it finds neither.

## The target directory

A normal user never needs sudo. The first directory that applies wins:

1. `BANDAR_INSTALL_DIR`, when it is set, even when it is not writable: the installer then exits 1
   rather than quietly installing somewhere else.
2. The directory `install.json` already records, when it is the chosen fallback. A rerun
   replaces the binary the manifest names instead of leaving a stale copy behind that
   `bandar update` can no longer reach. A fallback that is a symlink matches either spelling: the
   path the manifest holds, and the directory it resolves to.
3. `/usr/local/bin`, when it exists and is writable.
4. `$XDG_BIN_HOME`, when it is set.
5. `$HOME/.local/bin`, created when missing.

A manifest that points at a third directory, one neither `BANDAR_INSTALL_DIR` nor the fallback
names, exits 1 with the path and the `BANDAR_INSTALL_DIR` that replaces it. A silent second install
would leave two binaries, and only the recorded one self-updates. Remove `install.json` to start a
fresh install in the default directory.

When the chosen directory is still not writable, the installer exits 1 without writing anything and
names both ways out:

```sh
sudo BANDAR_INSTALL_DIR="/usr/local/bin" BANDAR_CONFIG_DIR="$HOME/.config/bandar" sh
```

Pass `BANDAR_CONFIG_DIR` through `sudo` as well. `sudo` sets `HOME` to root's, so a default
config path would otherwise record the install for root instead of for you. A system install stays
root-owned, so `bandar update` still has to be run under `sudo` afterwards. The per-user default
avoids that entirely.

## PATH

A per-user install lands outside the default `PATH` on most systems. After installing, the
installer checks whether `$PATH` already contains the directory. When it does not, it finds the
startup file for `$SHELL` and appends one line, guarded by a marker comment so a second run does
not add it twice:

```sh
# bandar: /home/you/.local/bin on PATH
export PATH="/home/you/.local/bin:$PATH"
```

It handles `zsh`, `bash`, and `fish`, and creates the main startup file when none exists yet, as
on a fresh macOS account. `XDG_CONFIG_HOME` is respected. Any other shell, or a profile the
installer cannot write, gets the line printed instead, and the install still exits 0.

`--no-modify-path` skips the profile edit entirely and only ever prints the line:

```sh
curl -fsSL https://raw.githubusercontent.com/falentio/bandar/main/install.sh | sh -s -- --no-modify-path
```

A shell started before the edit keeps the old `PATH`; `exec $SHELL` or a new terminal picks the
new one up.

## Register the service

After a successful install, `BANDAR_SCOPE=user` or `BANDAR_SCOPE=system` hands off to the binary:

```sh
bandar install-service --scope user
bandar install-service --scope system
```

A build without that subcommand, or one that does not finish within `BANDAR_SERVICE_TIMEOUT`,
prints one line that says the service step was skipped. The installer still exits 0, because the
binary is installed.

## Manual build

For a source checkout, build and place the binary yourself:

```sh
bun install
bun run build
install -m 755 dist/bandar "$HOME/.local/bin/bandar"
```

`bun run build` compiles `dist/bandar` (`dist/bandar.exe` on Windows) and embeds the web client.
On Windows, copy the file with `copy dist\bandar.exe %USERPROFILE%\bandar.exe`.

Record the manual source so `bandar update` knows how the binary arrived:

```json
{ "source": "manual", "version": "0.1.0", "path": "/home/you/.local/bin/bandar" }
```

Write it to `~/.config/bandar/install.json`, or under `BANDAR_CONFIG_DIR` when you set that
variable.

## Update and uninstall

`bandar update` reads `install.json`, resolves the latest release, and replaces the binary at the
recorded path when the source is `install-script` or `manual`. It needs no token either; see
[`update.md`](./update.md).

```sh
bandar uninstall-service --scope user
rm "$(command -v bandar)"
rm -rf "${BANDAR_CONFIG_DIR:-$HOME/.config/bandar}"
```

## Test the installer

`scripts/install-test.sh` serves a stub release from `127.0.0.1` and runs the real `install.sh`
against it, with a temporary install and config directory:

```sh
sh -n install.sh
scripts/install-test.sh
```
