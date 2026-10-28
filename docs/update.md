# Updating bandar

`bandar update` replaces the running binary with the latest GitHub release. The repository is
private, so the command reads the release feed through the GitHub API with a token.

## Commands

| Command                          | Effect                                                                                                                   |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `bandar update`                  | Download the latest release, verify its sha256, rename it over the recorded path, print the new version.                 |
| `bandar update --check`          | Print the installed version, the latest version, and one of `up-to-date`, `update-available`, `unknown`. Writes nothing. |
| `bandar update --archive <path>` | Install from a local file, with the same verify and rename path. The file `<path>.sha256` must sit next to it.           |

## Token

The command reads a token from `BANDAR_GITHUB_TOKEN`, then `GH_TOKEN`, then `GITHUB_TOKEN`. The
token travels in an `Authorization` header and nowhere else: not in a URL, a log line, or the
argument list.

Without a token the command cannot tell a private repository's 404 from a missing release, so it
prints `a GitHub token is required: set BANDAR_GITHUB_TOKEN` and exits 1. With a token, a 404 means
the repository has no published release yet, which `--check` reports as `unknown`.

## Install source

`install.sh` records where the binary came from in `$BANDAR_CONFIG_DIR/install.json`, which
defaults to `~/.config/bandar/install.json`:

```json
{ "source": "install-script", "version": "0.1.0", "path": "/usr/local/bin/bandar" }
```

`bandar update` replaces the binary only when the recorded source is `install-script` or `manual`.
A missing manifest, malformed JSON, or a source of `unknown` refuses the update in one line and
exits 1 without writing. The manifest's `path` is the target; `bandar update` never rewrites the
manifest.

## What it writes

`bandar update` writes one temporary file beside the target, gives it mode 755, and renames it over
the target. The rename is the only moment the installed binary changes. A running process keeps the
inode it started with, so a live server keeps serving; restart the service to pick up the new binary.

The command never opens or moves `bandar.db`, `bandar.duckdb`, or any other file in the config
directory. It reads `install.json` and nothing else there.

The checksum is verified before the temporary file exists. A mismatch leaves the installed binary
byte-identical, exits 1, and leaves no temporary file behind.

## Permissions

A target directory the current user cannot write prints the command to run with the privilege it
needs, and exits 1 without writing:

```
bandar: cannot write /usr/local/bin; run "sudo bandar update" to replace /usr/local/bin/bandar
```

## Release assets

The release workflow publishes, per platform:

```
bandar-<version>-<os>-<arch>[.exe]
bandar-<version>-<os>-<arch>[.exe].sha256
```

`<os>` is `linux` or `windows`, and `<arch>` is `x64` or `arm64`. The checksum file holds one
line, `<hex>  <filename>`. Other platforms are refused by name.

## Environment

| Variable                                          | Effect                                                                                       |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `BANDAR_GITHUB_TOKEN`, `GH_TOKEN`, `GITHUB_TOKEN` | Token for the release feed, in that order.                                                   |
| `BANDAR_UPDATE_URL`                               | Replaces `https://api.github.com` as the API base, for an offline stub or a registry mirror. |
| `BANDAR_CONFIG_DIR`                               | Directory holding `install.json`. Must be absolute.                                          |

## Exit codes

| Code | Meaning                                                                                                 |
| ---- | ------------------------------------------------------------------------------------------------------- |
| 0    | Up to date, updated, or a `--check` report of any state.                                                |
| 1    | No token, no release, unknown install source, unwritable target, failed download, or checksum mismatch. |
| 2    | Unknown option.                                                                                         |

## Tests

`scripts/update-test.sh` runs the command against a loopback stub release feed in a temporary
directory. It covers the happy path, a checksum mismatch, an unknown install source, a same-version
no-op, `--check`, `--archive`, a missing token, and an unwritable target. It never reaches the
network. `src/server/cli/update.test.ts` covers the same behavior without a filesystem where it can.
