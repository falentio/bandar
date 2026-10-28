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

The default target is `/usr/local/bin`, which usually needs root. To install into your own
directory, export it first, because a variable on the right of the pipe is the one that reaches
`sh`:

```sh
curl -fsSL https://raw.githubusercontent.com/falentio/bandar/main/install.sh \
  | BANDAR_INSTALL_DIR="$HOME/.local/bin" sh
```

From a checkout, run the script directly:

```sh
./install.sh
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

  The directory is created with mode 700 and defaults to `~/.config/bandar`.

The manifest is written before the binary is moved into place, because a binary with no manifest is
one `bandar update` can never replace. When the manifest cannot be written, the installer exits 1
and leaves no new binary. When the binary cannot be moved into place, the installer restores the
previous manifest and exits 1.

Nothing is written outside those two directories, and the installer never calls sudo.

`BANDAR_CONFIG_DIR` must be an absolute path, the same rule the server applies at boot. A
relative or blank value exits 1 before anything is downloaded.

## Environment variables

| Variable                 | Default                              | Meaning                                                                                                       |
| ------------------------ | ------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| `BANDAR_VERSION`         | the latest release                   | Version to install. A leading `v` is allowed.                                                                 |
| `BANDAR_INSTALL_DIR`     | `/usr/local/bin`                     | Directory that receives the binary. Created when missing.                                                     |
| `BANDAR_SCOPE`           | unset                                | `user` or `system`. After the install, run `bandar install-service --scope <scope>`.                          |
| `BANDAR_CONFIG_DIR`      | `~/.config/bandar`                   | Directory that receives `install.json`. Must be absolute.                                                     |
| `BANDAR_SERVICE_TIMEOUT` | `30`                                 | Seconds the service step may run before the installer gives up and exits 0.                                   |
| `BANDAR_RELEASE_WEB_URL` | `https://github.com/falentio/bandar` | Origin that serves the release page and the downloads, for a mirror or a test server. Needs no token.         |
| `BANDAR_RELEASE_API_URL` | unset                                | Latest-release JSON of a private fork. Setting it selects the API route, which needs a token.                 |
| `BANDAR_GITHUB_TOKEN`    | unset                                | Token for the fork selected by `BANDAR_RELEASE_API_URL`, highest precedence. A public install never reads it. |
| `GH_TOKEN`               | unset                                | Same token, read when `BANDAR_GITHUB_TOKEN` is unset.                                                         |
| `GITHUB_TOKEN`           | unset                                | Same token, read when neither of the others is set.                                                           |

The platform pair comes from `uname`. Any pair other than Linux or Windows on x64 or arm64 exits 1
with one line before anything is downloaded.

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

## When `/usr/local/bin` is not writable

The installer prints the command to rerun and exits 1 without writing the binary:

```sh
curl -fsSL https://raw.githubusercontent.com/falentio/bandar/main/install.sh \
  | sudo BANDAR_INSTALL_DIR="/usr/local/bin" BANDAR_CONFIG_DIR="$HOME/.config/bandar" sh
```

Pass `BANDAR_CONFIG_DIR` through `sudo` as well. `sudo` sets `HOME` to root's, so a default
config path would otherwise record the install for root instead of for you.

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
