# Updating bandar

`bandar update` replaces the running binary with the latest GitHub release. The repository is
public, so the command reads the latest tag from a GitHub page redirect and downloads the assets
anonymously; no token is involved. A private fork opts into the API route, and only that route
reads a token.

## Commands

| Command                          | Effect                                                                                                                   |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `bandar update`                  | Download the latest release, verify its sha256, rename it over the recorded path, print the new version.                 |
| `bandar update --check`          | Print the installed version, the latest version, and one of `up-to-date`, `update-available`, `unknown`. Writes nothing. |
| `bandar update --archive <path>` | Install from a local file, with the same verify and rename path. The file `<path>.sha256` must sit next to it.           |

## How the latest version is resolved

`bandar update` reads `update.webUrl` from `config.json`, which defaults to
`https://github.com/falentio/bandar`, and requests `<webUrl>/releases/latest` without following
the redirect. It reads the version out of the `Location` header, such as
`.../releases/tag/v0.1.0`. That is a page request, not an API call, so it needs no credential and
does not spend the 60-per-hour API rate limit.

It then downloads

```text
<webUrl>/releases/download/v<version>/<asset>
<webUrl>/releases/download/v<version>/<asset>.sha256
```

with no `Authorization` header. GitHub redirects the asset to
`release-assets.githubusercontent.com`; the command follows that redirect. A 404 on the release
page means the repository has no published release, which `--check` reports as `unknown` with
exit 0.

## What it shows while it works

On a terminal, `bandar update` rewrites one row on stderr while it works:

```text
| checking the latest release
/ downloading bandar-0.3.1-linux-x64 61.2/240.0 MB 25%
- verifying sha256 240.0 MB
| installing /usr/local/bin/bandar
bandar 0.3.1 installed at /usr/local/bin/bandar
```

The frames are `|`, `/`, `-`, and `\`, drawn every 80 ms. The byte count is cumulative, and the
second number with its percentage appears only when the server declares a `Content-Length`; a
response that declares none counts bytes alone, as in
`/ downloading bandar-0.3.1-linux-x64 61.2 MB`. A row narrower than the terminal is padded to
the widest row drawn so far, so a shorter line leaves no tail of the longer one behind.

The `bandar <version> installed at <path>` line stays on stdout; the row above it is erased
first. `--archive` skips the release check and the downloads, so it shows only the verify and
the install.

When stderr is a pipe, a redirect, or a CI log, the command writes nothing there and starts no
timer. stdout is unchanged in both cases: one line for a completed update, and the three
`--check` lines for a report.

## A private fork, with a token

Set `update.apiUrl` in `config.json` to the latest-release JSON of the fork, and set a token in
the environment; the API route replaces the anonymous one:

```json
{
  "update": {
    "apiUrl": "https://api.github.com/repos/you/bandar/releases/latest"
  }
}
```

```sh
BANDAR_GITHUB_TOKEN="$TOKEN" bandar update
```

`BANDAR_RELEASE_API_URL` still stands in when the file leaves `update.apiUrl` out, the same
way `BANDAR_RELEASE_WEB_URL` stands in for `update.webUrl`. Setting the API feed without a token
exits 1 with
`bandar: update.apiUrl reads a private fork, so it needs a GitHub token: set BANDAR_GITHUB_TOKEN`
and sends no request.

The token is read from `BANDAR_GITHUB_TOKEN`, then `GH_TOKEN`, then `GITHUB_TOKEN`. It travels
in an `Authorization` header and nowhere else: not in a URL, a log line, or the argument list.
The header goes only to a host the command already trusts: `api.github.com`, `github.com`, the
public asset hosts, or the host of `update.apiUrl`. An asset url that names any other
host is refused, unread, so a release feed cannot redirect the token.

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

## An npm install

A copy installed with `npm install -g @falentio/bandar` has no `install.json`, because `install.sh` never
ran. `bandar update` refuses it in one line and writes nothing:

```text
bandar: no install.json records an install source; an npm install updates with "npm install -g @falentio/bandar@latest"; otherwise reinstall with install.sh from https://github.com/falentio/bandar to let bandar update itself
```

npm owns that copy: it recorded the version and chose where the files went, and replacing the binary
behind npm's back would leave the two disagreeing. So the update is npm's:

```sh
npm install -g @falentio/bandar@latest
```

`bandar update --check` still works for an npm copy, because a report reads the release and writes
nothing.

## What it writes

`bandar update` writes one temporary file beside the target, gives it mode 755, and renames it over
the target. The rename is the only moment the installed binary changes. On Linux a running process
keeps the inode it started with, so a live server keeps serving; restart the service to pick up the
new binary.

The command never opens or moves `bandar.db`, `bandar.duckdb`, or any other file in the config
directory. It reads `install.json` and nothing else there.

The checksum is verified before the temporary file exists. A mismatch leaves the installed binary
byte-identical, exits 1, and leaves no temporary file behind.

## Windows

Windows locks a running executable, so `bandar update` cannot replace its own image. The rename
fails, the command removes its temporary file, exits 1, and says so:

```text
bandar: Windows locks a running executable, so bandar cannot replace C:\bandar\bandar.exe from inside itself; close bandar, then run the installer again or replace C:\bandar\bandar.exe with the release download
```

Stop the service, then run `install.sh` again or download `bandar-<version>-windows-<arch>.exe`
from the release and put it in place by hand. `--check` and `--archive` report and refuse the same
way; nothing is written either time.

## Permissions

A target directory the current user cannot write prints the command to run with the privilege it
needs, and exits 1 without writing:

```text
bandar: cannot write /usr/local/bin; run "sudo bandar update" to replace /usr/local/bin/bandar
```

## Release assets

The release workflow publishes, per platform:

```text
bandar-<version>-<os>-<arch>[.exe]
bandar-<version>-<os>-<arch>[.exe].sha256
```

`<os>` is `linux` or `windows`, and `<arch>` is `x64` or `arm64`. The checksum file holds one
line, `<hex>  <filename>`. Other platforms are refused by name.

## Configuration and environment

| Setting or variable                               | Effect                                                                                                                                      |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `update.webUrl`                                   | Release web base for the release page and the downloads. Defaults to `https://github.com/falentio/bandar`, for a mirror or an offline stub. |
| `update.apiUrl`                                   | Latest-release JSON of a private fork. Setting it selects the API route, which needs a token.                                               |
| `BANDAR_RELEASE_WEB_URL`                          | Fallback for `update.webUrl` when the file leaves it out. No token.                                                                         |
| `BANDAR_RELEASE_API_URL`                          | Fallback for `update.apiUrl` when the file leaves it out.                                                                                   |
| `BANDAR_GITHUB_TOKEN`, `GH_TOKEN`, `GITHUB_TOKEN` | Token for that fork, in that order. Never read by the public route. Environment only.                                                       |
| `BANDAR_HOME`                                     | Directory holding `config.json`. Environment only.                                                                                          |
| `BANDAR_CONFIG_DIR`                               | Directory holding `install.json`. Must be absolute. Environment only.                                                                       |

## Exit codes

| Code | Meaning                                                                                                                                                                                                                                 |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0    | Up to date, updated, or a `--check` report of `up-to-date`, `update-available`, or `unknown` for a repository with no published release.                                                                                                |
| 1    | A private-fork API URL with no token, no published release to install, unknown install source, unwritable target, foreign asset host, failed download, checksum mismatch, a feed that cannot be read, or a rename the platform refuses. |
| 2    | Unknown option.                                                                                                                                                                                                                         |

## Tests

`scripts/update-test.sh` runs the command against a loopback stub release feed in a temporary
directory, with its own `BANDAR_HOME` per case. It covers the anonymous happy path, a feed named
only by `config.json`, the private-fork override, an API URL without a token, a checksum mismatch,
a foreign asset host, an unknown install source, a same-version no-op, `--check` with and without
a published release, `--archive`, and an unwritable target. It never reaches the network. `src/server/cli/update.test.ts` covers the same behavior without a filesystem
where it can.
