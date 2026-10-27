# bandar

A self-hosted LLM gateway that ships as one binary. Clients speak OpenAI's chat
completions API; bandar resolves the model alias to a provider, translates the
request to that provider's wire, streams the answer back, and records one
analytics event per attempt in an embedded DuckDB database.

The dashboard covers providers, requests, API keys, and usage: tokens, time to
first token, tokens per second, error rate, p95 latency, daily tokens, and a
30-day average. Provider credentials are sealed before they reach SQLite.

## What works

- OpenAI-compatible `POST /v1/chat/completions`, streaming and non-streaming.
- OpenAI-compatible `GET /v1/models` for the caller's aliases.
- Three generic wires for custom providers: `openai`, `anthropic`, and `google`.
- Built-in Kilo Code, present on every account, with a device-code login.
- Custom providers added from the dashboard without changing code.
- Provider and model-alias management in the dashboard or over `/api`.
- Gateway keys from better-auth's API-key plugin, sent as
  `Authorization: Bearer <key>` or `x-api-key`.
- Per-request analytics in DuckDB with SQL migrations embedded in the binary.
- Email/password accounts and per-user data isolation.

Not in v1: tools, images, embeddings, the responses API, fallback chains, and
cost sync beyond the Kilo Code catalog. The adapter contract is text-only and
says so.

## Quickstart

```sh
bun install          # fetches the DuckDB library and generates embedded modules
BANDAR_AUTH_URL=http://localhost:5173 bun run dev   # client :5173, API :3000
```

Open <http://localhost:5173>, create an account, then:

1. **Kilo Code** is already on the Providers page. Open it and approve the device
   code on its **Connection** tab. Its **Import catalog** button adds models.
2. To add a custom upstream, click **Add custom provider**, pick one of the three generic
   wires, and paste its base URL and key. Then add models: upstream model
   `gpt-4o-mini` with alias `fast` makes `fast` the name clients send.
3. Open **API keys** and mint a key. The plaintext appears once.
4. Call the gateway:

```sh
curl http://localhost:3000/v1/chat/completions \
  -H "Authorization: Bearer bandar_..." \
  -H "content-type: application/json" \
  -d '{"model":"fast","messages":[{"role":"user","content":"hello"}]}'
```

Add `"stream": true` for server-sent events. The response uses OpenAI's chunk
format and ends with `data: [DONE]`.

The dev client proxies `/api` and `/v1` to the API port, so a page loaded from
`:5173` can call the gateway at the same origin.

## How a request flows

```text
POST /v1/chat/completions [1]
├── authenticate the gateway key [1a] ✗ 401
├── parse the OpenAI body with valibot [1b] ✗ 422
├── resolve the alias for this user [1c] ✗ 404 model_not_found
├── pick the adapter for the provider kind [1d]
├── call the upstream [1e] ✗ 502/429 and record the failure
│   └── normalize wire events into canonical text, usage and finish events [1e1]
├── stream OpenAI chunks back to the client [1f]
└── record one DuckDB event with tokens, TTFT, duration and tokens/sec [1g]
```

Provider credentials are decrypted only inside `resolveTarget` for the duration
of an upstream call. `GET /api/providers` returns `authMode` and `hasKey`, never
the key or token. A device-code login keeps the device code on the server: the
browser sees only the short user code it types at kilocode.ai.

## Analytics

Each attempt writes one row to `request_events`, including failures and aborts.
The fields are denormalized, so deleting a provider does not erase its history.

| Metric             | Definition                                                                                                         |
| ------------------ | ------------------------------------------------------------------------------------------------------------------ |
| TTFT               | Gateway time from request start to the first non-empty text delta.                                                 |
| Duration           | Gateway time from request start to the last byte handled.                                                          |
| Tokens/sec         | `output_tokens / ((duration - ttft) / 1000)`. Null when either side is unknown or the denominator is not positive. |
| Average tokens/day | Total input + output tokens in the window divided by the number of days.                                           |
| Error rate         | Non-success events divided by all events.                                                                          |
| p50 / p95 latency  | Approximate quantiles of `duration_ms`.                                                                            |
| Cost               | Input and output tokens priced per million when the model has prices. Null otherwise.                              |

Non-streaming requests have no observable first token, so they record
`ttft_ms = null` and `tokens_per_second = null`. The dashboard shows `—`.

The overview defaults to 30 days and can switch to 7 or 90. The API is
`GET /api/analytics?days=30`; recent attempts are `GET /api/requests?limit=50`.

## Adding a provider adapter

An adapter is one file plus one registry entry. The registry is a `satisfies
Record<ProviderKind, ProviderAdapter>`, so a new kind fails the type check until
every switch has an adapter.

1. Add the wire kind to `GENERIC_PROVIDER_KINDS` in `./src/shared/providers.ts`.
2. Create `./src/server/router/adapters/<kind>.ts` implementing `ProviderAdapter`.
3. Register it in `./src/server/router/adapters/index.ts`.
4. Add a fake upstream branch and one streaming plus one non-streaming smoke
   check in `./scripts/smoke.ts`.
5. If it is a built-in provider rather than a generic wire, add its definition to
   `BUILT_IN_PROVIDERS`, add its adapter kind to `BUILT_IN_PROVIDER_KINDS`, and
   implement its OAuth connector in `./src/server/oauth.ts`. Built-in rows are
   seeded per account and cannot be added or removed from the UI.

The full contract, wire mapping, and streaming rules are in
[`docs/adapters.md`](./docs/adapters.md). Adapters never return wire types to the
gateway: they normalize to `CanonicalResult` or `CanonicalStreamEvent`, and they
throw `UpstreamError` with a kind the gateway maps to an HTTP status.

## Environment

| Variable                     | Default                                       | Meaning                                                                                    |
| ---------------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `BANDAR_HOST`                | `0.0.0.0`                                     | Bind address for the API and the compiled binary.                                          |
| `BANDAR_PORT`                | `3000`                                        | API port. `0` picks a free port and the boot line reports it.                              |
| `BANDAR_WEB_PORT`            | `5173`                                        | Vite dev port. Not read by the compiled binary.                                            |
| `BANDAR_DB`                  | `./bandar.db`                                 | SQLite metadata path. Created on first boot.                                               |
| `BANDAR_DUCKDB`              | `./bandar.duckdb`                             | DuckDB analytics path. Created on first boot.                                              |
| `BANDAR_AUTH_URL`            | `http://localhost:<BANDAR_PORT>`              | better-auth base URL. In dev, set it to the Vite origin.                                   |
| `BANDAR_AUTH_SECRET`         | random per boot                               | Signs sessions and derives the credential encryption key. Set it in production.            |
| `BANDAR_TRUSTED_ORIGINS`     | `http://localhost:5173,http://127.0.0.1:5173` | Comma-separated origins allowed to POST to `/api/auth/*`.                                  |
| `BANDAR_DUCKDB_LIB`          | unset                                         | Override the `libduckdb` shared library path, for a manual install.                        |
| `BANDAR_KILOCODE_API`        | `https://api.kilo.ai`                         | Kilo Code origin for device login and the seeded gateway URL. Point it at a fake in tests. |
| `BANDAR_KILOCODE_MODELS_URL` | `https://api.kilo.ai/api/gateway/models`      | Kilo Code model catalog. Point it at a fake in tests.                                      |

Invalid values fail at startup before the port opens.

In dev, a custom web port also needs a matching auth origin:

```sh
BANDAR_WEB_PORT=4000 \
BANDAR_AUTH_URL=http://localhost:4000 \
BANDAR_TRUSTED_ORIGINS=http://localhost:4000 \
bun run dev
```

## Build

```sh
bun run build        # dist/bandar, about 181 MB
BANDAR_AUTH_SECRET=$(openssl rand -hex 32) ./dist/bandar
```

The binary serves the client and API on one port (`BANDAR_PORT`, default 3000)
and creates `bandar.db` and `bandar.duckdb` beside the working directory. It
carries the built React assets, both migration sets, and the DuckDB shared
library. Nothing else is needed at runtime.

### How DuckDB is embedded

`bun build --compile` embeds `./vendor/duckdb/libduckdb.so` through an import
with `type: "file"`. At boot, `bun:ffi` opens that virtual path directly, so no
library is written beside the binary. `bun run duck:fetch` copies the platform
library from `@duckdb/node-bindings` into `vendor/duckdb/`; it runs on install and
before every dev start and compile.

This is why the binary is large: the DuckDB shared library is about 92 MB.
DuckDB calls are synchronous, so a dashboard query blocks the event loop for its
duration. The event inserts and the bounded analytics queries take milliseconds;
a large ad-hoc scan would need a worker.

## Migrations

Two independent ledgers run at boot, before the port opens.

**SQLite metadata.** Drizzle Kit writes `./drizzle/000N_<name>.sql` and the
journal. `./scripts/gen.ts` embeds every journal entry. The ledger is
`_bandar_migrations(tag, checksum, applied_at)`; a missing embedded tag is a
downgrade error, a changed body is a drift error, and each pending migration runs
inside `BEGIN IMMEDIATE`. Fix a shipped migration by adding the next one.

**DuckDB analytics.** Add `./duckdb/000N_<snake_name>.sql`. `gen` sorts and embeds
the whole directory, so there is no journal to edit. The ledger is
`_bandar_duck_migrations` with the same checksum, drift, downgrade, and
transaction rules. Statements are split on semicolons outside quotes; keep
semicolons out of string literals in a migration.

`GET /api/health` reports both current tags.

## Commands

| Script                   | What it does                                                                     |
| ------------------------ | -------------------------------------------------------------------------------- |
| `bun run dev`            | Fetch DuckDB, `gen`, Vite, and the watched API in parallel.                      |
| `bun run dev:web`        | Vite alone.                                                                      |
| `bun run dev:server`     | `gen`, then the API with `bun --watch`.                                          |
| `bun run gen`            | Embed client assets, SQLite migrations, DuckDB migrations, and the library path. |
| `bun run build:client`   | `vp build` to `dist/client`.                                                     |
| `bun run compile`        | `gen --strict` then `bun build --compile` to `dist/bandar`.                      |
| `bun run build`          | Client build, then compile.                                                      |
| `bun run start`          | Run `./dist/bandar`.                                                             |
| `bun run check`          | Format, lint, and type-check.                                                    |
| `bun run check:fix`      | The same with fixes.                                                             |
| `bun run test`           | Vitest: migration ledgers, analytics queries, metric math.                       |
| `bun run smoke`          | Boot `dist/bandar` and run 36 end-to-end checks against fake upstreams.          |
| `bun run verify`         | `check`, `test`, `build`, `smoke`.                                               |
| `bun run db:generate`    | Drizzle Kit migration from the SQLite schema.                                    |
| `bun run db:auth-schema` | Regenerate `src/server/db/auth-schema.ts`.                                       |
| `bun run duck:fetch`     | Copy the platform DuckDB library into `vendor/duckdb/`.                          |

The smoke run mints a user, creates one provider per kind against local fake
upstreams, approves a fake Kilo Code device login, imports a catalog with an
alias collision, calls the gateway streaming and non-streaming, asserts
TTFT/tokens-per-second in DuckDB, revokes the key, restarts the binary, and
proves the analytics rows survived.

## Layout

```text
bandar/
├── duckdb/                         # DuckDB migrations, embedded by gen
├── drizzle/                        # SQLite migrations + journal
├── scripts/
│   ├── gen.ts                      # asset + migration embedding
│   ├── fetch-duckdb.ts             # platform library into vendor/
│   └── smoke.ts                    # compiled-binary end-to-end checks
├── src/shared/                     # valibot schemas and paths for both sides
│   ├── chat.ts                     # OpenAI ingress schema, model list
│   ├── providers.ts                # provider kinds, provider/model schemas
│   ├── analytics.ts                # analytics and request schemas
│   ├── api.ts                      # /api and /v1 prefix guards, health
│   ├── api-keys.ts                 # gateway key paths and schemas
│   ├── auth.ts                     # auth paths and session schemas
│   └── topology.ts                 # dev ports
├── src/server/
│   ├── main.ts                     # config → SQLite → DuckDB → auth → serve
│   ├── app.ts                      # /v1 → gateway, /api → API, else static
│   ├── gateway.ts                  # Elysia /v1 routes and caller auth
│   ├── api.ts                      # management routes, session/key gate
│   ├── analytics.ts                # DuckDB reads and window math
│   ├── providers.ts                # provider/model repo, catalog import, target resolution
│   ├── credential.ts               # api-key / oauth credential union
│   ├── oauth.ts                    # device-code connectors per OAuth kind
│   ├── seal.ts                     # AES-GCM credential sealing
│   ├── router/
│   │   ├── types.ts                # canonical request/result/stream contract
│   │   ├── metrics.ts              # tokens/sec, cost, error-rate math
│   │   ├── record.ts               # one request event -> DuckDB
│   │   ├── chat.ts                 # resolve, call, stream, record
│   │   ├── wire.ts                 # OpenAI response and error envelopes
│   │   └── adapters/
│   │       ├── index.ts            # satisfies Record<ProviderKind, Adapter>
│   │       ├── http.ts             # URL join, SSE parsing, upstream errors
│   │       ├── openai.ts
│   │       ├── anthropic.ts
│   │       ├── google.ts
│   │       └── kilocode.ts
│   ├── duck/
│   │   ├── ffi.ts                  # dlopen + symbol table
│   │   ├── client.ts               # prepared queries, typed binds
│   │   └── migrate.ts              # DuckDB ledger and statement splitter
│   ├── db/                         # drizzle schema, client, SQLite migrator
│   ├── auth.ts                     # better-auth handler, session, key verify
│   └── assets.ts                   # embedded client bundle and SPA fallback
├── src/client/
│   ├── router.tsx                  # /overview, /providers, /providers/:id, /requests, /api-keys
│   ├── views.tsx                   # navigation registry
│   ├── use-providers.ts            # provider and model mutations
│   ├── use-provider-detail.ts      # one provider with its usage window
│   ├── use-analytics.ts            # overview window state
│   ├── use-requests.ts             # recent request state
│   └── components/
│       ├── overview-panel.tsx      # stat cards, 30-day chart, model table
│       ├── providers-panel.tsx     # provider list and add dialog
│       ├── provider-page.tsx       # one provider: overview, settings, models, credential
│       ├── connect-flow.tsx        # Kilo Code device-code approval
│       ├── token-chart.tsx         # shared daily token bars
│       ├── provider-logo.tsx       # mark per provider kind
│       ├── requests-panel.tsx      # recent attempts
│       ├── api-keys-panel.tsx      # mint, show once, revoke, curl example
│       ├── app-shell.tsx           # sidebar shell and breadcrumb
│       └── auth-page.tsx           # sign-in / sign-up
├── src/components/ui/              # shadcn primitives
├── vendor/duckdb/                  # gitignored platform library
└── tools/oxlint/anti-slop/         # vendored lint rules
```

## API surface

| Route                                       | Auth                   | Purpose                                                 |
| ------------------------------------------- | ---------------------- | ------------------------------------------------------- |
| `POST /v1/chat/completions`                 | Gateway key            | OpenAI-compatible chat, streaming or not.               |
| `GET /v1/models`                            | Gateway key            | Aliases for the caller.                                 |
| `GET/POST /api/providers`                   | Session or `x-api-key` | List providers, or add a custom provider.               |
| `PUT/DELETE /api/providers/:id`             | Session or `x-api-key` | Edit a custom provider, or remove it with its models.   |
| `GET /api/providers/:id?days=30`            | Session or `x-api-key` | One provider plus its window usage.                     |
| `POST /api/providers/:id/models`            | Session or `x-api-key` | Add one model alias; returns the provider.              |
| `POST /api/providers/:id/models/refresh`    | Session or `x-api-key` | Import new models from the Kilo Code catalog.           |
| `DELETE /api/providers/:id/models/:modelId` | Session or `x-api-key` | Remove a model alias; returns the provider.             |
| `POST /api/providers/:id/oauth/start`       | Session or `x-api-key` | Start a Kilo Code device login; returns a user code.    |
| `POST /api/providers/:id/oauth/poll`        | Session or `x-api-key` | Poll the pending login; stores the token when approved. |
| `GET /api/analytics?days=30`                | Session or `x-api-key` | Window summary, daily series, model breakdown.          |
| `GET /api/requests?limit=50&providerId=…`   | Session or `x-api-key` | Recent attempts, optionally one provider.               |
| `GET /api/health`                           | none                   | Both current migration tags.                            |
| `/api/auth/*`                               | better-auth            | Sign-up, sign-in, sessions, key create/list/delete.     |

Each provider has its own page at `/providers/<id>` with four tabs:
**Overview** (usage for 7, 30, or 90 days plus recent requests), **Settings**
(name, kind, base URL), **Models** (aliases, removal, and for Kilo Code a catalog
import), and **API key** or **Connection** (set or replace the sealed upstream
key, connect a Kilo Code account, remove a custom provider). The tab lives in the
URL as `?tab=`, so a reload or a shared link opens the same tab. Custom providers
are created empty and grow models one at a time; Kilo Code is seeded empty for
every account. Built-in settings come from code and are read-only, and a built-in
cannot be removed. `PUT /api/providers/:id` replaces name, kind, and base URL for
a custom provider, and leaves the credential unchanged when `apiKey` is empty.
Model prices are accepted by the model endpoints (`inputPricePerMtok`,
`outputPricePerMtok`) and filled by the Kilo Code catalog import; they are not in
the form yet.

## Security notes

- Provider credentials, including Kilo Code OAuth tokens, are sealed with AES-GCM
  under a key derived from `BANDAR_AUTH_SECRET`. Changing the secret makes stored
  credentials unreadable; the gateway returns an upstream error until they are
  re-entered.
- Credentials never appear in API responses, logs, or analytics events. The Kilo
  Code device code stays on the server; only the short user code is returned.
- A bad gateway key is final: it is a 401 and the session cookie is not consulted
  on `/v1`.
- One user cannot resolve another user's aliases, providers, events, or keys.
- The `BANDAR_AUTH_SECRET` default is generated per boot. Set it to keep sessions
  and stored credentials across restarts.

## Limits and next steps

- **Text only.** The canonical request carries messages, temperature, top-p,
  max tokens, and stop. Tools, multimodal parts, and reasoning controls are not
  translated.
- **One writer for DuckDB.** Do not run two bandar processes against the same
  analytics file. SQLite is WAL, DuckDB is not multi-process-writer.
- **Single process.** DuckDB FFI is synchronous. Move slow scans to a worker or a
  pre-aggregated table before the history gets large.
- **No fallbacks or retries.** One alias maps to one model. The alias table can
  grow an ordered fallback list without changing the adapter contract.
- **No OAuth refresh.** A Kilo Code device token is stored as issued. Reconnect
  when it expires.
- **No pricing form.** Set prices through the API or import the Kilo Code
  catalog; the overview computes cost only for priced models.

## Lint policy

`vp check` runs oxfmt, oxlint, tsgolint, and the vendored
[anti-slop](https://github.com/dmmulroy/anti-slop) rules in
`./tools/oxlint/anti-slop/`. The generic rules are errors, including the `unknown`
family, `no-runtime-typeof`, `no-known-value-widening`, `no-object-parameters`,
and `require-safety-comment-for-type-assertion`. A type assertion needs a
`// SAFETY:` line that states the invariant. The vendored copy is MIT-licensed
and is local policy: edit it here when it disagrees with the project.

## Generated files

`src/server/generated/` is gitignored and written by `scripts/gen.ts` and the
DuckDB fetch script:

- `client-assets.ts` stages every `dist/client` file and imports it with
  `type: "file"`.
- `migrations.ts` imports each journaled SQLite migration as text.
- `duck-migrations.ts` imports every `duckdb/*.sql` as text, sorted by filename.
- `duck-lib.ts` imports the vendored DuckDB library with `type: "file"`.

`gen` writes only on change. `gen --strict`, used by compile, refuses to build
without a client bundle, a SQLite journal, or a DuckDB migration. A fresh clone
still type-checks before its first build because `gen` emits empty lists with a
warning.
