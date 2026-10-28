# bandar

bandar is a self-hosted LLM gateway that ships as one binary. Clients speak OpenAI's
chat completions API. bandar resolves the model name to a provider, translates the
request to that provider's wire, streams the answer back, and records one analytics
event per attempt in an embedded DuckDB database.

The dashboard covers providers, model tags, requests, cooldowns, API keys, and usage:
tokens, time to first token, tokens per second, error rate, p95 latency, daily
tokens, and a 30-day average. Provider credentials are sealed before they reach
SQLite.

## Why it exists

**One API for many providers.** A request names a model in one of three forms: an
alias such as `fast`, a tag such as `tags/cheap-first`, or a provider reference such
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

**Seven built-in providers.** Kilo Code, Token Harbor, Yeta, River, Nous Portal,
Hyper, and OpenCode Go are on every account, seeded empty. Kilo Code and Nous Portal
sign in with a device code. OpenCode Go picks a wire per model across the chat,
responses, messages, and GenAI endpoints. Three generic wires, `openai`, `anthropic`,
and `google`, cover a custom upstream added from the dashboard without changing code.

**Analytics that survive a deletion.** Every attempt writes one row to DuckDB:
tokens, time to first token, duration, tokens per second, the resolved alias, and the
string the client sent. The row is denormalized, so deleting a provider keeps its
history. Each failure that flags a subject also writes one row to the cooldown
history, which the Errors page lists.

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
moves the binary to `/usr/local/bin`. It records the install in
`~/.config/bandar/install.json`, which `bandar update` reads later. The repository is
public, so no token is needed.

To install into your own directory, export it on the right of the pipe, because that
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

The client listens on `:5173` and the API on `:3000`. The client proxies `/api` and
`/v1` to the API port.

### First run

```sh
BANDAR_AUTH_SECRET="$(openssl rand -hex 32)" bandar
```

Open <http://localhost:3000> and create an account. The binary creates `bandar.db` and
`bandar.duckdb` in `BANDAR_HOME`, which defaults to `~/.bandar`. Set
`BANDAR_AUTH_SECRET` to keep sessions and sealed credentials across restarts, because
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
rm -rf ~/.config/bandar ~/.bandar
```

Read [`docs/install.md`](./docs/install.md) for the installer in full, [`docs/update.md`](./docs/update.md)
for updates, and [`docs/service.md`](./docs/service.md) for the service unit.
