# bandar

A self-hosted LLM gateway that ships as one binary. Clients speak OpenAI's chat
completions API; bandar resolves the model reference to a provider, translates
the request to that provider's wire, streams the answer back, and records one
analytics event per attempt in an embedded DuckDB database.

The dashboard covers providers, model tags, requests, API keys, and usage:
tokens, time to first token, tokens per second, error rate, p95 latency, daily
tokens, and a 30-day average. Provider credentials are sealed before they reach
SQLite.

## What works

- OpenAI-compatible `POST /v1/chat/completions`, streaming and non-streaming.
- OpenAI-compatible `GET /v1/models` for the caller's aliases, tags, and
  provider refs.
- Model references in three forms: an alias, `tags/<slug>`, or
  `<provider-slug>/<upstream-model>`.
- Tags as ordered fallback chains, managed in the dashboard.
- Several ordered credentials per provider, tried in priority order.
- Three generic wires for custom providers: `openai`, `anthropic`, and `google`.
- Five built-in providers on every account: Kilo Code, Token Harbor, Yeta, River,
  and Nous Portal. The last four speak the OpenAI wire; Kilo Code and Nous Portal
  also sign in with a device code.
- Custom providers added from the dashboard without changing code.
- Provider and model-alias management in the dashboard or over `/api`.
- Gateway keys from better-auth's API-key plugin, sent as
  `Authorization: Bearer <key>` or `x-api-key`.
- Per-request analytics in DuckDB with SQL migrations embedded in the binary.
- Email/password accounts and per-user data isolation.

Not in v1: tools, images, embeddings, and the responses API. Prices come only
from a catalog import. The adapter contract is text-only and says so.

## Quickstart

```sh
bun install          # fetches the DuckDB library and generates embedded modules
BANDAR_AUTH_URL=http://localhost:5173 bun run dev   # client :5173, API :3000
```

Open <http://localhost:5173>, create an account, then:

1. **Kilo Code**, **Token Harbor**, **Yeta**, **River**, and **Nous Portal** are
   already on the Providers page. Add an API key on the **Credentials** tab, or
   approve a device code on the **Connection** tab for Kilo Code and Nous Portal.
   Then **Import catalog** on the **Models** tab adds that provider's models, with
   prices when the provider publishes them.
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
├── resolve the reference into ordered attempts [1c] ✗ 404 model_not_found
│   └── one attempt per model and credential: tag order, then credential order [1c1]
├── pick the adapter for the provider kind [1d]
├── renew the attempt's OAuth credential when it is due [1d1]
├── call the upstream with the attempt's credential [1e] ✗ 502/429 and record the failure
│   └── normalize wire events into canonical text, usage and finish events [1e1]
├── try the next attempt when the failure is retryable [1e2]
├── stream OpenAI chunks back to the client [1f]
└── record one DuckDB event with tokens, TTFT, duration and tokens/sec [1g]
```

A credential is decrypted per attempt, immediately before an upstream call, so
it is in memory only for the length of that call and a tag never opens keys for
models it does not try. A due OAuth credential is renewed first: one renewal per
credential row in a process, shared by every request that reaches it at once,
written back with a compare-and-swap. A lost write adopts the stored bundle; a
refusal with no newer bundle is reported as `auth` so the chain falls through to
the next credential. `GET /api/providers` returns each
credential's id, label, auth mode, and priority, never the key or token. A
device-code login keeps the device code on the server: the browser sees only the
short user code it types at the provider's portal.

## Model references

A request's `model` field is a reference. Resolution is case-sensitive and tries
the forms in this order:

| Reference                          | Resolves to                                               |
| ---------------------------------- | --------------------------------------------------------- |
| An enabled alias, such as `fast`   | That one model.                                           |
| `tags/<slug>`                      | The tag's models, in priority order.                      |
| `<provider-slug>/<upstream-model>` | The enabled model of that provider with that upstream id. |

An exact alias always wins, so a reference that works today keeps working. A
provider slug is derived from the provider name once, when the provider is
created. Custom slugs are editable on the Settings tab; a built-in slug is fixed
in code (`kilo`). `tags` and every built-in slug are reserved, so a custom
provider named `Tags` gets `tags-2`.

The provider's model list shows each model's computed ref and marks a model
`shadowed` when an enabled alias equals its ref. A shadowed model still answers
through its alias, and `GET /v1/models` leaves the duplicate ref out. An alias
that existed before tags and starts with `tags/` keeps winning; new aliases
cannot start with that prefix.

## Tags

A tag is a named fallback chain. It holds an ordered list of models, and clients
call it as `tags/<slug>`. The gateway tries the models in priority order.

- The chain is retried only on `auth`, `rate_limit`, `unavailable`, `protocol`,
  and `network`. An `invalid_request` or an aborted request is final.
- There is no attempt cap. The chain is walked in full, so a long tag can mean
  several upstream calls for one client request.
- Each attempt writes one DuckDB event. A fallback therefore adds a row for the
  failed model beside the row for the model that answered.
- TTFT is measured from the request start and is not reset on a retry, so it
  spans the whole chain. A failed attempt records `ttft_ms = null`; duration is
  per attempt.
- A tag with no enabled models is a 404 `model_not_found` with the message
  `tag <slug> has no enabled models`.
- The overview counts attempts, so a fallback raises `requests` and the error
  rate by one. The requests panel shows both rows, including the reference that
  was called.

Manage tags on the **Tags** page or over `/api/tags`. Every membership write
replaces the whole list, so priorities are always 1-based and contiguous.

## Credentials

A provider holds an ordered list of credentials: several accounts or API keys for
the same upstream. The gateway calls with the first credential and falls back to
the next one when the failure is one a different key might fix. **Add credential**
opens a dialog with a **Single** tab, a **Bulk** tab that takes one key per line and
appends each in order, and, for a provider with a device login, an **OAuth** tab.

- Ordering is 1-based and contiguous per provider. Move a credential on the
  **Credentials** tab, and the write replaces the whole order.
- A fallback walks the current model's remaining credentials before it moves to
  the next model in a tag. A tag with two models that each hold two credentials
  can make four upstream calls for one client request.
- The retry set is the tag chain's: `auth`, `rate_limit`, `unavailable`,
  `protocol`, and `network`. An `invalid_request` or an aborted request is final.
- Each attempt writes one DuckDB event, so a key fallback adds a row beside the
  row for the key that answered.
- A provider with no credentials still takes one attempt with no credential
  header, which is how a local server that needs no key keeps working.
- Connecting Kilo Code adds a credential. A second Kilo account becomes the next
  entry in the chain instead of replacing the first. A pasted Kilo Code API key is
  another credential beside a device login, and the chain falls from one to the
  other like any other key.
- **Nous Portal** takes no API key. Its device login stores the inference token
  with the refresh token and expiry the portal returned, and the gateway renews
  that token 120 seconds before it expires. A renewal is shared by every request
  holding the same credential row, so a burst of traffic rotates once. If a
  renewal fails after another process wrote a fresh token, the request uses the
  stored one. A rejected or impossible renewal is an `auth` failure and the chain
  moves on; a credential saved before renewal existed has no refresh token and
  expires for good. Reconnecting replaces an expiring connection; a second, live
  connection joins the chain.

## Analytics

Each attempt writes one row to `request_events`, including failures and aborts.
The fields are denormalized, so deleting a provider does not erase its history.
The row carries the resolved alias and the string the client sent.

| Column      | Meaning                                                                                                     |
| ----------- | ----------------------------------------------------------------------------------------------------------- |
| `model`     | The resolved alias.                                                                                         |
| `reference` | The string the client sent as `model`, such as `fast`, `tags/failover`, or `fake-openai/fake-openai-model`. |

The dashboard derives these metrics:

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

The overview defaults to 30 days and can switch to 7 or 90. Recent attempts are
`GET /api/requests?limit=50`.

Filters narrow every number on the page: the summary, the daily series, and the
model breakdown. Filter by provider, account, model alias, or tag. Each filter
accepts several values, and the filters intersect.

`GET /api/analytics?days=30&providerKind=openai&model=fast` repeats one query
parameter per dimension.

| Parameter      | Matches                                      |
| -------------- | -------------------------------------------- |
| `providerKind` | The provider kind, such as `openai`.         |
| `providerId`   | One configured provider account.             |
| `model`        | The resolved alias, such as `fast`.          |
| `tag`          | A tag slug. The client called `tags/<slug>`. |

Repeat a parameter to match any of its values. The tag filter matches the
reference the client sent, so it counts the calls that used the tag and not the
calls that used an alias of a tagged model.

## Adding a provider

Adding a provider touches the shared kind lists, one provider directory, the
registry, and the dashboard. The definition object bundles the wire adapter with
every capability the provider has: a device login, a model catalog, and the
settings a built-in seeds. `GenericProviderDefinitions` and
`BuiltInProviderDefinitions` make the compiler reject a kind without a
definition, a definition whose `kind` disagrees with its key, and a built-in
without its `builtIn` settings.

1. Add the kind to `GENERIC_PROVIDER_KINDS` in `./src/shared/providers.ts` for a
   custom wire, or to `BUILT_IN_PROVIDER_KINDS` and `BUILT_IN_PROVIDERS` for a
   built-in.
2. Create `./src/server/providers/<kind>/index.ts` with the definition, annotated
   `GenericProviderDefinition<"<kind>">` or
   `BuiltInProviderDefinition<"<kind>">`. An OpenAI-compatible kind builds its
   adapter with `bearerAdapter("<kind>")`; a wire that needs its own headers
   builds one with `chatAdapter({ kind, label, headers })`, as Kilo Code does. Add
   an `oauth` connector, a `catalog` reader, or a `renew` renewer when the
   provider has one.
3. Register the definition in `./src/server/providers/registry.ts`.
4. Add the logo to `./src/client/components/provider-logo.tsx` and the label to
   `./src/shared/providers.ts`. The client's `Record<ProviderKind, ...>` tables
   fail until the new kind has both, and so does its base-URL placeholder.
5. Add a fake upstream route and the checks that prove the catalog, the chat
   call, and any login or renewal in `./scripts/smoke.ts`.

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
| `BANDAR_TOKENHARBOR_API`     | `https://tokenharbor.ai`                      | Token Harbor origin; the seeded base URL is this plus `/v1`.                               |
| `BANDAR_YETA_API`            | `https://platform.yeta.ai`                    | Yeta origin for chat, its model list, and `/api/pricing`.                                  |
| `BANDAR_RIVER_API`           | `https://api.river.ai`                        | River origin; the seeded base URL is this plus `/v1`.                                      |
| `BANDAR_RIVER_PRICING_URL`   | `https://console.river.ai/api/public/pricing` | River's public pricing JSON, which is also its model list.                                 |
| `BANDAR_NOUS_API`            | `https://inference-api.nousresearch.com`      | Nous inference origin; the seeded base URL is this plus `/v1`.                             |
| `BANDAR_NOUS_PORTAL`         | `https://portal.nousresearch.com`             | Nous Portal origin for the device login and token renewal.                                 |

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
| `bun run smoke`          | Boot `dist/bandar` and run 64 end-to-end checks against fake upstreams.          |
| `bun run verify`         | `check`, `test`, `build`, `smoke`.                                               |
| `bun run db:generate`    | Drizzle Kit migration from the SQLite schema.                                    |
| `bun run db:auth-schema` | Regenerate `src/server/db/auth-schema.ts`.                                       |
| `bun run duck:fetch`     | Copy the platform DuckDB library into `vendor/duckdb/`.                          |

The smoke run mints a user, creates one provider per generic wire against local
fake upstreams, checks the five seeded built-ins, imports every catalog (one with
an alias collision, one joined to a pricing table, one public), approves fake Kilo
Code and Nous Portal device logins, renews a Nous token under two concurrent
chats, calls the gateway streaming and non-streaming, walks a tag with a failing
first model, checks the recorded references, rejects reserved slugs, revokes the
key, restarts the binary, and proves the analytics rows survived.

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
│   ├── slugs.ts                    # slug rules, ref building, reserved names
│   ├── tags.ts                     # tag schemas and paths
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
│   ├── providers/
│   │   ├── index.ts                # provider/model repo, seeding, catalog import
│   │   ├── registry.ts             # definition record and built-in seed list
│   │   ├── types.ts                # adapter, catalog, OAuth, renewal contracts
│   │   ├── catalog.ts              # model ids, entries, price helpers
│   │   ├── http.ts                 # URL join, POST helpers, SSE parsing, errors
│   │   ├── env.ts                  # per-provider origin overrides
│   │   ├── refresh.ts              # renew a due OAuth credential, once per row
│   │   ├── openai/compatible.ts    # the OpenAI-compatible chat adapter
│   │   ├── anthropic/, google/
│   │   ├── kilocode/, tokenharbor/, yeta/, river/, nous/
│   │   └── *.test.ts
│   ├── credentials.ts              # ordered provider credentials: add, move, remove
│   ├── tags.ts                     # tag list and membership writes
│   ├── credential.ts               # api-key / oauth credential union
│   ├── seal.ts                     # AES-GCM credential sealing
│   ├── router/
│   │   ├── types.ts                # canonical request/result/stream contract
│   │   ├── metrics.ts              # tokens/sec, cost, error-rate math
│   │   ├── record.ts               # one request event -> DuckDB
│   │   ├── resolve.ts              # alias, tag, and provider-ref resolution
│   │   ├── chat.ts                 # resolve, walk candidates, stream, record
│   │   └── wire.ts                 # OpenAI response and error envelopes
│   ├── duck/
│   │   ├── ffi.ts                  # dlopen + symbol table
│   │   ├── client.ts               # prepared queries, typed binds
│   │   └── migrate.ts              # DuckDB ledger and statement splitter
│   ├── db/                         # drizzle schema, client, SQLite migrator
│   ├── auth.ts                     # better-auth handler, session, key verify
│   └── assets.ts                   # embedded client bundle and SPA fallback
├── src/client/
│   ├── router.tsx                  # /overview, /providers, /providers/:id, /tags, /requests, /api-keys
│   ├── views.tsx                   # navigation registry
│   ├── use-providers.ts            # provider and model mutations
│   ├── use-provider-detail.ts      # one provider with its usage window
│   ├── use-analytics.ts            # overview window state
│   ├── use-requests.ts             # recent request state
│   ├── use-tags.ts                 # tag list and membership writes
│   └── components/
│       ├── overview-panel.tsx      # stat cards, 30-day chart, model table
│       ├── providers-panel.tsx     # provider list and add dialog
│       ├── provider-page.tsx       # one provider: overview, settings, models, credentials
│       ├── credentials-card.tsx    # ordered credential list for one provider, with the add dialog
│       ├── credential-dialog.tsx   # add credential: single, bulk, and OAuth tabs
│       ├── tags-panel.tsx          # tag chains: create, reorder, remove
│       ├── connect-flow.tsx        # device-code approval for an OAuth provider
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

| Route                                                 | Auth                   | Purpose                                                 |
| ----------------------------------------------------- | ---------------------- | ------------------------------------------------------- |
| `POST /v1/chat/completions`                           | Gateway key            | OpenAI-compatible chat, streaming or not.               |
| `GET /v1/models`                                      | Gateway key            | Aliases, non-empty tags, and unshadowed provider refs.  |
| `GET/POST /api/providers`                             | Session or `x-api-key` | List providers, or add a custom provider.               |
| `PUT/DELETE /api/providers/:id`                       | Session or `x-api-key` | Edit a custom provider's settings, or remove it.        |
| `POST /api/providers/:id/credentials`                 | Session or `x-api-key` | Add a credential at the end of the provider's order.    |
| `POST /api/providers/:id/credentials/bulk`            | Session or `x-api-key` | Add up to 100 credentials at the end in one write.      |
| `PUT /api/providers/:id/credentials/order`            | Session or `x-api-key` | Replace the credential order; returns the provider.     |
| `DELETE /api/providers/:id/credentials/:credentialId` | Session or `x-api-key` | Remove a credential and compact the order.              |
| `GET /api/providers/:id?days=30`                      | Session or `x-api-key` | One provider plus its window usage.                     |
| `POST /api/providers/:id/models`                      | Session or `x-api-key` | Add one model alias; returns the provider.              |
| `POST /api/providers/:id/models/refresh`              | Session or `x-api-key` | Import new models from the provider's catalog.          |
| `DELETE /api/providers/:id/models/:modelId`           | Session or `x-api-key` | Remove a model alias; returns the provider.             |
| `POST /api/providers/:id/oauth/start`                 | Session or `x-api-key` | Start a device login; returns a user code.              |
| `POST /api/providers/:id/oauth/poll`                  | Session or `x-api-key` | Poll the pending login; stores the token when approved. |
| `GET/POST /api/tags`                                  | Session or `x-api-key` | List tags with their models, or create a tag.           |
| `PUT /api/tags/:id/models`                            | Session or `x-api-key` | Replace a tag's model list and order; returns the list. |
| `DELETE /api/tags/:id`                                | Session or `x-api-key` | Delete a tag; returns the remaining list.               |
| `GET /api/analytics?days=30&…`                        | Session or `x-api-key` | Window summary, daily series, model breakdown, filters. |
| `GET /api/requests?limit=50&providerId=…`             | Session or `x-api-key` | Recent attempts, optionally one provider.               |
| `GET /api/health`                                     | none                   | Both current migration tags.                            |
| `/api/auth/*`                                         | better-auth            | Sign-up, sign-in, sessions, key create/list/delete.     |

Each provider has its own page at `/providers/<id>` with four tabs:
**Overview** (usage for 7, 30, or 90 days plus recent requests), **Settings**
(name, slug, kind, base URL), **Models** (aliases, refs, tag chips, removal, and
a catalog import when the provider has one), and **Credentials** or
**Connection** (the ordered credential list: add, move, and remove a key, connect
an OAuth account, remove a custom provider). The tab lives in the URL as `?tab=`,
so a reload or a shared link opens the same tab. Custom providers are created
empty and grow models one at a time; the five built-ins are seeded empty for
every account. Built-in settings come from code and are read-only, and a built-in
cannot be removed. `PUT /api/providers/:id` replaces name, slug, kind, and base
URL for a custom provider. Credentials change only through the credential routes.
Changing a custom slug stops refs built from the old slug from resolving.

The **Tags** page creates a tag from a slug and edits its chain: reorder a model
with the arrow buttons, remove it, or pick another from the add list. Every edit
writes the whole list.

Model prices are accepted by the model endpoints (`inputPricePerMtok`,
`outputPricePerMtok`) and filled by a catalog import; they are not in the form
yet.

## Security notes

- Provider credentials, including OAuth tokens and refresh tokens, are sealed
  with AES-GCM under a key derived from `BANDAR_AUTH_SECRET`. Changing the secret
  makes stored credentials unreadable; the gateway returns an upstream error
  until they are re-entered.
- Credentials never appear in API responses, logs, or analytics events. The
  device code stays on the server; only the short user code is returned.
- A bad gateway key is final: it is a 401 and the session cookie is not consulted
  on `/v1`.
- One user cannot resolve another user's references, providers, events, or keys.
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
- **Ordering is the only fallback.** A tag walks its models in order, and each
  model walks its provider's credentials in order. An alias still maps to one
  model. There is no health check and no cool-down: a rate-limited key is tried
  again the next time it reaches the front of the chain.
- **OAuth refresh stops at Nous Portal.** Kilo Code stores its device token as
  issued; reconnect when it expires. Nous Portal rotates its token on the request
  path, from one process only. If the process dies after the portal rotates the
  token and before the row is written, the stored refresh token is spent; reconnect.
- **Yeta prices are the default group's.** The import uses the default group's
  ratios; `group_ratio` for another group is not applied.
- **A catalog re-import does not reprice.** It adds new upstream models and leaves
  prices on existing models alone.
- **A built-in can carry a suffixed slug.** If a custom provider already owns the
  reserved slug, the built-in keeps `<slug>-2` after the custom row is deleted.
- **No pricing form.** Set prices through the API or import a provider catalog;
  the overview computes cost only for priced models.

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
