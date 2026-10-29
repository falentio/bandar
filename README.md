# bandar

bandar is a self-hosted LLM gateway that ships as one binary. Clients speak OpenAI's
chat completions API. bandar resolves the model name to a provider, translates the
request to that provider's wire, streams the answer back, and records one analytics
event per attempt in an embedded DuckDB database.

The dashboard covers providers, model tags, requests, cooldowns, API keys, CLI setup, and usage:
tokens, time to first token, tokens per second, error rate, p95 latency, daily tokens, and a
30-day average. Provider credentials are sealed before they reach SQLite.

## Why it exists

**One API for many providers.** A request names a model in one of three forms: an
address such as `fast`, a tag such as `tags/cheap-first`, or a provider reference such
as `kilo/qwen3-coder`. A tag is a named fallback chain, walked in order until a model
answers.

**Failures fall through instead of failing.** A request walks the models of its tag,
and each model walks its provider's credentials. A failure that another key or model
might fix moves on to the next attempt: `auth`, `rate_limit`, `not_found`,
`unavailable`, `protocol`, `network`, and `unknown`. An `invalid_request` and an
aborted request are final.

**A failing subject cools down.** Each failure flags one subject: the credential for
an auth or rate limit error, the provider for an unavailable or network error, the
model for a protocol or not found error. A flagged subject is skipped while it cools
down, for `min(30s * 2^(failures - 1), 24h)`. A success clears the flag on the
provider, the model, and the credential of that attempt. When every attempt in a plan
is cooling down, the gateway runs the plan anyway as a probe, so a request never
fails only because everything is flagged.

**Eight built-in providers.** Kilo Code, Token Harbor, Yeta, River, Nous Portal,
Hyper, OpenCode Go, and Zro are on every account, seeded empty. Kilo Code and Nous Portal
sign in with a device code. OpenCode Go picks a wire per model across the chat,
responses, messages, and GenAI endpoints. Zro answers chat and messages from one base
URL, and defaults every model to chat. Three generic wires, `openai`, `anthropic`,
and `google`, cover a custom upstream added from the dashboard without changing code.

**Analytics that survive a deletion.** Every attempt writes one row to DuckDB:
tokens, time to first token, duration, tokens per second, the resolved address, and the
string the client sent. A client names the project of an inference with
`x-bandar-project-url: https://app.example.com`; the row keeps that url's origin and
path, and the Overview page filters on it. A value that is not an http or https url is
ignored, so a typo never fails a request. The row is denormalized, so deleting a
provider keeps its history. Each failure that flags a subject also writes one row to
the cooldown history, which the Errors page lists.

**One binary at runtime.** `bun build --compile` embeds the React client, the SQLite
migrations, the DuckDB migrations, and the DuckDB shared library. The binary serves
the client and the API on one port, and holds both databases in `BANDAR_HOME`.

Not in this version: tools, images, and embeddings. The adapter contract is text
only. Prices come from a provider catalog import, not from a form.

## Install

### From a release

Install the latest release for your platform:

```sh
curl -fsSL https://raw.githubusercontent.com/falentio/bandar/main/install.sh | sh
```

The installer downloads the asset for your platform, checks its published sha256, and
moves the binary into place. It records the install in `~/.config/bandar/install.json`,
which `bandar update` reads later. The repository is public, so no token is needed, and
no sudo is needed either: `/usr/local/bin` is used when it is writable, and otherwise the
binary lands in `$XDG_BIN_HOME` or `~/.local/bin`.

When that directory is not on `PATH`, the installer appends one `export` line to your
shell's startup file. Pass `--no-modify-path` to have it printed instead:

```sh
curl -fsSL https://raw.githubusercontent.com/falentio/bandar/main/install.sh | sh -s -- --no-modify-path
```

To choose the directory yourself, export it on the right of the pipe, because that
is the side that reaches `sh`:

```sh
curl -fsSL https://raw.githubusercontent.com/falentio/bandar/main/install.sh \
  | BANDAR_INSTALL_DIR="$HOME/.local/bin" sh
```

Releases carry Linux x64 and Windows x64 builds. arm64 is not built yet.

### From a source checkout

You need Bun 1.4.3, which `.bun-version` pins.

```sh
bun install
bun run build
install -m 755 dist/bandar "$HOME/.local/bin/bandar"
```

`bun install` fetches the DuckDB library and generates the embedded modules.
`bun run build` builds the client and compiles `dist/bandar`, about 181 MB, because
the DuckDB shared library alone is about 92 MB.

To run the dev server instead of a compiled binary:

```sh
bun run dev
```

The client listens on `:5173` and the API on `:4133`. The client proxies `/api` and
`/v1` to the API port.

A run from source is a development environment. Its databases land in `~/.bandar_dev`,
so they stay clear of an installed copy, which keeps using `~/.bandar`. Set
`BANDAR_HOME` to point either one somewhere else.

### First run

```sh
BANDAR_AUTH_SECRET="$(openssl rand -hex 32)" bandar
```

Open <http://localhost:4133> and create an account. The binary creates `bandar.db` and
`bandar.duckdb` in `BANDAR_HOME`, which defaults to `~/.bandar` for an installed binary.
Set `BANDAR_AUTH_SECRET` to keep sessions and sealed credentials across restarts, because
the default is generated per boot and changing the secret makes stored credentials
unreadable.

To run it under systemd rather than in a shell:

```sh
bandar install-service --scope user
```

### Update and uninstall

```sh
bandar update
bandar uninstall-service --scope user
rm "$(command -v bandar)"
rm -rf ~/.config/bandar ~/.bandar ~/.bandar_dev
```

Read [`docs/install.md`](./docs/install.md) for the installer in full, [`docs/update.md`](./docs/update.md)
for updates, and [`docs/service.md`](./docs/service.md) for the service unit. To point a
coding CLI at the gateway, read [`docs/cli-tools.md`](./docs/cli-tools.md).

## Configuration

`bandar` reads `config.json` from `BANDAR_HOME` on every start. A missing file means
the defaults. An installed binary reads `~/.bandar/config.json` and a source checkout
reads `~/.bandar_dev/config.json`. A service unit moves `BANDAR_HOME` to its data
directory, so the service reads `<data dir>/config.json`:
`~/.local/share/bandar/config.json` for a user unit and `/var/lib/bandar/config.json`
for a system one.

```json
{
  "$schema": "./config.schema.json",
  "server": {
    "host": "0.0.0.0",
    "port": 4133,
    "authUrl": "https://llm.example.com",
    "trustedOrigins": ["https://llm.example.com"]
  },
  "providers": {
    "kilocode": {
      "baseUrl": "https://api.kilo.ai/api/openrouter",
      "catalogUrl": "https://api.kilo.ai/api/gateway/models"
    },
    "nous": {
      "baseUrl": "https://inference-api.nousresearch.com/v1",
      "authUrl": "https://portal.nousresearch.com"
    }
  },
  "update": {
    "webUrl": "https://github.com/falentio/bandar"
  }
}
```

| key                     | value                        | default                              |
| ----------------------- | ---------------------------- | ------------------------------------ |
| `server.host`           | a non-empty string           | `0.0.0.0`                            |
| `server.port`           | an integer from 0 to 65535   | `4133`                               |
| `server.authUrl`        | an http or https URL         | `http://localhost:<port>`            |
| `server.trustedOrigins` | a non-empty array of origins | derived, see below                   |
| `update.webUrl`         | an http or https URL         | `https://github.com/falentio/bandar` |
| `update.apiUrl`         | an http or https URL         | none, so the public release page     |

`providers.<kind>` holds the endpoints of one built-in provider. Every field is a full
http or https URL, and only the fields its kind uses exist:

| kind          | fields                  |
| ------------- | ----------------------- |
| `kilocode`    | `baseUrl`, `catalogUrl` |
| `tokenharbor` | `baseUrl`               |
| `yeta`        | `baseUrl`               |
| `river`       | `baseUrl`, `catalogUrl` |
| `nous`        | `baseUrl`, `authUrl`    |
| `hyper`       | `baseUrl`               |
| `opencode`    | `baseUrl`               |
| `zro`         | `baseUrl`               |

`baseUrl` is the full wire base, mount included. `catalogUrl` is the model catalog
document. `authUrl` is the OAuth origin and prefix. Kilo Code has no `authUrl`: its
login origin is its base URL without `/api/openrouter`.

Every key is optional, and so is every section. An origin is a URL with no path, query,
fragment, or credentials, and it stores as the URL's origin, so `https://X.COM/`
becomes `https://x.com`. The file is strict: an unknown key, an unknown provider kind, a
provider field its kind does not have, a root that is not a JSON object, an empty host, a
port that is not a whole number in range, an empty `server.trustedOrigins`, an origin
with a path, a URL that is not http or https, and a file that is not JSON all fail the
boot, and the message names the file and the field. A typo never falls back to a default.
`server.webPort` is no longer a key, so a file that still carries it fails the boot; delete
the line.

`bandar` writes `config.schema.json` beside the settings on every read, and adds
`"$schema": "./config.schema.json"` to a `config.json` that lacks the key, so an editor
completes and checks the file offline. The document is generated from the parser with
[`@valibot/to-json-schema`](https://www.npmjs.com/package/@valibot/to-json-schema), by the
binary that wrote it, so its keys, types, and bounds are the ones that boot accepts. The URL
grammar behind an origin cannot be written in JSON Schema, so an editor accepts a few values
the server still rejects at boot. A `$schema` you wrote yourself is left alone, and adding
the key changes nothing else in the file. Neither write is required: a data directory that
is not writable only costs the editor completion.

The default trusted origins start with the auth URL's own origin. They then follow the
resolved API port: `http://localhost:<port>` and `http://127.0.0.1:<port>`, plus
`http://<host>:<port>` when `server.host` names an address rather than `0.0.0.0` or
`::`. Only a development run adds the web dev server, at `http://localhost:5173`
and `http://127.0.0.1:5173`.

A `server.port` of 0 asks the OS for an ephemeral port. The server binds one, but the
derived auth URL and trusted origins name port 0 and reach nothing, so set
`server.authUrl` and `server.trustedOrigins` yourself when the port is 0.

`config.json` wins over the environment, and the environment wins over the built-in
default. A blank environment variable counts as unset, so an existing deployment keeps
working without a file. The provider variables keep their old origin meaning, and the
resolver appends the kind's mount: `BANDAR_RIVER_API=http://127.0.0.1:9000` still
resolves to `http://127.0.0.1:9000/v1`. Read
[`docs/adapters.md`](./docs/adapters.md#endpoints) for the variable behind each provider
field.

| setting                 | fallback variable        |
| ----------------------- | ------------------------ |
| `server.host`           | `BANDAR_HOST`            |
| `server.port`           | `BANDAR_PORT`            |
| `server.authUrl`        | `BANDAR_AUTH_URL`        |
| `server.trustedOrigins` | `BANDAR_TRUSTED_ORIGINS` |
| `update.webUrl`         | `BANDAR_RELEASE_WEB_URL` |
| `update.apiUrl`         | `BANDAR_RELEASE_API_URL` |

The dev server in `vite.config.ts` reads `server.port` from the same file for its proxy, so
`bun run dev` follows an edit there. Vite itself always listens on 5173.

These stay in the environment only: `BANDAR_HOME` and `BANDAR_CONFIG_DIR`, which
locate files; `BANDAR_AUTH_SECRET`, because the data directory is world-readable and the
env file is mode 600; `BANDAR_GITHUB_TOKEN`, `GH_TOKEN`, and `GITHUB_TOKEN`, which
are secrets for `bandar update`; and the installer's inputs.

Behind a reverse proxy, set `server.authUrl` to the public URL, such as
`https://llm.example.com`. Its origin joins the default trusted origins, so sign-in links
and the browser's origin check agree with that one key. A file that sets
`server.trustedOrigins` replaces the whole default list, so repeat every origin the
browser uses, the auth URL's included. `authSecret` is not a settings key: the data
directory is world-readable, while the service env file is mode 600.

Run `bandar config` to write the schema, point the file at it, and print what it
resolved and where each value came from:

```text
settings                       /home/andrew/.bandar/config.json (missing)
mode                           development
server.host                    0.0.0.0 (default)
server.port                    4133 (default)
server.authUrl                 http://localhost:4133 (default)
server.trustedOrigins          http://localhost:4133, http://127.0.0.1:4133, http://localhost:5173, http://127.0.0.1:5173 (default)
providers.kilocode.baseUrl     https://api.kilo.ai/api/openrouter (default)
providers.kilocode.catalogUrl  https://api.kilo.ai/api/gateway/models (default)
providers.tokenharbor.baseUrl  https://tokenharbor.ai/v1 (default)
providers.yeta.baseUrl         https://platform.yeta.ai/v1 (default)
providers.river.baseUrl        https://api.river.ai/v1 (default)
providers.river.catalogUrl     https://console.river.ai/api/public/pricing (default)
providers.nous.baseUrl         https://inference-api.nousresearch.com/v1 (default)
providers.nous.authUrl         https://portal.nousresearch.com (default)
providers.hyper.baseUrl        https://hyper.charm.land/v1 (default)
providers.opencode.baseUrl     https://opencode.ai/inference (default)
providers.zro.baseUrl          https://zro.moonmath.ai/v1 (default)
update.webUrl                  https://github.com/falentio/bandar (default)
update.apiUrl                  none (default)
```

`bandar` reads the file on every start, so a restart applies an edit to a server key. A
provider endpoint edit also reaches the gateway on the next request and the seeded built-in
row on the next provider listing.
`bandar install-service --port` writes `BANDAR_PORT` into the unit, which is the
fallback tier: a `server.port` in the file outranks it, so leave `server.port` out
of the file when the unit should own the port. Read
[`docs/service.md`](./docs/service.md) for the unit.
