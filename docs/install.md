# Install bandar

bandar ships prebuilt binaries for Linux and Windows on x64 and arm64. The installer
downloads the asset for the running platform, checks the published sha256, moves the
binary into place, and records where it came from so `bandar update` can replace it later.

## One-liner

```sh
curl -fsSL https://raw.githubusercontent.com/falentio/bandar/main/install.sh | sh
```

Pin a version, install under your home directory, and register a user service:

```sh
curl -fsSL https://raw.githubusercontent.com/falentio/bandar/main/install.sh \
  | BANDAR_VERSION=0.1.0 BANDAR_INSTALL_DIR="$HOME/.local/bin" BANDAR_SCOPE=user sh
```

The script reads no input, so it runs the same from a pipe and from a checkout:

```sh
./install.sh
```

## What the installer writes

- The binary at `$BANDAR_INSTALL_DIR/bandar`, renamed `bandar.exe` on Windows. It lands
  through a temporary name in the same directory, so a failure never leaves a half
  written binary at the final path.
- `$BANDAR_CONFIG_DIR/install.json` with the install source, for `bandar update`:

  ```json
  { "source": "install-script", "version": "0.1.0", "path": "/usr/local/bin/bandar" }
  ```

  The directory is created with mode 700 and defaults to `~/.config/bandar`.

Nothing is written outside those two directories, and the installer never calls sudo.

## Environment variables

| Variable                  | Default                                                        | Meaning                                                                                                                 |
| ------------------------- | -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `BANDAR_VERSION`          | the latest release                                             | Version to install. A leading `v` is allowed.                                                                           |
| `BANDAR_INSTALL_DIR`      | `/usr/local/bin`                                               | Directory that receives the binary. Created when missing.                                                               |
| `BANDAR_SCOPE`            | unset                                                          | `user` or `system`. After the install, run `bandar install-service --scope <scope>`.                                    |
| `BANDAR_CONFIG_DIR`       | `~/.config/bandar`                                             | Directory that receives `install.json`.                                                                                 |
| `BANDAR_SERVICE_TIMEOUT`  | `30`                                                           | Seconds the service step may run before the installer gives up and exits 0.                                             |
| `BANDAR_RELEASE_BASE_URL` | the GitHub release for the resolved version                    | Directory that holds the assets and their `.sha256` siblings. Include the version segment when pointing it at a mirror. |
| `BANDAR_RELEASE_API_URL`  | `https://api.github.com/repos/falentio/bandar/releases/latest` | JSON that names the latest tag. A mirror or an offline test server can replace it.                                      |

The platform pair comes from `uname`. Any pair other than Linux or Windows on x64 or
arm64 exits 1 with one line before anything is downloaded.

## Verify a download by hand

Assets are named `bandar-<version>-<os>-<arch>`, with `.exe` on Windows only. Each has a
sibling `.sha256` file whose line is `<hex>  <filename>`.

```sh
curl -fsSLO https://github.com/falentio/bandar/releases/download/v0.1.0/bandar-0.1.0-linux-x64
curl -fsSLO https://github.com/falentio/bandar/releases/download/v0.1.0/bandar-0.1.0-linux-x64.sha256
sha256sum -c bandar-0.1.0-linux-x64.sha256
```

On macOS, where `sha256sum` is absent, use `shasum -a 256 -c`. The installer accepts
either tool and refuses to install when it finds neither.

## When `/usr/local/bin` is not writable

The installer prints the command to rerun and exits 1 without writing the binary:

```sh
curl -fsSL https://raw.githubusercontent.com/falentio/bandar/main/install.sh \
  | sudo BANDAR_INSTALL_DIR="/usr/local/bin" BANDAR_CONFIG_DIR="$HOME/.config/bandar" sh
```

Pass `BANDAR_CONFIG_DIR` through `sudo` as well. `sudo` sets `HOME` to root's, so a
default config path would otherwise record the install for root instead of for you.

## Register the service

After a successful install, `BANDAR_SCOPE=user` or `BANDAR_SCOPE=system` hands off to the
binary:

```sh
bandar install-service --scope user
bandar install-service --scope system
```

A build without that subcommand, or one that does not finish within
`BANDAR_SERVICE_TIMEOUT`, prints one line that says the service step was skipped. The
installer still exits 0, because the binary is installed.

## Manual build

For a source checkout, build and place the binary yourself:

```sh
bun install
bun run build
install -m 755 dist/bandar "$HOME/.local/bin/bandar"
```

`bun run build` compiles `dist/bandar` (`dist/bandar.exe` on Windows) and embeds the web
client. On Windows, copy the file with `copy dist\bandar.exe %USERPROFILE%\bandar.exe`.

Record the manual source so `bandar update` knows how the binary arrived:

```json
{ "source": "manual", "version": "0.1.0", "path": "/home/you/.local/bin/bandar" }
```

Write it to `~/.config/bandar/install.json`, or next to `BANDAR_CONFIG_DIR` when you set
that variable.

## Update and uninstall

`bandar update` reads `install.json`, resolves the latest release, and replaces the binary
at the recorded path when the source is `install-script` or `manual`.

```sh
bandar uninstall-service --scope user
rm "$(command -v bandar)"
rm -rf "${BANDAR_CONFIG_DIR:-$HOME/.config/bandar}"
```

## Test the installer

`scripts/install-test.sh` serves a stub release from `127.0.0.1` and runs the real
`install.sh` against it, with a temporary install and config directory:

```sh
sh -n install.sh
scripts/install-test.sh
```
