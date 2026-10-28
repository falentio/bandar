# bandar vs 9router

A feature comparison of `bandar` (this repo) against `decolua/9router`, built from reading both codebases rather than either README.

|                   | bandar                         | 9router                                                  |
| ----------------- | ------------------------------ | -------------------------------------------------------- |
| Source            | `./src` at HEAD                | `decolua/9router` v0.5.112, `1fe586b` (2026-10-28)       |
| Language, stack   | TypeScript, Bun, Elysia, React | JavaScript, Node, Next.js 16                             |
| Size              | 22,715 TS lines (5,152 test)   | 170,131 JS lines, 417 test files                         |
| Provider capacity | 7 built-in + 3 generic wires   | 147 registry entries                                     |
| Tenancy           | multi-user                     | single-tenant                                            |
| Runtime           | one compiled binary (~181 MB)  | Node process or Docker                                   |
| Modalities        | chat text only                 | chat, embeddings, images, TTS, STT, video, search, fetch |

Both inventories below are cited to `path:line`. Every claim in this comparison I read in the source.

---

## The short version

These are not the same product with a feature delta. bandar is a gateway you can put a team behind and audit. 9router is a token-saving proxy for one developer's laptop that will go to extraordinary lengths to reach a free quota.

9router is about 7.5x the code and covers maybe 4x the surface. Most of that multiple is spent on one thing bandar deliberately refuses: pretending to be a browser to reach quota meters that were not built for third parties.

---

## Where bandar is ahead

**Multi-tenant, and this is the structural one.** bandar has a `users` table, every row carries `user_id` with a cascade FK, and every query in `./src/server/router/resolve.ts` (94, 109, 139) filters on it. 9router has no users table at all. It is one settings row pinned by `CHECK (id = 1)` (`src/lib/db/schema.js:28-33`), one bcrypt password, and a default of `"123456"` (`src/app/api/auth/login/route.js:58`). You cannot run 9router for a team. You can run bandar for one.

**Sealed credentials.** bandar encrypts provider credentials with AES-GCM keyed from `BANDAR_AUTH_SECRET` (`./src/server/seal.ts:1-19`). 9router stores `oidcClientSecret` and `samlCert` in plaintext inside the settings JSON (`src/lib/db/repos/settingsRepo.js:31-41`).

Per-key scoping exists in 9router and not in bandar, so credit where due, but bandar's multi-user boundary is the stronger primitive. A 9router allow-list is a policy on one global namespace. bandar's ownership split is a wall.

**A schema that refuses wrong shapes.** bandar's adapter contract is typed down to three stream event variants (`./src/server/providers/types.ts:34-37`). `definitionFor` is an exact-record mapped type, so an unregistered kind fails the build, not a request (`./src/server/providers/types.ts:172-180`). 9router's provider registry is 147 hand-maintained files with a JSDoc typedef and one required field, `category` (`open-sse/providers/schema.js:9-13`). Its executor map falls back silently to a default for anything unlisted (`open-sse/executors/index.js:94-98`). That is fast to extend and easy to get wrong.

**A real audit trail.** bandar writes one DuckDB row per attempt, failed attempts included, denormalized so deleting a provider keeps its history, and it keeps the client's original string as `reference` (`./src/server/router/record.ts:28-76`, `duckdb/0002_request_reference.sql:1`). p50 and p95 come from `approx_quantile` over `duration_ms` (`./src/server/analytics.ts:129-130`). 9router's `usageHistory` is one row per request with a JSON `meta` blob (`src/lib/db/schema.js:113-135`), and full request capture is off by default (`src/lib/db/repos/requestDetailsRepo.js:13-40`).

**Honest docs.** 9router's README claims "Auto-route: Subscription → Cheap → Free" (line 40). I grepped `open-sse/` and `src/`: there is no `tier` field, no subscription/cheap/free enum, no cost ordering. `category: "freeTier"` on 20 registry entries drives UI grouping only. The tier ladder is you ordering your own combo. The README also claims "Set spending limits per provider" (line 945); no such setting exists in `DEFAULT_SETTINGS`. bandar's README says what it does not have ("Not in this version: tools, images, and embeddings") and that is true (`./src/shared/chat.ts:9-18`).

---

## Where 9router is ahead, ranked by how much it costs bandar

**Tools and images. This is the gap that matters.** bandar's `ChatMessageSchema` requires `content: string` (`./src/shared/chat.ts:6`) and `CanonicalRequest` has no `tools` field. A non-text Anthropic block is a 422, not a drop (`./src/shared/messages.ts:97`). Every coding agent that would use a gateway sends tools. 9router threads `tools` through 31 touchpoints in the OpenAI translator alone (`open-sse/translator/formats/openai.js`) and dedupes them per model at `open-sse/handlers/chatCore.js:233`.

The comparison is not flattering: bandar is a chat gateway that cannot serve the clients gateways exist for.

**Provider breadth.** 7 built-ins plus 3 generic wires versus 147 registry entries. bandar's custom-provider path is real but narrow: you pick one of three wires, and a vendor with its own auth scheme needs a new `kind` in code (`./src/shared/providers.ts:9-17`). 9router's is a data file (`open-sse/providers/REGISTRY_TEMPLATE.js:1-12`).

**Fallback sophistication.** bandar's model is clean and I would not trade it: `RETRYABLE` set, final on `invalid_request`, cooldown `min(30s * 2^(failures-1), 24h)`, and the all-cooling probe exception that keeps a request alive when every subject is flagged (`./src/server/router/chat.ts:70-78`, `362-375`, `./src/server/health.ts:6-7`). 9router has four things bandar lacks:

| 9router capability                | Where                                                  | Why it is hard to match                                                                                                                                                                             |
| --------------------------------- | ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Two-question error classification | `open-sse/services/accountFallback.js:29-71`           | Separates "the credential is at fault" (cool the account) from "this member rejected the request" (advance the member, leave the account healthy). bandar flags a subject on every retryable error. |
| Empty-content success detection   | `open-sse/services/emptyFailover.js:1-14`              | Peeking the stream for real content because Gemini returns HTTP 200 with `MALFORMED_FUNCTION_CALL` and no text. bandar treats 2xx as success.                                                       |
| Combo strategies                  | `open-sse/services/combo.js:231-260, 372-448, 820-898` | round-robin, smart classifier routing with session stickiness, and fusion fan-out with a judge. bandar's tags are ordered-only.                                                                     |
| Sticky multi-account rotation     | `src/sse/services/auth.js:158-196`                     | Least-recently-used with a sticky count, under a mutex. bandar is strict priority order.                                                                                                            |

9router's two-question error split is the single idea I would copy first. Free. It rides on a field bandar already has in `UpstreamError`.

**Token savers.** RTK is on by default and compresses tool output before any format translation (`open-sse/rtk/index.js:30-118`), 12 filters, autodetected from content. bandar has nothing here, and given bandar has no tools either, RTK has nothing to compress. These are the same gap.

**Modalities.** 9router ships embeddings, images, TTS, STT, video, web search, and web fetch against 131 embedding models, 117 image models, 44 video, 44 TTS, 26 STT in the registry. bandar is text-in-text-out by contract. Whether this matters depends on whether bandar's consumer is coding agents or an app backend.

---

## Where 9router's lead is not a lead

A large share of 9router's 170K lines is effort I would not copy:

- 3,400 lines of MITM proxy with a generated root CA, platform cert installation, and DNS overrides (`src/mitm/`) to intercept 7 upstream hosts because IDEs ignore `baseURL`.
- Mirror browser automation and reverse-engineered web clients (`open-sse/executors/cursor.js` at 1,459 lines, `kiro.js` at 1,200, `deepseek-web.js` at 1,122).
- 34 UI locales, a 2,006-line single provider page, and a 40 KB AI prompt in `systemInject.js`.

The routing core proper, meaning combo, fallback, model resolution, and capabilities, is under 3,000 lines. bandar's equivalent is roughly 2,000. So on the part that is actually a gateway, the two codebases are the same size. The 7.5x is everything else.

---

## What I would do

Do not chase 9router's surface. Chase two things.

**Tools, first.** bandar cannot serve Claude Code, Cursor, or Codex without them, and that is the entire market for a self-hosted gateway right now. The change is a widening of `CanonicalMessage` from `content: string` to a block union, plus a `tools` field on `CanonicalRequest`, plus the `tool_calls` mapping the adapter already half-implements (`./src/server/providers/anthropic/adapter.ts:229-230`). Design it as the foundational type from day one rather than bolting a second content path on.

**The two-question error split, second.** It is a few dozen lines in `./src/server/health.ts` and it stops healthy credentials leaving rotation on a context-overflow 400.

Everything else I would skip. Multimodal, MITM, tunnels, proxy pools, cloud sync, and fusion routing are answers to 9router's specific product, which is "one developer, free quotas, resumable under active hostility from the provider." bandar's product is "a team's gateway that tells the truth about what happened." Those pull in opposite directions, and bandar's side of the split is the one nobody else is holding.

---

## Open decisions

1. Is bandar's consumer a coding agent or an app backend? Tools matter only for the first.
2. Does bandar want to ship free-quota providers? That is the entire reason 9router exists, and it brings the MITM-shaped work with it.
3. Should `apikey.permissions` (currently unread, `./src/server/db/auth-schema.ts:113`) become per-key model scoping? 9router proves the model works (`src/sse/services/keyAccess.js:1-24`). bandar already stores the column and ignores it.

---

---

# Appendix A: bandar feature inventory

Source: `/home/kevin/.t3/projects/bandar` at HEAD. Paths are repo-relative. Every claim carries a `path:line`; ranges are written `path:A-B`. Where a type or schema is cited, the cite is the line that declares the field or shape.

---

### 0. Shape in one paragraph

One binary serves three things on one port: the React dashboard, the `/api` control plane, and the `/v1` gateway. `src/server/app.ts:46-54` dispatches by path prefix: `/v1` to the gateway (`src/shared/api.ts:14-15`), `/api` to the control API (`src/shared/api.ts:11-12`), everything else to the embedded client bundle (`src/server/app.ts:51`). Both Elysia plugins are compiled before the first request because a later root plugin creation rebuilds the router and drops late routes (`src/server/app.ts:40-43`).

---

### 1. Request pipeline

### 1.1 Endpoints under `/v1`

Four routes in `src/server/gateway.ts`, mounted with prefix `/v1` (`src/server/gateway.ts:25`):

| Method + path                    | Handler                         | Shape                                                                                                                                       |
| -------------------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /v1/models`                 | `src/server/gateway.ts:40-60`   | OpenAI model list from `listModelRefs` (`src/server/gateway.ts:45`), `object: "list"`, `owned_by: "bandar"` (`src/server/gateway.ts:47-54`) |
| `POST /v1/chat/completions`      | `src/server/gateway.ts:61-96`   | OpenAI chat completions, parsed with `GatewayRequestSchema` (`src/server/gateway.ts:62`)                                                    |
| `POST /v1/messages`              | `src/server/gateway.ts:97-121`  | Anthropic Messages, parsed with `MessagesRequestSchema` (`src/server/gateway.ts:98`)                                                        |
| `POST /v1/messages/count_tokens` | `src/server/gateway.ts:122-141` | Estimate only: `ceil(chars / 4)` (`src/server/router/anthropic-wire.ts:5-9`, called at `src/server/gateway.ts:138`)                         |

`MESSAGES_PATH` is `/v1/messages` (`src/server/gateway.ts:18`) and drives error-envelope selection: the `onError` hook returns an Anthropic-shaped error on a messages path and an OpenAI-shaped one otherwise (`src/server/gateway.ts:26-38`). The match is a plain `startsWith` (`src/server/gateway.ts:27`), so `/v1/messages/count_tokens` also gets Anthropic envelopes, which is correct for that client.

### 1.2 Accepted request shapes

OpenAI side (`src/shared/chat.ts`):

- `model`: non-empty string, max `MAX_MODEL_REF_LENGTH` = 40 + 1 + 200 = 241 (`src/shared/chat.ts:10`, `src/shared/slugs.ts:9-11`).
- `messages`: array of `{role: "system"|"user"|"assistant", content: string}`, min length 1 (`src/shared/chat.ts:4-7`, `src/shared/chat.ts:11`).
- `stream` (default false), `temperature`, `top_p`, `max_tokens`, `max_completion_tokens`, `stop` (string or string[]) (`src/shared/chat.ts:12-17`).
- The pipe transform collapses `max_tokens ?? max_completion_tokens` into `maxTokens` and normalizes `stop` to an array (`src/shared/chat.ts:32-44`). Unknown top-level fields are not rejected; these valibot objects are not strict.

Anthropic side (`src/shared/messages.ts`):

- Message roles are only `user` and `assistant` (`src/shared/messages.ts:13`). Content is a string or an array of `{type, text?}` blocks (`src/shared/messages.ts:4-6`).
- `system`, `stream`, `max_tokens`, `temperature`, `top_p`, `stop_sequences` (`src/shared/messages.ts:19-24`).
- `normalizeMessages` folds every block to text and rejects any block whose `type !== "text"` with a 422 (`src/shared/messages.ts:97`, message built at `src/shared/messages.ts:111-112`). The rejection rule is stated in the source comment at `src/shared/messages.ts:50` ("every non-text block is a rejection rather than a drop") and enforced at `src/shared/messages.ts:97`.
- `canonicalRequestOf` prepends the system string as a system message, then appends each turn as its own text message (`src/server/gateway.ts:144-162`).

Key for both: `Authorization: Bearer <key>` or `x-api-key` (`src/server/gateway.ts:170-186`).

### 1.3 How a model string resolves

`resolvePlan` (`src/server/router/resolve.ts:82-148`) tries three shapes in order:

1. Alias. Exact match on `provider_models.alias` for the caller with `enabled = true`, inner-joined to `providers`, left-joined to `provider_credentials`, ordered by `credential.priority` (`src/server/router/resolve.ts:87-101`). Any non-empty result wins (`src/server/router/resolve.ts:101`).
2. Tag. Only when the ref starts with `tags/` (`src/server/router/resolve.ts:103`; prefix at `src/shared/slugs.ts:3`). Looks up `tags.slug` for the caller (`src/server/router/resolve.ts:106-114`), then reads `tag_models` ordered by `tag_models.priority` then `credential.priority` (`src/server/router/resolve.ts:116-123`). The plan records `tag: slug` (`src/server/router/resolve.ts:125`).
3. Provider ref `<providerSlug>/<upstreamModel>`. Split on the first `/`; index 0 or absent slash means no match (`src/server/router/resolve.ts:128-130`); then match `providers.slug` against the head and `provider_models.upstream_model` against the tail (`src/server/router/resolve.ts:132-147`).

The ref formats are `providerRefOf` and `tagRefOf` (`src/shared/slugs.ts:45-51`). An alias may not start with `tags/` (`src/shared/providers.ts:168-171`), which keeps the three namespaces disjoint at write time.

Each attempt row carries `providerFlaggedUntil`, `modelFlaggedUntil`, `credentialFlaggedUntil` (`src/server/router/resolve.ts:53-70`). A provider with no credential row still produces an attempt, with an empty key (`src/server/router/resolve.ts:72-79`).

`GET /v1/models` lists all three namespaces: aliases, then `tags/<slug>`, then `<slug>/<upstream>`, deduped by id and sorted (`src/server/router/resolve.ts:150-198`).

### 1.4 How a plan is built

`runChat` (`src/server/router/chat.ts:80-99`):

1. Choose the wire: `input.wire ?? openAiWire` (`src/server/router/chat.ts:81`).
2. Resolve the plan (`src/server/router/chat.ts:82`). Zero attempts is a 404, worded differently for an alias miss and an empty tag (`src/server/router/chat.ts:84-88`).
3. `attemptPlan` marks attempts suppressed (`src/server/router/chat.ts:94`, defined `src/server/router/chat.ts:353-421`). If every attempt has at least one cooling subject, `probe` becomes true (`src/server/router/chat.ts:362-375`) and suppression stops applying (`src/server/router/chat.ts:379-380`). That is the rule that a request never fails only because everything is flagged.
4. Non-stream goes to `complete`, stream goes to `streamResponse` (`src/server/router/chat.ts:96-98`).

The plan exposes `failed` and `succeeded`, which write health state (`src/server/router/chat.ts:381-419`), and a cooling set that grows as the loop runs (`src/server/router/chat.ts:411`).

### 1.5 How fallback walks

Non-streaming (`src/server/router/chat.ts:101-185`): iterate attempts, skip suppressed ones (`src/server/router/chat.ts:112-113`), call `route.adapter.chat` (`src/server/router/chat.ts:122-126`). On error, an aborted client request returns 400 at once (`src/server/router/chat.ts:161-163`). Otherwise mark the subject failed (`src/server/router/chat.ts:165`) and continue only when the error kind is in `RETRYABLE` (`src/server/router/chat.ts:167-171`). `RETRYABLE` is auth, rate_limit, not_found, unavailable, protocol, network, unknown (`src/server/router/chat.ts:70-78`); `invalid_request` is absent, so it is final. After the loop, the last failure is returned (`src/server/router/chat.ts:175-182`), else 502 "no upstream answered" (`src/server/router/chat.ts:184`).

Streaming (`src/server/router/chat.ts:197-351`): same loop with one extra rule. A retry is allowed only while nothing has reached the client: `if (writer.started || !RETRYABLE.has(...))` fails the stream instead (`src/server/router/chat.ts:319-323`). `started` is on the writer interface (`src/server/router/wire.ts:74-80`).

Credential order inside a provider is `provider_credentials.priority` ascending (`src/server/router/resolve.ts:99`, `src/server/router/resolve.ts:123`, `src/server/router/resolve.ts:145`), backed by a unique per-provider index (`src/server/db/schema.ts:55`). Reordering negates every rank first so the unique index holds mid-update (`src/server/credentials.ts:193-218`).

### 1.6 How streaming is produced

A `ReadableStream<Uint8Array>` with SSE headers `text/event-stream; charset=utf-8` (`src/server/router/chat.ts:209`, `src/server/router/chat.ts:344-350`). An inner `AbortController` mirrors the request signal (`src/server/router/chat.ts:199-202`) and `cancel()` aborts it (`src/server/router/chat.ts:337-341`). The adapter generator is drained through a switch over `text | usage | finish` with an exhaustiveness guard (`src/server/router/chat.ts:245-276`). TTFT is stamped on the first non-empty text event (`src/server/router/chat.ts:251-257`).

Upstream SSE is read by `sseData`, which handles CRLF, a trailing event with no blank line, and abort (`src/server/providers/http.ts:82-122`).

### 1.7 Where the response is translated

Translation is a `ChatWire` value chosen by the ingress route, not by the upstream provider (`src/server/router/wire.ts:94-99`):

- OpenAI: `openAiWire` (`src/server/router/wire.ts:101-105`). Non-stream body at `src/server/router/wire.ts:22-42`. Stream frames at `src/server/router/wire.ts:107-171`: role chunk, content deltas, finish chunk, a separate usage chunk, then `[DONE]`.
- Anthropic: `anthropicWire` (`src/server/router/anthropic-wire.ts:18-22`). Non-stream at `src/server/router/anthropic-wire.ts:26-40`. Stream emits `message_start`, `content_block_start`, `content_block_delta`, `content_block_stop`, `message_delta`, `message_stop` (`src/server/router/anthropic-wire.ts:42-125`). Stop-reason mapping at `src/server/router/anthropic-wire.ts:150-168`; error-type mapping at `src/server/router/anthropic-wire.ts:170-206`.

The gateway passes `wire: anthropicWire` only on `/v1/messages` (`src/server/gateway.ts:119`). `/v1/chat/completions` leaves it unset and gets OpenAI frames.

Upstream error to HTTP status: `statusFor` at `src/server/router/chat.ts:520-540` (rate_limit 429, invalid_request 400, not_found 404, everything else 502).

---

### 2. Provider model

### 2.1 Registry shape

Two kind sets and their union (`src/shared/providers.ts:6-19`):

- `GENERIC_PROVIDER_KINDS = ["openai", "anthropic", "google"]` (`src/shared/providers.ts:6`). Comment: "Generic wires are the kinds a user can add as a custom provider" (`src/shared/providers.ts:5`).
- `BUILT_IN_PROVIDER_KINDS` = kilocode, tokenharbor, yeta, river, nous, hyper, opencode (`src/shared/providers.ts:9-17`). Comment: "Built-in providers come from code, exist for every account, and are not added by hand" (`src/shared/providers.ts:8`).
- `ProviderKind` is the union (`src/shared/providers.ts:19`), schema at `src/shared/providers.ts:92`.

A compat is the wire a model answers on, independent of the kind that reaches it: `COMPATIBILITIES = ["chat", "responses", "messages", "genai"]` (`src/shared/providers.ts:26`).

The registry is two object literals merged into one record (`src/server/providers/registry.ts:25-44`), typed so a missing kind is a type error:

- `GenericProviderDefinitions` and `BuiltInProviderDefinitions` are exact-record mapped types over the kind unions (`src/server/providers/types.ts:172-178`).
- `ProviderDefinitionRecord` is their intersection (`src/server/providers/types.ts:180`).
- `definitionFor(kind)` is the lookup (`src/server/providers/registry.ts:46-48`).
- `compatsOf(kind)` filters `COMPATIBILITIES` by declared routes (`src/server/providers/registry.ts:50-54`).
- `builtInProviders` maps kinds to definitions (`src/server/providers/registry.ts:56-58`); `reservedProviderSlugs` is `tags` plus every built-in slug (`src/server/providers/registry.ts:60-63`).

Each definition carries `routes`, `defaultCompat(upstreamModel)`, `authModes`, and optional `oauth`, `catalog`, `renew` (`src/server/providers/types.ts:145-152`). Generic definitions add `builtIn?: undefined` (`src/server/providers/types.ts:158-162`); built-in definitions add `builtIn: {name, slug, baseUrl()}` (`src/server/providers/types.ts:164-168`, settings shape at `src/server/providers/types.ts:125-129`).

### 2.2 The exact built-in list

Bases are declared in `BUILT_IN_PROVIDERS` (`src/shared/providers.ts:39-90`); each `index.ts` wraps them in `apiBaseUrl(envName, fallback, mount)`, which swaps in an env-pinned origin when the variable is set (`src/server/providers/env.ts:2-6`). Env names are validated in config (`src/server/config.ts:69-78`).

| Kind        | slug          | default base                                                                  | wires                                                      | auth modes                                                    | oauth                                             | catalog                                                                                                 | renew                                         |
| ----------- | ------------- | ----------------------------------------------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| kilocode    | `kilo`        | `https://api.kilo.ai/api/openrouter` (`src/shared/providers.ts:40-45`)        | chat (`src/server/providers/kilocode/index.ts:20`)         | api-key + oauth (`src/server/providers/kilocode/index.ts:14`) | yes (`src/server/providers/kilocode/index.ts:22`) | yes (`src/server/providers/kilocode/index.ts:23`)                                                       | no                                            |
| tokenharbor | `tokenharbor` | `https://tokenharbor.ai/v1` (`src/shared/providers.ts:46-51`)                 | chat (`src/server/providers/tokenharbor/index.ts:22`)      | api-key (`src/server/providers/tokenharbor/index.ts:16`)      | no                                                | yes (`src/server/providers/tokenharbor/index.ts:24`)                                                    | no                                            |
| yeta        | `yeta`        | `https://platform.yeta.ai/v1` (`src/shared/providers.ts:52-57`)               | chat (`src/server/providers/yeta/index.ts:23`)             | api-key (`src/server/providers/yeta/index.ts:17`)             | no                                                | yes, with pricing (`src/server/providers/yeta/index.ts:25`, `src/server/providers/yeta/index.ts:28-34`) | no                                            |
| river       | `river`       | `https://api.river.ai/v1` (`src/shared/providers.ts:58-63`)                   | chat (`src/server/providers/river/index.ts:17`)            | api-key (`src/server/providers/river/index.ts:11`)            | no                                                | yes (`src/server/providers/river/index.ts:19`)                                                          | no                                            |
| nous        | `nous`        | `https://inference-api.nousresearch.com/v1` (`src/shared/providers.ts:64-69`) | chat (`src/server/providers/nous/index.ts:20`)             | oauth only (`src/server/providers/nous/index.ts:14`)          | yes (`src/server/providers/nous/index.ts:22`)     | yes (`src/server/providers/nous/index.ts:23`)                                                           | yes (`src/server/providers/nous/index.ts:24`) |
| hyper       | `hyper`       | `https://hyper.charm.land/v1` (`src/shared/providers.ts:70-75`)               | chat (`src/server/providers/hyper/index.ts:17`)            | api-key (`src/server/providers/hyper/index.ts:11`)            | no                                                | yes (`src/server/providers/hyper/index.ts:19`)                                                          | no                                            |
| opencode    | `opencode`    | `https://opencode.ai/inference` (`src/shared/providers.ts:76-81`)             | all four (`src/server/providers/opencode/compat.ts:18-51`) | api-key (`src/server/providers/opencode/index.ts:11`)         | no                                                | yes (`src/server/providers/opencode/index.ts:19`)                                                       | no                                            |

Opencode is the only built-in with more than one wire, and it picks per model. Mounts: `/go/openai/v1` for chat and responses, `/go/anthropic/v1` for messages, `/go/google/v1beta` for genai (`src/server/providers/opencode/compat.ts:10-16`). Its `defaultCompat` returns a `CompatChoice` that can be a refusal with a reason (`src/server/providers/opencode/compat.ts:53-63`, refusal at `src/server/providers/opencode/compat.ts:60`).

Generic wires, all using `always(...)` (`src/server/providers/types.ts:154-156`):

- `anthropic`: only `messages`, header `x-api-key` (`src/server/providers/anthropic/index.ts:7-17`).
- `openai`: `chat` and `responses`, bearer on both (`src/server/providers/openai/index.ts:8-15`).
- `google`: only `genai`, header `x-goog-api-key` (`src/server/providers/google/index.ts:7-17`).

### 2.3 Defined vs configured

Defined in code: one `ProviderDefinition` per kind (`src/server/providers/types.ts:170`), statically imported by the registry (`src/server/providers/registry.ts:8-17`). Nothing is discovered at runtime.

Configured in the database: one `providers` row per account per kind, with `origin` = `builtin` or `custom` (`src/server/db/schema.ts:26`). Built-in rows are seeded on demand, not at boot. `ensureBuiltInProviders` inserts any missing built-in with `origin: "builtin"` and the base URL from code (`src/server/providers/seeding.ts:8-48`), called from `listProviders` (`src/server/providers/index.ts:50`) and `createProvider` (`src/server/providers/index.ts:172`).

The split is enforced in three places. Editing a built-in row's name, kind, base URL, or slug throws "built-in provider settings come from the code" (`src/server/providers/index.ts:226-234`). Deleting a built-in is refused at the API (`src/server/api.ts:577-581`). A custom row cannot use a built-in kind (`src/server/providers/index.ts:236-238`), and a slug that collides with a reserved one is refused (`src/server/providers/index.ts:246-252`).

Per-model override lives on `provider_models.compat`, nullable (`src/server/db/schema.ts:71`). Setting it is validated against the kind's declared wires (`src/server/providers/index.ts:380-382`).

Routing: the override wins, then `defaultCompat`, and a null choice or an undeclared wire throws `invalid_request` (`src/server/providers/route.ts:11-33`). A route `mount` is joined onto the base URL (`src/server/providers/route.ts:35-42`).

### 2.4 Can third-party providers be added without code?

Partly. A custom provider is created from the dashboard with a name, a `kind` from the three generic wires, and a base URL (`src/shared/providers.ts:191-196`; dialog at `src/client/components/providers-panel.tsx:228-330`). It gets exactly the wires its kind declares and cannot declare new ones.

A new vendor with its own auth scheme, catalog, or wire needs a new kind: `src/server/providers/<kind>/index.ts`, a line in the registry (`src/server/providers/registry.ts:25-39`), and a kind in `BUILT_IN_PROVIDER_KINDS` (`src/shared/providers.ts:9-17`). So custom upstreams yes, new provider kinds no.

`definitionFor` is a bare object index (`src/server/providers/registry.ts:46-48`) with no runtime fallback, so an unregistered kind is `undefined` despite the return type.

### 2.5 Probe and refresh

Probe (`src/server/providers/probe.ts`): one real request against one saved credential, `ping` with `maxTokens: 1` (`src/server/providers/probe.ts:11`). With no models it falls back to a catalog read when the kind has one (`src/server/providers/probe.ts:66-74`). It runs outside the gateway: no analytics row and no cooldown flag (`src/server/providers/probe.ts:19-23`). Result is `{ok, status, latencyMs, error}` (`src/shared/providers.ts:228-233`).

Refresh (`POST /api/providers/:id/models/refresh`, `src/server/api.ts:505-546`): calls the kind's `catalog` with a lazy credential getter (`src/server/api.ts:527-531`), then `syncProviderModels` inserts only models whose alias and upstream are both new, skipping `tags/` aliases (`src/server/providers/index.ts:324-346`). Response `{added, skipped}` (`src/server/api.ts:542-545`). A kind with no catalog gets a 400 (`src/server/api.ts:521-525`).

Catalog helpers: `readModelIds` requires a credential (`src/server/providers/catalog.ts:15-29`), `readPublicModelIds` never reads one (`src/server/providers/catalog.ts:31-39`), `entryOf` defaults alias to the upstream id (`src/server/providers/catalog.ts:74-76`), and per-token prices are multiplied by 1e6 (`src/server/providers/catalog.ts:78-87`).

Renewal runs before the request that needs it. `freshCredential` renews only oauth credentials that are due (`src/server/providers/refresh.ts:16-40`), dedupes concurrent renewals per credential row (`src/server/providers/refresh.ts:13`, `src/server/providers/refresh.ts:29-31`), and writes with a compare-and-swap on the sealed value so a losing racer reads the winner's bundle rather than overwriting it (`src/server/providers/refresh.ts:77-97`).

---

### 3. Data and persistence

Two databases. SQLite through Drizzle holds configuration; DuckDB holds analytics. Both migrate through embedded SQL strings with a checksum ledger.

### 3.1 SQLite tables

From `src/server/db/schema.ts`:

| Table                                                    | Columns                                                                                                                                                                                                       | Constraints                                                                                                                                                                                        |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `providers` (`src/server/db/schema.ts:15-37`)            | id, user_id, name, slug (default `''`), kind, base_url, origin (default `custom`), failures (default 0), flagged_until, created_at                                                                            | unique (user_id, name) at `src/server/db/schema.ts:32`; partial unique (user_id, slug) where slug `<> ''` at `src/server/db/schema.ts:33-35`; FK to user, cascade, at `src/server/db/schema.ts:21` |
| `provider_credentials` (`src/server/db/schema.ts:39-57`) | id, provider_id, label, credential (sealed), auth_mode (default `api-key`), priority, failures, flagged_until, created_at                                                                                     | unique (provider_id, priority) at `src/server/db/schema.ts:55`; FK cascade at `src/server/db/schema.ts:45`                                                                                         |
| `provider_models` (`src/server/db/schema.ts:59-83`)      | id, user_id, provider_id, alias, upstream_model, compat (nullable), input_price_per_mtok (real), output_price_per_mtok (real), enabled (default true), failures, flagged_until, created_at                    | unique (user_id, alias) at `src/server/db/schema.ts:80`; unique (provider_id, upstream_model) at `src/server/db/schema.ts:81`                                                                      |
| `tags` (`src/server/db/schema.ts:85-96`)                 | id, user_id, slug, created_at                                                                                                                                                                                 | unique (user_id, slug) at `src/server/db/schema.ts:95`                                                                                                                                             |
| `tag_models` (`src/server/db/schema.ts:98-114`)          | tag_id, model_id, priority                                                                                                                                                                                    | PK (tag_id, model_id) at `src/server/db/schema.ts:110`; unique (tag_id, priority) at `src/server/db/schema.ts:111`; index on model_id at `src/server/db/schema.ts:112`                             |
| `cooldown_events` (`src/server/db/schema.ts:116-140`)    | id, user_id, subject, subject_name, provider_id, provider_name, model_id, model_alias, credential_id, credential_name, error_kind, error_message, reference, failures, cooldown_ms, flagged_until, created_at | index (user_id, created_at) at `src/server/db/schema.ts:139`                                                                                                                                       |

Auth tables from `src/server/db/auth-schema.ts`: `user` (`src/server/db/auth-schema.ts:4-17`), `session` (`src/server/db/auth-schema.ts:19-38`), `account` (`src/server/db/auth-schema.ts:40-68`), `verification` (`src/server/db/auth-schema.ts:70-86`), `apikey` (`src/server/db/auth-schema.ts:88-121`). `apikey` carries a `permissions` column (`src/server/db/auth-schema.ts:113`) that nothing in this repo reads.

SQLite migrations: 12 files under `drizzle/` (0000_init through 0011_petite_leopardon), embedded as strings in `src/server/generated/migrations.ts`. `applyMigrations` creates the ledger `_bandar_migrations` (`src/server/db/migrate.ts:24`, `src/server/db/migrate.ts:32-34`), applies each unapplied tag in a transaction (`src/server/db/migrate.ts:47-64`), and refuses to run when the DB has a tag this binary does not embed (downgrade, `src/server/db/migrate.ts:80-86`) or when an applied migration's body changed (drift, `src/server/db/migrate.ts:88-99`). The checksum is CRC32 (`src/server/db/migrate.ts:102-104`).

### 3.2 DuckDB, and what one analytics row holds

The table is `request_events` (`duckdb/0001_analytics.sql:1-21`), plus a `reference` column from the second migration (`duckdb/0002_request_reference.sql:1`). Index on (user_id, started_at) at `duckdb/0001_analytics.sql:23-24`.

Columns: id (PK), user_id, api_key_id, provider_id, provider_kind, model, upstream_model, status, http_status, error_kind, streamed, input_tokens, output_tokens, total_tokens, cost_usd, ttft_ms, duration_ms, tokens_per_second, started_at (`duckdb/0001_analytics.sql:1-21`), reference (`duckdb/0002_request_reference.sql:1`).

One row per attempt, failed attempts included, written by `recordRequest` (`src/server/router/record.ts:28-76`). Derived at write time: `tokens_per_second` (`src/server/router/record.ts:29-33`), `cost_usd` (`src/server/router/record.ts:35-40`), `total_tokens` (`src/server/router/record.ts:42-45`). `status` is `success | error | aborted` (`src/server/router/record.ts:5`).

The row is denormalized on purpose: it stores the resolved alias as `model`, the upstream model, the provider kind, and the string the client sent as `reference` (`src/server/router/chat.ts:474-493`). Deleting a provider therefore keeps its history. A failed insert is logged, not thrown (`src/server/router/chat.ts:495-512`).

DuckDB migrations use the same ledger pattern (`_bandar_duck_migrations`, `src/server/duck/migrate.ts:24`, `src/server/duck/migrate.ts:30-32`), a statement splitter that respects quotes and `--` comments (`src/server/duck/migrate.ts:79-138`), and the same drift and downgrade refusals (`src/server/duck/migrate.ts:140-165`).

Reads. `readAnalytics` returns a summary (requests, errors, tokens, avg TPS, avg TTFT, p50/p95 from `approx_quantile`, cost), a daily series built from `generate_series` left-joined so empty days survive, and the top 20 models by token volume (`src/server/analytics.ts:113-214`; filter-placement note at `src/server/analytics.ts:144`). `readRequests` returns the last N events, optionally scoped to one provider (`src/server/analytics.ts:216-256`). `readProviderUsage` returns one provider's totals plus `last_request_at` (`src/server/analytics.ts:258-299`).

Filters are four dimensions: providerKind, providerId, model, tag, mapped to columns at `src/server/analytics.ts:106-111`. A tag filter is matched against the stored `tags/<slug>` reference (`src/server/analytics.ts:313-314`).

### 3.3 The cooldown model

Three subject kinds: provider, model, credential (`src/server/health.ts:11-14`, mirrored at `src/shared/cooldowns.ts:3`).

Which error flags which subject (`src/server/health.ts:51-82`):

- `auth` and `rate_limit` to the credential, or nothing when the attempt has none.
- `not_found` and `protocol` to the model.
- `unavailable` and `network` to the provider.
- `invalid_request` and `unknown` to nothing.

Duration is `min(30s * 2^(failures - 1), 24h)` (`src/server/health.ts:6-7`, `src/server/health.ts:41-45`). A success clears failures and the flag on all three subjects of that attempt (`src/server/health.ts:174-210`; subject list at `src/server/router/chat.ts:423-433`).

Each failure writes a `cooldown_events` row inside the same transaction that bumps the subject (`src/server/health.ts:91-130`), truncates the message at 500 chars (`src/server/health.ts:9`, `src/server/health.ts:133-135`), and prunes history to the newest 500 rows per user (`src/server/health.ts:8`, `src/server/health.ts:120-129`).

Request-time suppression and the all-cooling probe exception are in section 1.4.

### 3.4 How credentials are sealed

AES-GCM with a 12-byte IV, keyed by SHA-256 of `bandar/provider-key/v1:<secret>`; output is `v1.<base64url iv>.<base64url ciphertext>` (`src/server/seal.ts:1-4`, `src/server/seal.ts:10-19`, `src/server/seal.ts:31`). A failed decrypt names the likely cause: the secret changed (`src/server/seal.ts:48-52`).

The secret is `BANDAR_AUTH_SECRET`, or a random 32-byte hex per boot when unset, which ends sessions on restart and makes previously sealed keys unreadable (`src/server/config.ts:111-115`, `src/server/config.ts:124`).

The plaintext is a tagged union: `{authMode:"api-key", apiKey}` or `{authMode:"oauth", accessToken, organizationId, refreshToken?, expiresAt?}` (`src/server/credential.ts:3-13`). A bare pre-tagging key is read as an api-key (`src/server/providers/index.ts:437-446`). Renewal is due inside a 120 s window before expiry (`src/server/credential.ts:17-18`).

---

### 4. Auth and keys

### 4.1 Single-user or multi-user

Multi-user, no roles. Every user-owned table carries `user_id` with a cascade FK (`src/server/db/schema.ts:19-21`, `src/server/db/schema.ts:63-65`, `src/server/db/schema.ts:89-91`, `src/server/db/schema.ts:120-122`), and every query filters on it (`src/server/providers/index.ts:55`, `src/server/providers/index.ts:61`, `src/server/router/resolve.ts:94`, `src/server/router/resolve.ts:109`, `src/server/router/resolve.ts:139`, `src/server/analytics.ts:133`, `src/server/tags.ts:139`).

Anyone can register. better-auth runs with `emailAndPassword: { enabled: true }` (`src/server/auth.ts:21`) and the client exposes a sign-up mode (`src/client/components/login-form.tsx:9`, `src/client/components/login-form.tsx:47`). I found no invite list, email allowlist, or approval step.

No roles. The only permission-shaped column is `apikey.permissions` (`src/server/db/auth-schema.ts:113`) and the plugin is configured without permissions (`src/server/auth-plugins.ts:9-15`). A user's reach is the full surface of their own rows.

### 4.2 Two credential types, one guard each

- Dashboard session: a better-auth cookie. `authenticate` falls back to `getSession` when no `x-api-key` header is present (`src/server/api.ts:722-741`).
- API key header `x-api-key` (`src/shared/api-keys.ts:4`). A present-but-wrong key is a hard 401 with no cookie fallback, deliberately: "falling back to the cookie would hide a wrong key behind a live session" (`src/server/api.ts:725-733`).

The gateway accepts keys only, never cookies. `callerOf` returns null when no key is sent (`src/server/gateway.ts:164-168`), and the key may arrive as `Authorization: Bearer` or as `x-api-key` (`src/server/gateway.ts:170-186`).

`/api/health` is unauthenticated (`src/server/api.ts:124`). Every other `/api` route except `/auth/*` calls `authenticate` before its handler.

### 4.3 Key format, limits, scope

Prefix `bandar_` (`src/server/auth-plugins.ts:3`), 11 visible starting characters (`src/server/auth-plugins.ts:12`), rate limit 1000 requests per 3,600,000 ms (`src/server/auth-plugins.ts:5`, `src/server/auth-plugins.ts:13`). The `apikey` row mirrors those defaults (`src/server/db/auth-schema.ts:102-107`).

`enableSessionForAPIKeys` stays off on purpose, so a key cannot mint more keys through `/api/auth/*` (`src/server/auth-plugins.ts:7-8`).

Scope is ownership only. A key resolves to a user (`referenceId` becomes `userId`, `src/server/auth.ts:31-37`) and can call every model that user configured. The UI says so outright: "Keys are shown once and can call every model you configure" (`src/client/components/api-keys-panel.tsx:27-29`).

Key CRUD is better-auth's own route set, proxied wholesale by `.all("/auth/*")` (`src/server/api.ts:123`), with client paths at `src/shared/api-keys.ts:8-12`.

Validation. `parseInput` throws `InputError` carrying flattened `path: message` issues (`src/server/validation.ts:22-36`), which the API error hook maps to 422 (`src/server/api.ts:99-103`). API keys cap at 500 chars, bulk at 100 keys, deduped (`src/shared/providers.ts:185-217`).

The gateway validates with `v.safeParse` and returns the first issue message as a 422 in the ingress dialect (`src/server/gateway.ts:62-72`, `src/server/gateway.ts:98-101`).

---

### 5. Client surface

Routes (`src/client/router.tsx`) and nav (`src/client/views.tsx:10-17`):

| Path                     | Component                                               | Feature                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------ | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/`                      | redirect to `/overview` (`src/client/router.tsx:42-48`) | none                                                                                                                                                                                                                                                                                                                                                    |
| `/login`                 | `AuthPage` (`src/client/router.tsx:50-59`)              | sign in and sign up, with a validated `?redirect=` target (`src/client/router.tsx:24-29`)                                                                                                                                                                                                                                                               |
| `/overview`              | `OverviewPanel` (`src/client/router.tsx:67-71`)         | 7/30/90-day switch, filter bar, stat row (requests, tokens, avg speed, avg TTFT, avg/day, error rate, p95, cost), token chart (`src/client/components/overview-panel.tsx:17`, `src/client/components/overview-panel.tsx:68-88`)                                                                                                                         |
| `/providers`             | `ProvidersPanel` (`src/client/router.tsx:73-77`)        | provider list plus an "Add custom provider" dialog with name, kind, base URL, and an optional key (`src/client/components/providers-panel.tsx:228-330`)                                                                                                                                                                                                 |
| `/providers/$providerId` | `ProviderPage` (`src/client/router.tsx:83-92`)          | four tabs, overview / settings / models / credentials (`src/client/components/provider-page.tsx:54`, `src/client/components/provider-page.tsx:176-202`). Overview is usage plus that provider's requests (`src/client/components/provider-page.tsx:205-208`). The credentials tab is named by auth mode (`src/client/components/provider-page.tsx:195`) |
| `/tags`                  | `TagsPanel` (`src/client/router.tsx:106-110`)           | create a tag by slug, assign models in priority order (`src/client/components/tags-panel.tsx:41`, `src/client/components/tags-panel.tsx:71`)                                                                                                                                                                                                            |
| `/requests`              | `RequestsPanel` (`src/client/router.tsx:94-98`)         | per-request table: when, model, status, in, out, TTFT, speed, cost (`src/client/components/requests-panel.tsx:42-49`)                                                                                                                                                                                                                                   |
| `/errors`                | `ErrorsPanel` (`src/client/router.tsx:100-104`)         | cooldown history, newest 100 (`src/client/components/errors-panel.tsx:8`, `src/client/components/errors-panel.tsx:30-53`)                                                                                                                                                                                                                               |
| `/api-keys`              | `ApiKeysPanel` (`src/client/router.tsx:112-116`)        | create, name, list, reveal once, revoke keys (`src/client/components/api-keys-panel.tsx:8-56`)                                                                                                                                                                                                                                                          |

Supporting UI. `credential-dialog.tsx` adds a key or starts a device login. `connect-flow.tsx` runs the device login: approve a code at the provider's verification URL (`src/client/components/connect-flow.tsx:115`, `src/client/components/connect-flow.tsx:149-159`). `credentials-card.tsx` shows the priority rank and a per-credential Test button (`src/client/components/credentials-card.tsx:108`, `src/client/components/credentials-card.tsx:125`).

Auth gating is client-side. An unauthenticated user hits `AppLayout`, which redirects to `/login` with the current path as `redirect` (`src/client/router.tsx:170-185`). The server enforces the same rule independently on `/api`.

---

### 6. Explicitly absent

The adapter contract is a text-only chat contract, by construction.

From `src/server/providers/types.ts`:

- `CanonicalMessage.content` is `string` (`src/server/providers/types.ts:10-13`).
- `CanonicalRequest` carries only messages, temperature, topP, maxTokens, stop (`src/server/providers/types.ts:15-21`). No `tools`, `tool_choice`, `response_format`, `modalities`, `reasoning`, or `seed`.
- `CanonicalResult` is text, finishReason, usage (`src/server/providers/types.ts:28-32`).
- `CanonicalStreamEvent` has exactly three variants: text, usage, finish (`src/server/providers/types.ts:34-37`).
- The adapter interface is `chat` and `stream` only (`src/server/providers/types.ts:53-57`). No embed, transcribe, speak, or image method.

From `src/shared/chat.ts`: the OpenAI request schema is model, messages, stream, temperature, top_p, max_tokens, max_completion_tokens, stop (`src/shared/chat.ts:9-18`). Roles are system, user, assistant (`src/shared/chat.ts:5`); no tool or function role.

Grep over `src/`, with results:

| Capability             | Result                                                                                                                                                 | Evidence                                                                                           |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| Embeddings             | zero matches for `embedding`                                                                                                                           | no hits                                                                                            |
| TTS / audio            | zero matches for `tts`, `text-to-speech`, `speech`, `audio`                                                                                            | no hits                                                                                            |
| STT / transcription    | zero matches for `transcri`, `whisper`, `stt` (the `latestTagUrl` hits are the CLI updater)                                                            | `src/server/cli/update.ts:191`                                                                     |
| Images / vision        | no matches in server or provider code, except a Yeta pricing test fixture using the literal `"image"` as a model name, and the static-asset MIME table | `src/server/providers/yeta/pricing.test.ts:14`, `src/server/assets.ts:6-20`                        |
| Video                  | no matches outside an unrelated test helper name                                                                                                       | `src/server/cli/update.test.ts:106`                                                                |
| Web search / grounding | zero matches for `web_search`, `search_grounding`, `google_search`                                                                                     | no hits                                                                                            |
| Tool calling           | `tool_calls` appears only in finish-reason string mapping, never as a request field or a streamed payload                                              | `src/server/providers/anthropic/adapter.ts:229-230`, `src/server/router/anthropic-wire.ts:157-159` |

Two consequences worth naming.

A non-text block is rejected, never dropped. An Anthropic request whose content includes an image block gets a 422 naming the block path and type (`src/shared/messages.ts:97`, `src/shared/messages.ts:111-112`). An OpenAI request with image content fails at the message schema, which requires `content: string` (`src/shared/chat.ts:6`).

Models are filtered upstream too. The Nous catalog drops any model whose `output_modalities` does not include `"text"` (`src/server/providers/nous/catalog.ts:43`), so image-output models never enter the list from that provider.

The Responses adapter also declares text-only input: `content: { type: "input_text"; text: string }[]` (`src/server/providers/openai/responses.ts:52-55`). The README states the same scope: "Not in this version: tools, images, and embeddings. The adapter contract is text only." (`README.md:50`).

---

### 7. Where I am unsure

- Migration bodies. I read the schema in `src/server/db/schema.ts` and both DuckDB SQL files, but not the twelve `drizzle/*.sql` bodies. A column present only in a migration and not in the current schema file would not appear here. Drizzle's schema file is the source of truth, so this should be complete, but I did not cross-check `drizzle/meta/`.
- `/api/auth/*` sub-routes. The API proxies them wholesale (`src/server/api.ts:123`), so better-auth's own route set is live and not enumerated in this repo. The client names four auth paths and three key paths (`src/shared/auth.ts:4-9`, `src/shared/api-keys.ts:8-12`); anything else the installed better-auth version exposes is reachable.
- Whether the better-auth api-key rate limit fires outside `/api/auth/*`. The plugin sets 1000/hour (`src/server/auth-plugins.ts:5`) and the gateway calls `auth.verifyApiKey` (`src/server/auth.ts:31-37`). I did not read the `@better-auth/api-key` package to see whether it enforces that limit on verify calls, and I found no other limiter in `src/server/gateway.ts`.
- `approx_quantile` precision. p50 and p95 come from `approx_quantile(duration_ms, 0.5|0.95)` (`src/server/analytics.ts:129-130`); DuckDB's error bound is not characterized anywhere in the repo.

---

# Appendix B: 9router feature inventory

Repo: `decolua/9router` v0.5.112, HEAD `1fe586b` (2026-10-28). Paths are repo-relative to that checkout. Line numbers are from that commit.

---

### 0. Size, before anything else

| Area                                                | Files              | Lines  |
| --------------------------------------------------- | ------------------ | ------ |
| `open-sse/` (routing core, plain ESM, no framework) | 492 JS             | 77,448 |
| `src/` (Next.js app: dashboard, API routes, glue)   | 568 JS/JSX         | 92,683 |
| `tests/`                                            | 417 test files     | n/a    |
| `src/app/api/**/route.js`                           | 174 routes         | n/a    |
| `src/app/(dashboard)/**/page.js`                    | 23 pages           | n/a    |
| `open-sse/providers/registry/`                      | 147 provider files | n/a    |
| `cli/`                                              | 29 JS              | n/a    |

Largest files (`find -name '*.js' | xargs wc -l | sort -rn`):

- `open-sse/executors/cursor.js` 1459
- `open-sse/executors/kiro.js` 1200
- `open-sse/utils/cursorProtobuf.js` 1123
- `open-sse/executors/deepseek-web.js` 1122
- `open-sse/executors/qoder.js` 1064
- `open-sse/translator/deepseekWebTools.js` 1033
- `open-sse/executors/chatgpt-web/firstParty.js` 988
- `open-sse/services/combo.js` 905
- `open-sse/providers/capabilities.js` 866
- `src/app/(dashboard)/dashboard/providers/[id]/page.js` 2006
- `src/app/(dashboard)/dashboard/profile/page.js` 1702
- `src/app/(dashboard)/dashboard/usage/components/ProviderLimits/index.js` 1697

That distribution is the real maturity signal. Nearly a third of the executor code is reverse-engineered web clients and browser automation (cursor, kiro, deepseek-web, qoder, gemini-web, muse-web, grok-web, chatgpt-web, windsurf, devin-cli), not routing. The routing core proper (combo, fallback, model resolution, capabilities) is under 3,000 lines.

---

### 1. Routing engine

### 1.1 Three independent decisions, in order

```
POST /v1/chat/completions
└── src/sse/handlers/chat.js:37  handleChat
    ├── key access check            chat.js:98   enforceKeyAccess
    ├── COMBO layer                 chat.js:110  getComboModels(modelStr)
    │   └── combo.js:354  handleComboChat  /  combo.js:820  handleFusionChat
    │       └── handleSingleModelChat (once per combo member)
    └── ACCOUNT layer               chat.js:279  while (true) over connections
        └── auth.js:28  getProviderCredentials   (fills one connection)
            └── open-sse/handlers/chatCore.js:64 handleChatCore  (one attempt)
```

The combo layer picks _which model string_. The account layer picks _which credential_ for the provider that string resolved to. `handleChat` enters the combo path when the requested name is a combo (`src/sse/handlers/chat.js:110-166`); each member recurses into `handleSingleModelChat` (`chat.js:193`), which owns the account loop.

### 1.2 Combo model

A combo is a named, ordered list of `provider/model` strings in the `combos` table (`src/lib/db/schema.js:93-103`). `getComboModelsFromData` returns `null` for any string containing `/`, so a combo name can never shadow a real `provider/model` pair (`open-sse/services/combo.js:282-294`).

Four strategies, dispatched at `src/sse/handlers/chat.js:113-165`:

| Strategy             | Code               | Behaviour                                                                                 |
| -------------------- | ------------------ | ----------------------------------------------------------------------------------------- |
| `fallback` (default) | `combo.js:471-624` | try members in order, advance on error                                                    |
| `round-robin`        | `combo.js:231-260` | rotates the start index per combo, with a sticky count                                    |
| `smart`              | `combo.js:372-448` | asks a System One classifier model which member fits, then pins the choice to the session |
| `fusion`             | `combo.js:820-898` | fan out to every member in parallel, a judge model synthesizes one answer                 |

`smart` has sub-policies (`combo.js:373-386`): `strict` locks the first model for the session with zero classifier calls, `smart-switch-70` / `-90` / `custom` set the confidence threshold for switching mid-session. Session stickiness exists to keep the prompt cache warm (`combo.js:412-416`).

Strategy is global (`settings.comboStrategy`, default `"fallback"` — `src/lib/db/repos/settingsRepo.js:17`) with a per-combo override at `settings.comboStrategies[name].fallbackStrategy` (`chat.js:113-115`). The UI exposes all four (`src/app/(dashboard)/dashboard/combos/page.js:51-54`).

**Fallback loop details** (`combo.js:471-624`):

- A 2xx is not treated as success. The body is peeked for real content (`combo.js:482-529`). This exists because Gemini aborts with `MALFORMED_FUNCTION_CALL` while still returning HTTP 200 and a terminal frame with empty content (`open-sse/services/emptyFailover.js:1-14`).
- The peek signal is structural, not enum-driven: "the stream ended and no content frame was ever released" (`emptyFailover.js:11-14`). `peekStreamForContent` buffers head bytes and hands back a live reader so the replay is byte-identical (`emptyFailover.js:152-197`; `reconstructStream` at `:202-219`).
- Deadline fail-open: on timeout it commits the candidate rather than hold a slow-but-valid stream (`emptyFailover.js:178-181`).
- Legitimately empty finishes (content filter, recitation, blocklist) are no-retry, so one blocked generation does not burn every candidate (`emptyFailover.js:142-145`).
- Non-stream JSON bodies get the equivalent zero-content check across all four wire formats (`combo.js:301-334`).

### 1.3 The "tier" concept (Subscription → Cheap → Free)

**Not a property of the engine.** I grepped `tier` across `open-sse/` and `src/`. Every hit is a `tierOf()` capability sort, a provider _label_ ("free tier", "paid tier of the same model"), or an upstream model-id substring. There is no `tier` field, no subscription/cheap/free enum, and no cost-based ordering in the resolver.

What does exist:

- Every registry entry carries `category` of `"apikey"` | `"oauth"` | `"freeTier"` — a required field declared at `open-sse/providers/schema.js:13` and shown in the template at `open-sse/providers/REGISTRY_TEMPLATE.js:22`. About 20 entries set `"freeTier"` (`registry/agnes.js:20`, `registry/api-airforce.js:18`, `registry/bazaarlink.js:6`, `registry/cloudflare-ai.js:21`, `registry/gemini.js:18`, `registry/kilo-gateway.js:9`, `registry/kimchi.js:16`, others). `registry/openrouter.js:4` adds `hasFree: true`.
- `category` drives UI grouping and OAuth availability. It does not order routing.

The tier ladder is the **user's own combo ordering**. README:623-624, 774-786 and 815-821 all show it hand-built: `cc/claude-opus-4-6` → `glm/glm-4.7`.

Two README claims worth flagging against the code:

- README:40 and 542-543 say "Auto-route: Subscription → Cheap → Free". No code implements that rule. README:660 states the same thing honestly as user advice: "Mix subscription, cheap, and free tiers".
- README:945: "Set spending limits per provider in dashboard, and 9Router respects them." I grepped `spendingLimit`, `spendLimit` and `budget` and found no such setting; `DEFAULT_SETTINGS` (`settingsRepo.js:7-70`) has none. That claim looks false as of this version.

I am confident about the absence of a routing tier. See section 10 for what I did not read.

### 1.4 Multi-account round-robin

Connections per provider live in `providerConnections` (`schema.js:34-52`). Selection is `getProviderCredentials` (`src/sse/services/auth.js:28`):

- A module-level mutex serialises selection so two concurrent requests cannot pick and stamp the same connection (`auth.js:36-41`).
- `fill-first` (default): take `availableConnections[0]`, already sorted by priority (`auth.js:197-200`).
- `round-robin`: sort by `lastUsedAt` desc, keep the current connection while `consecutiveUseCount < stickyLimit`, else take the least-recently-used and reset the count to 1 (`auth.js:158-196`). Sticky limit defaults to 3 (`auth.js:159`; `settingsRepo.js:14`) and is overridable per provider.
- A connection is skipped when model-locked, explicitly excluded, or (codex only) the model is outside its `enabledModels` list (`auth.js:87-103`).
- No-auth free providers get a synthetic `connectionId: "noauth"` with a proxy pool resolved from `settings.providerStrategies` (`auth.js:46-72`).

Post-failure account fallback is the outer `while (true)` in `chat.js:279-389`: on `shouldFallback`, add the connection to `excludeConnectionIds` and loop (`chat.js:379-386`). When none remain, it returns the earliest `rateLimitedUntil` as an `unavailableResponse` (`chat.js:283-296`, humanised by `accountFallback.js:111-124`).

### 1.5 Retry and cooldown rules

Rules are config, not code branches. `open-sse/config/errorConfig.js:59-82` holds `ERROR_RULES`, matched top-to-bottom — text substring rules first, then status rules:

```
codex  "model is not supported when using codex with a chatgpt account"  30 min
codebuddy-intl  "request illegal" / "conversation id missing"            backoff
"no credentials"                                                        2 min
"request not allowed"                                                   5 s
"improperly formed request"                                             2 min
"rate limit" | "too many requests" | "quota exceeded"
  | "insufficient credit" | "credit balance is too low"
  | "capacity" | "overloaded"                                          backoff
401 / 402 / 403 / 404                                                   2 min
429                                                                     backoff
```

(`errorConfig.js:61-81`.)

Backoff is `2000ms × 2^(level-1)`, capped at 5 min, level capped at 15 (`errorConfig.js:32-36`; `accountFallback.js:9-13`). Unmatched errors get a 30 s transient cooldown (`errorConfig.js:39`; `accountFallback.js:70`). Upstream-reported reset times are honoured but capped at 30 min (`errorConfig.js:41-42`; applied `src/sse/services/auth.js:262-268`), with Antigravity explicitly exempt from the cap (`auth.js:264-267`).

The sharpest decision in this file: `checkFallbackError` answers **two different questions** (`accountFallback.js:29-71`).

- `shouldFallback` — is the _credential_ at fault? Rotate the account.
- `requestScoped` — did this member reject the _request itself_? Advance the combo member, but do **not** cool the account.

A 4xx other than 401/402/403/429, matching no text rule, is `requestScoped` (`accountFallback.js:65-67`). The comment at `:55-64` explains why: cooling a healthy account on a context-overflow 400 removes it from rotation and buries the real cause under "all accounts locked". `combo.js:594-600` handles that path, and `combo.js:631-634` returns the first request-scoped failure to the client rather than a synthesized envelope that would read as a 200 carrying an error.

Locks are flat columns `modelLock_<model>` / `modelLock___all` on the connection row (`accountFallback.js:126-182`), written by `markAccountUnavailable` (`auth.js:247-295`). Cooldowns are per model, so one rate-limited model does not disable the whole connection.

Inside a combo, a transient 502/503/504 with a cooldown under 5 s is waited out before advancing (`combo.js:605-609`). That is the only place a request sleeps instead of moving on.

### 1.6 Model string → provider + account

`parseModel` splits on the first `/` and resolves the left side through an alias map built from the registry at module load — `id`, `alias`, and every entry of `aliases[]` (`open-sse/services/model.js:13-18`, `:34-55`), plus five hand-written media-only aliases (`model.js:5-11`).

A bare name (no slash) resolves through: user model-alias map → one builtin alias → prefix inference (`model.js:94-123`). Prefix inference is ordered regexes: `^claude-` → anthropic, `^gemini-` → gemini, `^(us|eu|ap|global)\.(anthropic|meta|amazon|mistral|xai)\.` → bedrock, `^gpt-[56]\.` → codex, `^deepseek-` → openrouter, and so on (`model.js:126-149`). Anything unmatched defaults to `openai` (`model.js:158`).

Then `getProviderCredentials(provider, exclude, model)` picks the connection (`chat.js:280`).

### 1.7 Capability routing and the capacity adapter

`detectRequiredCapabilities` scans for `vision` / `pdf` / `audioInput` / `videoInput` (`combo.js:128-207`). It scans only the _current_ user turn, not history — historical media must not pin a combo to a vision model (`combo.js:113-116`, `:198-202`).

`reorderByCapabilities` stable-sorts members into three buckets: satisfies all hard + soft, all hard only, rest (`combo.js:86-105`). Hard capabilities are `vision, pdf, audioInput, videoInput` (`combo.js:35`); a missing hard cap _drops request data_, a missing soft cap only degrades a feature. No member is ever removed, so fallback survives.

`capacityAdapter.js` goes further. If **no** member can satisfy a hard capability, it prepends global per-capability fallback pools as extra candidates (`capacityAdapter.js:93-101`). Pools are user settings; an enabled-but-empty pool defaults to `oc/mimo-v2.6-flash-free` so the toggle is never a no-op (`capacityAdapter.js:14-42`; settings defaults at `settingsRepo.js:20-25`). Adapter calls also get history stripped to fit the smaller context window, dropping the middle while keeping system messages and the current turn (`capacityAdapter.js:118-157`, wrapper at `:161-174`).

---

### 2. Provider model

### 2.1 Declarative data, not per-provider code

Providers are **declarative registry files**. `open-sse/providers/registry/index.js` is a hand-maintained static import list of 147 entries (`registry/index.js:1-152`), exported as one array (`:150-297`). Each file does `export default { ... }`.

The contract is a JSDoc typedef at `open-sse/providers/schema.js:4-46`, with a worked example at `open-sse/providers/REGISTRY_TEMPLATE.js:1-98`. Only `id` and `category` are required (`schema.js:9-13`).

Fields:

- **Identity** — `id`, `alias`, `aliases[]`, `uiAlias`, `category` (`schema.js:9-13`). `priority` also appears in practice (`registry/openrouter.js:3`).
- **Auth hints** — `authType`, `authModes[]`, `hasOAuth`, `noAuth` (`schema.js:14-17`).
- **Display** — `display{name, icon, color, textIcon, website, notice, deprecated, deprecationNotice, kindNotice, mediaPriority}` (`schema.js:18`).
- **Transport** — `transport{baseUrl, format, headers, auth, forceStream, urlSuffix, quirks, retry, timeoutMs, executor, regions, defaultRegion, modelsFetcher, validateUrl, responsesUrl, transports[]}` (`schema.js:19, 27-30`).
- **OAuth** — `oauth{clientId, authorizeUrl, tokenUrl, deviceCodeUrl, refreshUrl, scope(s), redirectUri, fixedPort, callbackPath, codeChallengeMethod, extraParams, refresh, refreshLeadMs, userInfoUrl}` (`schema.js:32-34`).
- **Media** — `media{serviceKinds[], ttsConfig, sttConfig, embeddingConfig, imageConfig, searchViaChat, systemoneConfig, videoConfig, hiddenKinds}` (`schema.js:36-45`).
- **Models** — `models[{id, name, kind, params[], capabilities[], contextWindow, dimensions, options, upstreamModelId}]` (`schema.js:22`; sample at `registry/openrouter.js:28-47`).
- **Flags** — `features{usage}`, `thinkingConfig`, `passthroughModels` (`schema.js:23-25`).

Worked example, `open-sse/providers/registry/openrouter.js`: identity `:2-19`, OpenAI-format transport with static fingerprint headers `:20-27`, a mixed-kind model list `:28-47` (embedding, tts, image, video, systemone), `serviceKinds` `:48`, per-service base URLs `:50-63`.

`serviceKinds` across the registry, counted from source: `llm` 35, `image` 26, `embedding` 16, `imageToText` 13, `webSearch` 12, `tts` 10, `systemone` 8, `stt` 8, `video` 7, `webFetch` 2. Per-model `kind` counts: `embedding` 131, `image` 117, `video` 44, `tts` 44, `stt` 26, `systemone` 14.

### 2.2 Where code does appear

"Declarative" is the common case, not an absolute one. Three escape hatches:

1. **Executors.** `open-sse/executors/index.js:39-92` maps ~30 provider ids to hand-written classes for anything that is not a plain HTTP call — Cursor's protobuf protocol, Kiro's flow, the browser-automation web clients, Qoder's context-tier negotiation. `getExecutor` falls back to `DefaultExecutor` for unlisted ids (`executors/index.js:94-98`; `hasSpecializedExecutor` at `:100-102`).
2. **Per-kind adapter directories.** Media calls delegate to `open-sse/handlers/{embedding,image,tts,video}Providers/`, one file per provider.
3. **Capability tables.** `open-sse/providers/capabilities.js` (866 lines) merges hand-written provider/model/pattern tables with a background-synced models.dev catalog (`capabilities.js:1-37`).

So connection setup and transport are data; protocol quirks and media request shapes are code.

### 2.3 Adding a provider

Per `REGISTRY_TEMPLATE.js:1-12` and `schema.js`:

1. Copy the template to `open-sse/providers/registry/<id>.js`, delete unused blocks.
2. Fill `id` + `category` (required), then `display`, `transport` (baseUrl plus only the fields that differ), and `models`.
3. For OAuth, add `oauth{}`. `clientId` / `clientSecret` / `tokenUrl` auto-inject into transport; do not duplicate them (`REGISTRY_TEMPLATE.js:57`, `schema.js:29-30`).
4. For media-only, drop `models` + chat baseUrl and fill `media{serviceKinds, *Config}` (`REGISTRY_TEMPLATE.js:11`).
5. Register the import by hand in `registry/index.js:2-152` and add it to the array at `:150-297`. Two entries are currently commented out with reasons: trae (`:166`, "no tool calling") and devin-cli / windsurf (`:177-178`).

Nothing else is needed for a plain API-key LLM: `model.js:13-18` picks up the alias, `getExecutor` returns the default. `tests/__baseline__/snapshot-providers.mjs` plus `providers-baseline.json` and `verify-no-regression.mjs` guard the registry against accidental change.

---

### 3. Endpoint surface beyond chat

Every `src/app/api/v1/**/route.js` plus `src/app/api/v1beta/`:

| Endpoint                                                                 | File                                     | Handler                                                  | Notes                                                                          |
| ------------------------------------------------------------------------ | ---------------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `POST /v1/chat/completions`                                              | `v1/chat/completions/route.js:29`        | `handleChat`                                             | OpenAI chat, auto-detected source format                                       |
| `POST /v1/messages`                                                      | `v1/messages/route.js:30`                | `handleChat`                                             | Anthropic Messages                                                             |
| `POST /v1/messages/count_tokens`                                         | `v1/messages/count_tokens/route.js`      | inline                                                   | **character-count heuristic, not a tokenizer** — `countValueChars` at `:14-29` |
| `POST /v1/responses`                                                     | `v1/responses/route.js:27`               | `handleChat`                                             | OpenAI Responses API                                                           |
| `POST /v1/responses/compact`                                             | `v1/responses/compact/route.js:27-30`    | `handleChat` with `body._compact = true`                 | context compaction through the same pipeline                                   |
| `POST /v1/embeddings`                                                    | `v1/embeddings/route.js:19`              | `handleEmbeddings` (`src/sse/handlers/embeddings.js:33`) | OpenAI-compatible                                                              |
| `POST /v1/images/generations`                                            | `v1/images/generations/route.js:14`      | `handleImageGeneration`                                  | OpenAI-compatible                                                              |
| `POST /v1/audio/speech`                                                  | `v1/audio/speech/route.js:14`            | `handleTts`                                              | OpenAI-compatible TTS                                                          |
| `POST /v1/audio/transcriptions`                                          | `v1/audio/transcriptions/route.js:17`    | `handleStt`                                              | Whisper-compatible STT, `maxDuration = 300`                                    |
| `GET /v1/audio/voices`                                                   | `v1/audio/voices/route.js:20`            | inline                                                   | voice list across 5 TTS providers                                              |
| `POST /v1/videos/generations`                                            | `v1/videos/generations/route.js:14`      | `handleVideoCreate(…, "generations")`                    | async create                                                                   |
| `POST /v1/videos/edits`                                                  | `v1/videos/edits/route.js:14`            | `"edits"`                                                | video edit                                                                     |
| `POST /v1/videos/extensions`                                             | `v1/videos/extensions/route.js:14`       | `"extensions"`                                           | video extend                                                                   |
| `GET /v1/videos/{id}`                                                    | `v1/videos/[id]/route.js:14`             | `handleVideoGet`                                         | poll async job                                                                 |
| `POST /v1/search`                                                        | `v1/search/route.js:19`                  | `handleSearch`                                           | web search                                                                     |
| `POST /v1/web/fetch`                                                     | `v1/web/fetch/route.js:19`               | `handleFetch`                                            | URL fetch + extract                                                            |
| `POST /v1/systemone`                                                     | `v1/systemone/route.js:19`               | `handleSystemone`                                        | System One (Jev) decision API                                                  |
| `GET /v1/models`, `GET /v1`                                              | `v1/models/route.js`, `v1/route.js:1`    | `buildModelsList`                                        | 681-line catalog with live resolvers                                           |
| `GET /v1/models/info`                                                    | `v1/models/info/route.js`                | inline                                                   | per-model metadata; kind → endpoint map at `:5-14`                             |
| `GET /v1/models/{kind}`                                                  | `v1/models/[...model]/route.js:5-12`     | inline                                                   | kind filter: `image`, `tts`, `stt`, `embedding`, `image-to-text`, `web`        |
| `POST /v1/api/chat`                                                      | `v1/api/chat/route.js:24`                | `handleChat` + `transformToOllama`                       | Ollama-shaped adapter over the same pipeline                                   |
| `GET /v1beta/models`                                                     | `v1beta/models/route.js`                 | inline                                                   | Gemini model listing                                                           |
| `POST /v1beta/models/{model}:generateContent` / `:streamGenerateContent` | `v1beta/models/[...path]/route.js:43-94` | maps action → `stream: true/false`                       | Gemini SDK compatibility                                                       |

Two notes:

- `/v1/models/info` maps `webFetch` to `"/v1/fetch"` (`v1/models/info/route.js:13`), but the real route is `/v1/web/fetch`. There is no `/v1/fetch` in the tree. Looks stale.
- `/v1/messages/count_tokens` returns a character count. Clients that budget context from that number will mis-estimate by the target model's tokenizer ratio.

### 3.1 What each modality supports

**Embeddings.** Adapters per provider: `openai`, `gemini`, `github`, `ollamaLocal`, `openaiCompatNode`, `selfhostedEmbedding` (`open-sse/handlers/embeddingProviders/`). `embeddingsCore.js` is a pure orchestrator: validate, get adapter, build URL/headers/body, execute, normalize (`embeddingsCore.js:13-60`). It does **not** route through `handleComboChat` — embeddings get account fallback but not combo fallback (`src/sse/handlers/embeddings.js:102-125`).

**Images.** 19 provider adapters plus `_base.js` and `index.js` (`open-sse/handlers/imageProviders/`). Unlike embeddings this **does** support combos (`src/sse/handlers/imageGeneration.js:83` calls `handleComboChat`) and account fallback (`:120`). The core accepts `streamToClient` and `binaryOutput` flags (`imageGenerationCore.js:30-40`), which is how one core serves both OpenAI-style JSON and SSE clients.

**TTS.** 14 adapters (`open-sse/handlers/ttsProviders/`). Returns raw `audio/<format>` bytes by default, or base64 JSON when `response_format === "json"` (`ttsCore.js:15-40`). Combos and account fallback apply (`src/sse/handlers/tts.js:59`).

**STT.** `sttCore.js` (333 lines) with provider-specific paths — Deepgram uses raw-binary POST with query params (`:40-45`) — plus dedicated `geminiLiveStt.js` and `codexStt.js` handlers (`:3-4`).

**Video.** 3 adapters (`openrouter`, `vertex`, plus `index.js`) and executor-driven paths (`videoCore.js:21-45`). Explicitly **never auto-retried** on network error, because the billable upstream job may already exist (`videoCore.js:11-15`); only the post-401/403 credential-refresh retry is allowed.

**Search.** Two mechanisms (`open-sse/handlers/search/index.js:1-12`): dedicated search APIs (`provider.searchConfig` → `callers.js` 493 lines + `normalizers.js` 322 lines) and chat-wrapped search (`provider.searchViaChat` → `chatSearch.js` 553 lines). Query sanitisation and a 15 s global timeout at `search/index.js:15-26`. Providers declaring `webSearch` include gemini, glm, kimi, minimax, openai, perplexity, xai, and dedicated search APIs (brave-search, exa, serper, searxng, tavily, searchapi, linkup, google-pse, ollama-search, tinyfish).

**Fetch.** `open-sse/handlers/fetch/index.js:1-2` dispatches to firecrawl, jina-reader, tavily, exa, ollama, tinyfish, normalising to one shape with markdown default (`:5`).

**System One.** A native decision-API passthrough with no chat translation (`systemoneCore.js:26-42`). Serves both the user-facing endpoint and, internally, the `smart` combo strategy.

Auth is uniform: `extractApiKey` / `isValidApiKey` appear in every `src/sse/handlers/*.js` (chat, embeddings, fetch, tts, stt, search, videoGeneration, imageGeneration, systemone), so `requireApiKey` is enforced across all of them.

---

### 4. Token savers (`open-sse/rtk/`)

Six mechanisms, 1,533 lines plus 782 lines of filters.

### 4.1 Opt-in status

From `src/lib/db/repos/settingsRepo.js:52-67`:

| Saver         | Default | Setting                              |
| ------------- | ------- | ------------------------------------ |
| RTK           | **on**  | `rtkEnabled: true` (`:52`)           |
| Headroom      | off     | `headroomEnabled: false` (`:53`)     |
| Caveman       | off     | `cavemanEnabled: false` (`:57`)      |
| Ponytail      | off     | `ponytailEnabled: false` (`:59`)     |
| Custom prompt | off     | `customPromptEnabled: false` (`:62`) |
| PXPIPE        | off     | `pxpipeEnabled: false` (`:64`)       |

One per-request escape hatch covers all of them: `x-9router-token-saver: off` (`open-sse/config/runtimeConfig.js:73`; consumed at `chatCore.js:131-132`). Custom prompt ignores that header (`chatCore.js:314`; its own comment at `open-sse/rtk/customPrompt.js:4-5`). All configuration is server-global; there is no per-key saver setting.

### 4.2 RTK — tool-result compression

The only default-on saver. It compresses `tool_result` / tool-message content so large CLI output costs fewer tokens.

Hook: `chatCore.js:282` (`compressMessages` on the translated body), with a pre-translate path for Cursor because Cursor's translator rewrites `tool_result` into user text first (`chatCore.js:138-142`). The post-translate placement also means a retry never re-compresses an already-compressed body.

Mechanism (`open-sse/rtk/index.js`):

- Six body shapes: OpenAI Responses `function_call_output` as string or array (`:30-42`), OpenAI `role:"tool"` as string or array (`:45-61`), Claude `tool_result` string or array (`:66-80`), and Kiro `conversationState` (`:91-118`).
- `is_error: true` blocks are skipped so error traces survive (`:67`); Kiro `status === "error"` likewise (`:103`).
- Size gate: skip below 500 bytes, skip above 10 MiB (`constants.js:2-3`; `index.js:124`).
- Filter choice is **content autodetect**, not per-tool config (`autodetect.js:28-50`): peek the first 1024 chars (`constants.js:5`) and match ordered regexes — git-log → git-diff → git-status → build-output → porcelain → grep → find → tree → ls → search-list → read-numbered → dedup-log → smart-truncate.
- Safety: never return empty, never grow the input (`index.js:138-141`); `safeApply` wraps every filter (`applyFilter.js`).
- Emits `[RTK] saved NB / MB (P%) via [filters] hits=N` (`index.js:149-155`).

12 filter modules in `open-sse/rtk/filters/` (782 lines), 11 of them registered in `open-sse/rtk/registry.js:14-26` plus `buildOutput` reached through autodetect (`open-sse/rtk/autodetect.js:37`): `gitDiff` (100 lines/hunk, 3 context), `gitStatus` (10 files), `gitLog` (200 lines), `grep` (10/file), `find` (10/dir, 20 dirs), `ls` (noise-dir list at `constants.js:22-30`), `tree` (200 lines), `dedupLog` (2000-line cap), `smartTruncate` (120 head + 60 tail above 250 lines), `readNumbered`, `searchList`. Caps deliberately mirror the original Rust project (`constants.js:1`, `:11-14`); this is a port, not an original design.

### 4.3 Caveman — output-style system prompt

Injects a terse-response instruction into the system message (`open-sse/rtk/caveman.js:7-9` → `systemInject.js`). It saves **output** tokens by shaping the reply, not input tokens.

Six levels (`cavemanPrompts.js:4-11`): `lite`, `full`, `ultra`, and three classical-Chinese variants `wenyan-lite`, `wenyan`, `wenyan-ultra`. Each is shared constraint strings: code, paths, commands, errors kept exact; security warnings and irreversible-action confirmations written normally; user language preserved; no self-reference; no decorative emoji (`cavemanPrompts.js:13-27`). UI labels and descriptions at `src/app/(dashboard)/dashboard/endpoint/endpointConstants.js:19-26`. Adapted from the upstream caveman skill (`cavemanPrompts.js:2`).

Hook: `chatCore.js:302-305`.

### 4.4 Ponytail — minimal-code system prompt

Same injection mechanism, different target: bias the model toward writing less code (`open-sse/rtk/ponytail.js:7-9`). Three levels (`ponytailPrompt.js:4-8`). The prompt is a six-rung ladder — YAGNI, stdlib, native platform, existing dependency, one line, minimum code (`ponytailPrompt.js:12`) — with explicit carve-outs: never simplify away input validation, error handling, security, or accessibility (`:18`). Adapted from the upstream ponytail skill (`:2`).

Hook: `chatCore.js:308-311`. Saves tokens indirectly, by producing smaller diffs.

### 4.5 Headroom — external compression proxy

An **out-of-process** compressor. `compressWithHeadroom` POSTs eligible message text to a proxy and copies compressed text back (`open-sse/rtk/headroom.js:404-470`). Default endpoint `http://localhost:8787` (`settingsRepo.js:5`).

Design points:

- Fail-open everywhere: disabled, missing URL, missing body, no eligible text, timeout — each returns `null` and leaves the body untouched (`headroom.js:406-417`). Default timeout 3000 ms (`:9-15`).
- Format-aware copy-back. Claude keeps documents, tool blocks and signatures in native form and copies back only validated text leaves (`headroom.js:434-447`). OpenAI Responses input is round-tripped through OpenAI messages and back, because the proxy only understands OpenAI (`headroom.js:449-464`). Native tool-output text is handled separately (`:422-432`).
- It audits the proxy. `captureSizeSnapshot` records body / message / tool-schema / tool-history bytes before and after (`headroom.js:36-53`); if the proxy reports token savings while the outbound JSON shrank under 5%, `isHeadroomPhantomSavings` logs a warning (`chatCore.js:291-293`).

That last point is the interesting one. An external service claiming savings is not evidence of savings, so the code measures actual bytes and calls out a liar.

### 4.6 PXPIPE — render bulk context as images

Renders bulky Claude-format context into dense PNGs, on the theory that images tokenize cheaper than equivalent text (`open-sse/rtk/pxpipe.js:1-4`).

- Claude format only (`:36`), 25,000-char minimum by default (`:7`), 15 s default timeout (`:6`).
- The transform is **injected by the host** so `open-sse` stays free of filesystem and install concerns and remains usable standalone (`:30-31`). `src/sse/handlers/chat.js:339` supplies it via `getPxpipeTransform()`, lazily installing the dependency (`pxpipeAutoInstall: true` at `settingsRepo.js:65`).
- The transform is local CPU work and cannot be aborted, so it races a timer and discards the loser; the input body is never mutated (`pxpipe.js:48-58`).
- Every non-application is a named skip reason: `disabled`, `not_installed`, `missing_body`, `unsupported_format`, `below_threshold`, `timeout` (`:24-26, 33-43, 58`).

Hook: `chatCore.js:319-329`, last saver before dispatch, with its own stats event.

### 4.7 Custom prompt

User-authored system prompt injected independently of the built-in savers, with its own toggle and text (`open-sse/rtk/customPrompt.js:1-13`). Hook: `chatCore.js:314-316`.

---

### 5. Translation (`open-sse/translator/`)

### 5.1 Structure

A **registry-based pivot translator**, about 9,700 lines.

```
translateRequest(sourceFormat, targetFormat, model, body, ...)
open-sse/translator/index.js:69
├── normalize (tool ids, missing tool responses, thinking config)   index.js:76-99
├── direct pair registered for source:target ?                     index.js:106-108
│   └── e.g. claude:kiro — avoids the claude → openai → kiro double hop
├── else pivot through OpenAI                                       index.js:110-126
│   ├── source → openai   (if source !== openai)
│   └── openai → target   (if target !== openai)
└── applyThinking (target-native reasoning shape)                   index.js:137-139
```

`register(from, to, requestFn, responseFn)` builds two maps keyed `"from:to"` (`index.js:22-32`). Modules self-register on import; 23 static side-effect imports at `index.js:319-341` do the wiring. The `var` + `??=` at `index.js:15-19` exists to survive circular-import ordering without a TDZ crash.

### 5.2 Wire formats

13 formats in `FORMATS` (`open-sse/translator/formats.js:2-16`): `openai`, `openai-responses`, `openai-response`, `claude`, `gemini`, `gemini-cli`, `vertex`, `codex`, `antigravity`, `kiro`, `cursor`, `ollama`, `commandcode`.

**Client-facing inputs:** OpenAI Chat, Anthropic Messages, OpenAI Responses, Gemini `generateContent`, Antigravity (Gemini inside `body.request`), Ollama, plus Codex CLI / Cursor CLI / Claude Code / Gemini CLI native shapes detected by `detectClientTool`.

**Request translators** — 12 files, 3,550 lines (`open-sse/translator/request/`):
`claude-to-openai`, `openai-to-claude`, `gemini-to-openai`, `openai-to-gemini`, `openai-to-vertex`, `antigravity-to-openai`, `openai-responses`, `openai-to-kiro`, `claude-to-kiro`, `openai-to-cursor`, `openai-to-ollama`, `openai-to-commandcode`.

**Response translators** — 10 files, 2,277 lines (`open-sse/translator/response/`):
`claude-to-openai`, `openai-to-claude`, `gemini-to-openai`, `openai-to-antigravity`, `openai-responses` (708 lines), `kiro-to-openai`, `kiro-to-claude`, `cursor-to-openai`, `ollama-to-openai`, `commandcode-to-openai`.

**Format helpers** — 1,698 lines (`open-sse/translator/formats/`): `claude.js` 746 (`prepareClaudeRequest`, `normalizeClaudePassthrough`, `anchorClaudeCache`), `gemini.js` 590, `responsesApi.js` 194, `openai.js` 134, `maxTokens.js` 34.

**Schema constants** live in `open-sse/translator/schema/` (blocks, roles, finish reasons, stream events) so translators compare enum members, not string literals. `emptyFailover.js` imports them too.

### 5.3 Format selection is not just body sniffing

`detectFormat` sniffs the body (`open-sse/services/provider.js:34-111`), but two better signals override it:

- **Endpoint.** `/v1/responses` is always Responses; `/v1/messages` is always Claude (`open-sse/translator/formats.js:22-35`), passed in as `sourceFormatOverride` (`chatCore.js:77`).
- **Transport-first target selection.** A multi-endpoint provider declares `transport.transports[]`; `resolveTransport(provider, sourceFormat)` picks the entry matching the client's format so no translation happens at all (`provider.js:148-153`). Per-model guards stop a model that only speaks `/chat/completions` from being sent to `/messages` (`chatCore.js:90-111`). This is the lossless path: when the client already speaks the target format, translation is skipped (`chatCore.js:101-111`).

### 5.4 Native passthrough

Separate from translation: when the calling CLI and the provider are the same ecosystem (Claude Code → anthropic, Codex → codex), translate and normalize are skipped entirely and only the model and Bearer are swapped (`chatCore.js:175-215`; `isNativePassthrough` in `open-sse/utils/clientDetector.js`). Two Claude Code shape normalizers still run (`chatCore.js:215`).

### 5.5 Debug surface

Six-stage dump: client request → source body → OpenAI intermediate → target request → provider response → OpenAI response (`src/app/(dashboard)/dashboard/translator/page.js:19-24`). Backed by `src/app/api/translator/{translate,send,load,save,console-logs}` (388 lines). `/api/translator/translate` reuses production `detectFormat` / `translateRequest` / `getExecutor` (`src/app/api/translator/translate/route.js:1-7`), so what you inspect is what ships. Gated behind `enableTranslator` (`src/shared/components/Sidebar.js:269`).

---

### 6. Auth, keys, multi-tenancy

### 6.1 Multi-user? No.

**9router is single-tenant.** There is no `users` table — `schema.js:21-159` defines only `_meta`, `settings`, `providerConnections`, `providerNodes`, `proxyPools`, `apiKeys`, `combos`, `kv`, `usageHistory`, `usageDaily`, `requestDetails`. Settings are one row pinned by `CHECK (id = 1)` (`schema.js:28-33`).

Dashboard auth is one shared credential:

- Default password `"123456"` (or `INITIAL_PASSWORD`), bcrypt-hashed into `settings.password` (`src/app/api/auth/login/route.js:41, 53-60`).
- Session is a signed JWT cookie (`src/lib/auth/dashboardSession.js`, 84 lines).
- `requireLogin` defaults `true` but can be turned off entirely (`settingsRepo.js:26`; honoured at `src/dashboardGuard.js:267`).
- Login is rate-limited per IP (`src/lib/auth/loginLimiter.js`, 64 lines; used at `login/route.js:23-30`).

Multi-**account** means many upstream provider credentials (section 1.4). That is a different axis from multi-user and is easy to conflate.

### 6.2 SSO: OIDC and SAML, both present

Mutually exclusive with password login:

- **OIDC** — `src/lib/auth/oidc.js` (234 lines). `jose` JWKS verification, PKCE with state/nonce/verifier cookies (`oidc.js:5-9`). Routes `src/app/api/auth/oidc/{start,callback,test}`.
- **SAML** — `src/lib/auth/saml.js` (268 lines). `@node-saml/node-saml`, SP-initiated. Routes `src/app/api/auth/saml/{start,acs,metadata,test}`.
- Mode switch is `settings.authMode` (`password` | `sso` | `oidc` | `saml`) plus `ssoType` (`settingsRepo.js:29-30`; enforced at `login/route.js:43-51`).
- Config fields sit in the singleton settings row: `oidcIssuerUrl`, `oidcClientId`, `oidcClientSecret`, `oidcScopes`, `oidcLoginLabel`, `samlEntryPoint`, `samlIssuer`, `samlCert`, `samlLoginLabel`, `samlAttributeEmail`, `samlAttributeName` (`settingsRepo.js:31-41`).

What SSO gates matters. It gates the dashboard only. The `/v1/*` API is guarded by API keys; `src/dashboardGuard.js:38` lists `/v1`, `/v1beta`, `/api/v1`, `/codex`, `/responses` as public prefixes whose handlers authenticate themselves.

### 6.3 API keys

Routes `src/app/api/keys/route.js` (list, create) and `keys/[id]/route.js` (update, delete). Keys embed the server machine id and are stored in `apiKeys` with `key` UNIQUE (`schema.js:78-91`; generation at `keys/route.js:29-30` via `src/shared/utils/apiKey.js`).

**Per-key scoping exists and is real.** Each key carries `accessRestricted` and `accessAllow` (`schema.js:88-89`). The model is documented at `src/sse/services/keyAccess.js:1-24`: unrestricted by default, or restricted to an explicit allow-list of combos and models, matched on _resolved_ identities so `cx/gpt-5` and `codex/gpt-5` compare equal. No wildcards, no deny mode. An allowed combo grants its members only when reached through the combo (`:20-22`). The check runs before any credential lookup (`chat.js:98-100`), so a denied call never touches a provider account.

Two precision points:

1. Scoping is **model and route scoping, not quota or rate-limit scoping.** There is no per-key spend cap.
2. `requireApiKey` defaults `true` (`settingsRepo.js:27`) but is a single global toggle. Turn it off and `/v1` is unauthenticated.

### 6.4 Dashboard guard

`src/dashboardGuard.js` (288 lines) is the single middleware:

- Explicit public API list (`:23-34`).
- Public prefixes that bypass the guard because they authenticate themselves (`:38`).
- `ALWAYS_PROTECTED` — destructive or credential-leaking endpoints that require a JWT even when `requireLogin: false` (`:41-51`): `/api/shutdown`, `/api/settings/database`, `/api/version/update`, OAuth auto-import endpoints, minimax leases.
- A machine-id-derived CLI token (`x-9r-cli-token`) so the local CLI can reach the API without a browser session (`:7-20`).

### 6.5 Where things are stored

- **Settings** — one JSON blob in the `settings` row (`settingsRepo.js:72-76`), merged over `DEFAULT_SETTINGS` (`:7-70`) so a missing key reads as its default.
- **Provider credentials** — `providerConnections.data` JSON, with `provider`, `priority`, `isActive` promoted to real columns for indexing (`schema.js:34-52`).
- **Model locks and cooldowns** — flat `modelLock_*` keys inside that JSON (`accountFallback.js:126-182`).
- **Aliases, custom models, MITM aliases** — `kv` table, `(scope, key)` primary key (`schema.js:104-112`).
- **SSO and password config** — `settings` JSON, in plaintext, including `oidcClientSecret` and `samlCert` (`settingsRepo.js:31-41`). No secret encryption layer that I found.

---

### 7. Persistence

### 7.1 Store: SQLite, file at DATA_DIR/db/data.sqlite

`src/lib/db/paths.js:5-13` sets `DB_DIR`, `DATA_FILE`, `BACKUPS_DIR`, and lists the four legacy JSON files it migrated away from (`db.json`, `usage.json`, `disabledModels.json`, `request-details.json`).

Driver selection is a runtime fallback chain (`src/lib/db/driver.js:84-93`):

```
Bun:  bun:sqlite -> sql.js
Node: better-sqlite3 -> node:sqlite (>= 22.5) -> sql.js
```

Each step is guarded. `better-sqlite3` is skipped on Bun and on Node >= 24, where the native addon SIGSEGVs on load — a process-level crash a try/catch cannot recover from (`driver.js:20-33`). Four adapters live in `src/lib/db/adapters/`. If all four fail the process throws rather than silently losing writes (`driver.js:93`).

Two robustness details:

- PRAGMAs set once: WAL, `synchronous=NORMAL`, 30 MB mmap, 64 MB cache, foreign keys on, 5 s busy timeout (`schema.js:8-16`).
- Every bound string is stripped of NUL bytes at the adapter boundary, because SQLite stores TEXT as a NUL-terminated C string — better-sqlite3 rejects embedded NULs, node:sqlite silently truncates the tail (`driver.js:60-82`). One rule at the binding boundary instead of a fix at every call site. That is a bug you only write after meeting it in production.

Schema is declarative: `TABLES` (`schema.js:21-159`), `SCHEMA_VERSION = 2` (`:6`), and an additive auto-sync that adds missing tables/columns/indexes on boot (`schema.js:18-20`). Destructive changes get a versioned migration (`src/lib/db/migrations/`); a version bump also triggers a pre-change backup (`schema.js:1-5`).

```
src/lib/db/
├── driver.js          adapter chain, NUL-safe binding, migration on boot
├── paths.js           DATA_DIR resolution
├── schema.js          TABLES, PRAGMAs, SCHEMA_VERSION
├── migrate.js  backup.js  version.js
├── adapters/          betterSqlite, bunSqlite, nodeSqlite, sqljs
├── helpers/           jsonCol, kvStore, metaStore, nullBytes
└── repos/             alias, apiKeys, combos, connections, disabledModels,
                       nodes, pricing, proxyPools, requestDetails, settings, usage
```

`src/lib/localDb.js` is 21 lines of re-exports. `src/lib/usageDb.js` is 7, `src/lib/requestDetailsDb.js` is 4. All three are backward-compatibility shims over the pre-SQLite API (`localDb.js:1-2` says so explicitly). Real work is in `src/lib/db/repos/`; `usageRepo.js` is largest at 815 lines.

The shim is also a contract you cannot prune casually: every importer depends on its exact export list.

### 7.2 What is tracked

**`usageHistory`** (`schema.js:113-135`) — one row per request: `timestamp, provider, model, connectionId, apiKey, endpoint, promptTokens, completionTokens, cost, status, tokens, meta`. Indexed on timestamp desc, provider, model, connectionId. `apiKey` is stored **masked**, first 8 chars + `***` + last 4, keeping the tail so team keys sharing a machine-id prefix do not collide (`usageRepo.js:6-12`).

**`usageDaily`** (`schema.js:136-141`) — daily rollup keyed by `dateKey`, JSON blob. Period map `24h`, `7d`, `30d`, `60d` (`usageRepo.js:17`).

**`requestDetails`** (`schema.js:142-158`) — full request/response capture, **off by default**. Gated by `ENABLE_REQUEST_LOGS` env or `settings.enableObservability` (`requestDetailsRepo.js:13-40`; default `enableObservability: false` at `settingsRepo.js:42`). 200-record default cap, 20-row batches, 5 s flush, 5 KB max JSON per field (`requestDetailsRepo.js:4-7`).

**Live stats** are in memory, not persisted: pending requests by model and account, a 50-item ring buffer, a 30 s connection-map cache, and an `EventEmitter` for SSE push (`usageRepo.js:14-38`). All hung off `global` so Next.js hot-reload does not reset them (`usageRepo.js:20-29`), the same pattern as `driver.js:5`.

Pricing is its own repo (`repos/pricingRepo.js` plus `open-sse/providers/pricing.js`), which is what turns token counts into the `cost` column. README:847 is explicit that this is a reference figure, not billing.

---

### 8. Ops and extras

| Area                                                       | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Size                                                                                 |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| **Tunnel** (`src/lib/tunnel/`)                             | Exposes the gateway publicly through Cloudflare quick tunnel or Tailscale funnel. Cloudflare side has manager, binary bootstrap, pid tracking, health check; Tailscale side has manager, 859-line `tailscale.js`, install and login flows. Shared watchdog: internet probe, DNS resolver probe, restart cooldown, virtual-interface regex so VPN interfaces are not mistaken for connectivity loss (`shared/watchdogConfig.js`). Wired to 7 API routes (`src/app/api/tunnel/{enable,disable,status,tailscale-check,tailscale-enable,tailscale-disable,tailscale-install}`). | 1,836 lines, 14 files                                                                |
| **Proxy pools** (`src/app/api/proxy-pools/`)               | Named pools of upstream proxies with per-pool test status, plus one-click deploy of a relay to Cloudflare Workers, Deno Deploy, Netlify or Vercel. Assigned per connection, with a `strictProxy` flag that forbids silently falling back to a direct connection (`open-sse/handlers/chatCore.js:353-362`).                                                                                                                                                                                                                                                                  | 824 lines, 7 routes                                                                  |
| **CLI tools** (`src/app/api/cli-tools/`)                   | Writes provider config into the user's local CLI files: claude, codex, copilot, cline, droid, kilo, omp, pi, openclaw, opencode, hermes (YAML + profiles), deepseek-tui, devin, jcode, grok-build, codewhale, plus `antigravity-mitm` and `antigravity-mitm/alias`. Each has a `*-settings` route and a dashboard card.                                                                                                                                                                                                                                                     | ~18 tool configs; cards up to 713 lines (`GenericCliToolCard.js`)                    |
| **MCP** (`src/lib/mcp/` + `src/app/api/mcp/`)              | An inline stdio↔SSE bridge. Spawns one child process per MCP plugin on demand, broadcasts JSON-RPC over SSE, accepts client messages by POST. Includes a text compactor that drops noise nodes, collapses repeated siblings, hard-truncates at 50k chars, and preserves `[ref=eXX]` markers (`stdioSseBridge.js:14-26`).                                                                                                                                                                                                                                                    | 183 lines, 2 routes                                                                  |
| **Updater** (`src/lib/updater/` + `src/lib/appUpdater.js`) | A detached sidecar. Runs `npm i -g 9router@latest`, serves progress from a small HTTP server on port 20129, writes `status.json` + `install.log` under `DATA_DIR/update`, survives the parent server exiting, retries 3× with backoff, and waits for the app port to free before installing (`updater.js:12-40`).                                                                                                                                                                                                                                                           | 235 lines                                                                            |
| **MITM** (`src/mitm/`)                                     | A full local HTTPS interception proxy: generated root CA, platform cert installation (macOS / Windows / Linux), DNS entry add/remove, Windows elevation. Intercepts 7 upstream hosts — Google Cloud Code, GitHub Copilot, AWS CodeWhisperer/Q, Kiro, Cursor (`src/mitm/config.js:16-24`) — with per-tool handlers for antigravity, copilot, cursor, kiro. This is how it serves IDEs that ignore `baseURL` config.                                                                                                                                                          | 3,400 lines, 17 files; `manager.js` 883, `cert/install.js` 269, `cert/rootCA.js` 173 |

MITM and the web-client executors are where the risk lives: a root CA plus DNS overrides plus browser automation, in order to reach providers whose terms may not contemplate third-party routing. That is engineering effort spent answering a legal question, not a technical one. I confirmed these exist and sized them; I did not audit the interception handlers (`src/mitm/handlers/`) for safety.

---

### 9. Client surface

### 9.1 Dashboard pages

`src/app/(dashboard)/dashboard/` — 23 `page.js`, 18 nav entries. Nav groups at `src/shared/components/Sidebar.js:20-40`.

**Main nav** (`Sidebar.js:20-30`):

| Route                    | Feature                                                                                                                                                                                                | Nav label                                |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------- |
| `/dashboard`             | index; redirects into the endpoint page (`Sidebar.js:73-74`)                                                                                                                                           | —                                        |
| `/dashboard/endpoint`    | endpoint URL, API key, tunnel / Tailscale URLs, token-saver controls, caveman and ponytail level pickers (`EndpointPageClient.js` 1,336 lines; `endpointConstants.js:19-32`)                           | Endpoint & Key                           |
| `/dashboard/providers`   | provider connections, OAuth and API-key add flows, status filter, live model lists (`providers/page.js` 1,047; `providers/[id]/page.js` 2,006, the largest file in the repo)                           | Providers                                |
| `/dashboard/basic-chat`  | in-dashboard chat playground                                                                                                                                                                           | Basic Chat, **hidden** (`Sidebar.js:23`) |
| `/dashboard/combos`      | build combos, pick strategy (fallback / round-robin / smart / fusion), capability-aware ordering, fusion judge and tuning (`combos/page.js` 1,382; options at `:51-54`; capability labels at `:21-23`) | Combo & Vision Adapter                   |
| `/dashboard/usage`       | token and cost history across 6 periods (today, 24h, 7d, 30d, 60d, all — `usage/page.js:10-15`), charts, request details, per-provider limits (`ProviderLimits/index.js` 1,697)                        | Usage                                    |
| `/dashboard/quota`       | subscription quota tracking with reset countdowns. The page is 11 lines and renders the same `ProviderLimits` component as the usage page (`quota/page.js:1-11`).                                      | Quota Tracker                            |
| `/dashboard/token-saver` | RTK / Headroom / Caveman / Ponytail / custom-prompt toggles and levels (`TokenSaverClient.js` 1,080)                                                                                                   | Token Saver                              |
| `/dashboard/pxpipe`      | PXPIPE toggle, threshold, install status                                                                                                                                                               | PXPIPE, **hidden** (`Sidebar.js:28`)     |
| `/dashboard/cli-tools`   | per-CLI config writers ("connect Claude Code / Codex / Cursor / …") with install snippets and a `[toolId]` detail page                                                                                 | CLI Tools                                |

**Debug group** (`Sidebar.js:32-35`): `/dashboard/console-log` (server log stream) and `/dashboard/translator` (six-stage translation inspector, section 5.5; gated on `enableTranslator` at `Sidebar.js:269`).

**System group** (`Sidebar.js:37-40`): `/dashboard/proxy-pools` (1,172 lines, one-click relay deploys) and `/dashboard/skills` (installable skills list, copy-link).

**Media providers** — `/dashboard/media-providers/` with `[kind]`, `[kind]/[id]` and `combo` sub-pages. Visible kinds: `embedding`, `image`, `video`, `tts`, `stt`, `systemone` (`Sidebar.js:16`). `webSearch` + `webFetch` share one page at `/dashboard/media-providers/web` (`Sidebar.js:18`). A commented-out line at `Sidebar.js:15` shows `imageToText` and `music` used to be listed.

**Account** — `/dashboard/profile` (1,702 lines): password, auth mode, SSO protocol, OIDC/SAML config (`profile/page.js:888-1012`).

**Not in the sidebar** — `/dashboard/mitm` (cert + DNS interception control).

UI stack from `package.json`: React 19.2.4, Next 16.4.2, zustand, recharts, `@monaco-editor/react`, `@xyflow/react` (flow diagrams), `@dnd-kit/*` (drag-reorder for combo members and connection priority).

### 9.2 i18n

Two separate locale systems.

**Dashboard UI — 34 locales**, each with a JSON bundle in `public/i18n/literals/` (34 files, ~1 MB). Declared at `src/i18n/config.js:1-37`:

```
en, vi, zh-CN, zh-TW, ja, pt-BR, pt-PT, ko, es, de, fr, he, ar, ru,
pl, cs, nl, tr, uk, tl, id, km, th, hi, bn, ur, ro, sv, it, el, hu,
fi, da, no, fa
```

RTL locales (`he`, `ar`, `ur`, `fa`) are in the list. Default `en`, cookie `locale` (`config.js:38-39`), runtime provider at `src/i18n/RuntimeI18nProvider.js` and `runtime.js`. Caveman's classical-Chinese levels are restricted to `zh-CN` / `zh-TW` (`endpointConstants.js:1`).

**README translations — 10 languages** in `i18n/`: pt-BR, vi, zh-CN, ja-JP, ru, th, fa_IR, id-ID, es, fr (`README.md:23`). These are docs, not UI strings. The two lists do not match, which is normal but worth knowing before hunting for a Korean README that does not exist.

---

### 10. Where I am unsure

1. **"Tier" as an engine feature.** Confident there is no tier concept in the routing code (section 1.3). I did not read every dashboard page in full, so a purely presentational tier helper elsewhere would have been missed. The combo strategy picker (`combos/page.js:51-54`) shows no tier language.
2. **README:945, "Set spending limits per provider."** I found no such setting (`settingsRepo.js:7-70` has none; no `spendingLimit` / `budget` hit outside unrelated uses). Reads as a stale or aspirational claim. I did not check the gitbook docs for a matching feature.
3. **`/v1/models/info` webFetch path** — `/v1/fetch` at `v1/models/info/route.js:13` has no matching route. Possibly intentional for a different client. Not chased.
4. **Executor mapping.** `executors/index.js` registers ~30 explicit ids and defaults the rest. I did not enumerate which of the 147 registry entries land on a custom executor versus `DefaultExecutor`; that needs a script over both lists.
5. **Media adapter reachability.** I counted adapter files and read their dispatchers, but did not verify every adapter is reachable from a registry `serviceKinds` declaration.
6. **Security of `src/mitm/` and the web-client executors.** Confirmed existence and size. Did not audit cert handling, DNS mutation, or what the intercept handlers do with credentials on the path.
7. **`kv` table scope list.** Aliases, custom models and MITM aliases use it (`schema.js:104-112`, `repos/aliasRepo.js`). Other writers may exist that I did not trace.
8. **Test coverage claims.** 417 test files exist, weighted toward the translator (`tests/translator/` alone has 20+ named bug-regression files such as `bugs-3905-deepseek-tool-type.test.js` and `bugs-claudeCode-context.test.js`). I did not run them, so I cannot say the suite passes.
