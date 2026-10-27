# Provider adapters

The gateway speaks one canonical, text-only chat shape. An adapter owns
everything between that shape and one upstream wire: URLs, headers, request
translation, response parsing, SSE event parsing, usage extraction, and finish
reason normalization.

Every adapter is synchronous to the registry but asynchronous to the network:

```ts
export interface ProviderAdapter<K extends ProviderKind = ProviderKind> {
  readonly kind: K;
  chat(input: AdapterInput): Promise<CanonicalResult>;
  stream(input: AdapterInput): AsyncGenerator<CanonicalStreamEvent, void, void>;
}

export type AdapterInput = {
  readonly target: ProviderTarget;
  readonly request: CanonicalRequest;
  readonly signal: AbortSignal;
};

export type ProviderTarget = {
  readonly providerId: string;
  readonly kind: ProviderKind;
  readonly baseUrl: string;
  readonly credential: Credential;
  readonly upstreamModel: string;
};
```

One implementation serves every OpenAI-compatible kind:
`src/server/providers/openai/compatible.ts` exposes `bearerAdapter(kind, label?)`
and `chatAdapter({ kind, label, headers })`, both returning `ProviderAdapter<K>`.
`chatAdapter` takes the header hook a kind needs, and `bearerAdapter` is the
hookless form. Kilo Code uses `chatAdapter` for its organization header and its
own auth error; Token Harbor, Yeta, River, and Nous Portal use `bearerAdapter`.

`credential` is the attempt's credential. The gateway opens it immediately before
the call and never passes more than one to an adapter. An OAuth credential that
is due arrives already renewed.

`Credential` is a sealed-bundle union from `src/server/credential.ts`:

```ts
| { authMode: "api-key"; apiKey: string }
| {
    authMode: "oauth";
    accessToken: string;
    organizationId: string | null;
    refreshToken: string | null;
    expiresAt: number | null;
  }
```

API-key adapters read `apiKey`. An OAuth kind reads `accessToken` and any
provider-specific account field. Kilo Code sends the token as a bearer and adds
`X-Kilocode-OrganizationID` when the account profile named an organization.
`refreshToken` and `expiresAt` are null on a Kilo Code login, which never
renews; the Nous Portal login fills both. A bundle sealed before those fields
existed parses with both null, so an old row keeps working
(`src/server/credential.test.ts`).

`CanonicalRequest` carries `messages` (`system | user | assistant`), `temperature`,
`topP`, `maxTokens`, and `stop`. `CanonicalResult` carries `text`, `finishReason`,
and `usage` (`inputTokens`, `outputTokens`, each `number | null`).
`CanonicalStreamEvent` is one of:

```ts
| { type: "text"; text: string }
| { type: "usage"; usage: CanonicalUsage }
| { type: "finish"; reason: string | null }
```

The gateway does not read provider JSON. It sees text, usage, finish, or a thrown
`UpstreamError`. That boundary is the extension point: a new wire format changes
one provider directory.

## Registry

Each provider is a directory under `src/server/providers/<kind>/`. Its
`index.ts` exports one definition object that bundles the adapter with every
capability the provider has. `src/server/providers/registry.ts` holds the record:

```ts
const genericDefinitions = {
  openai,
  anthropic,
  google,
} satisfies GenericProviderDefinitions;

const builtInDefinitions = {
  kilocode,
  tokenharbor,
  yeta,
  river,
  nous,
} satisfies BuiltInProviderDefinitions;

const providerDefinitions: ProviderDefinitionRecord = {
  ...genericDefinitions,
  ...builtInDefinitions,
};

export function definitionFor<K extends ProviderKind>(kind: K): ProviderDefinitionRecord[K] {
  return providerDefinitions[kind];
}
```

`src/server/providers/types.ts` splits a definition in two. A generic wire has
capabilities only. A built-in also carries the settings its row is seeded with:

```ts
type DefinitionCapabilities<K extends ProviderKind> = {
  readonly adapter: ProviderAdapter<K>;
  readonly authModes: readonly ProviderAuthMode[];
  readonly oauth?: OAuthConnector;
  readonly catalog?: ProviderCatalog;
  readonly renew?: CredentialRenewer;
};

export type GenericProviderDefinition<K extends GenericProviderKind = GenericProviderKind> =
  DefinitionCapabilities<K> & {
    readonly kind: K;
    readonly builtIn?: undefined;
  };

export type BuiltInProviderDefinition<K extends BuiltInProviderKind = BuiltInProviderKind> =
  DefinitionCapabilities<K> & {
    readonly kind: K;
    readonly builtIn: BuiltInProviderSettings;
  };
```

`authModes` is the credential modes the kind can accept, and it is the only source
for them: a custom kind declares `["api-key"]`, Kilo Code declares
`["api-key", "oauth"]` because a device login and a pasted key both reach the
same bearer header, and Nous Portal declares only `["oauth"]` because the portal
issues no key. The `Provider` value on the wire carries the same list, which is
what turns into the credential dialog's tabs, and the credential routes reject an
API key for a kind that does not list `api-key` (`unsupported_mode`, HTTP 400).
`registry.test.ts` requires a kind that lists `oauth` to have a connector, so the
two cannot drift apart.

`GenericProviderDefinitions` and `BuiltInProviderDefinitions` make the compiler
fail when a kind list gains a member without a definition, when an entry carries
a `kind` that disagrees with its key, and when a built-in has no `builtIn`
settings. The key check works because each definition is annotated with its own
kind, as in `GenericProviderDefinition<"openai">` or
`BuiltInProviderDefinition<"kilocode">`. `builtInProviders` derives the seeding
list from `BUILT_IN_PROVIDER_KINDS`, so seeding order does not depend on the
record's key order.

There is no dynamic loading: the binary is compiled, so a static, exhaustive
record is the registration mechanism.

## Built-in and custom providers

`GENERIC_PROVIDER_KINDS` is the list a user sees in **Add custom provider**:
`openai`, `anthropic`, and `google`. A custom provider is a row in SQLite with
`origin = "custom"` and one of those wires. Adding one never changes code.

A built-in provider takes its name, slug, and default base URL from
`BUILT_IN_PROVIDERS` and its kind from `BUILT_IN_PROVIDER_KINDS` in
`src/shared/providers.ts`. Its behavior comes from the definition in
`src/server/providers/<kind>/`. Its row has `origin = "builtin"` and is seeded
for every account by `ensureBuiltInProviders`. There are five: Kilo Code, Token
Harbor, Yeta, River, and Nous Portal. Each `index.ts` bundles its adapter with
whatever else the provider has: a catalog for all five, an `OAuthConnector` for
Kilo Code and Nous Portal, a `CredentialRenewer` for Nous Portal, and an
env-aware `builtIn.baseUrl()`. The definition reads that function at seeding
time, so `BANDAR_TOKENHARBOR_API` and its siblings can point the seeded rows at
another origin. Built-in rows cannot be created through the provider API, edited
in Settings, or removed; they reappear on the next listing if deleted directly.

Seeding is idempotent per kind. If a custom row already owns a slug that has
since become reserved, the built-in takes the next free slug from
`availableSlug` instead of being silently suppressed, and its name falls back the
same way.

The distinction is about existence, not wire shape. Four built-ins speak the
OpenAI wire, and their `index.ts` builds the shared adapter and adds only the
catalog, the login, or the renewal that is theirs. Kilo Code is the one built-in
that needs its own adapter headers.

## Catalogs

`ProviderCatalog` receives the base URL, an abort signal, and the credential the
chain would try first:

```ts
export type CatalogRequest = {
  readonly baseUrl: string;
  readonly credential: Credential | null;
  readonly signal: AbortSignal;
};

export type ProviderCatalog = (request: CatalogRequest) => Promise<readonly ModelCatalogEntry[]>;
```

The refresh route reads that credential with `readFirstCredential`, so an import
uses the same key the first chat attempt would. `readModelIds` in
`src/server/providers/catalog.ts` is the common keyed catalog: `GET {base}/models`
with a bearer, and a null credential is an `invalid_request` that the API answers
as 400 ("add a key before importing the catalog"). A public catalog ignores the
credential, as Nous Portal's does.

Prices are optional metadata. Each wire joins them its own way, and a failed join
leaves the models unpriced rather than failing the import:

| Provider     | Model list                         | Price join                                                       |
| ------------ | ---------------------------------- | ---------------------------------------------------------------- |
| Token Harbor | keyed `/models`                    | none; every price is null                                        |
| Yeta         | keyed `/models`                    | `GET {origin}/api/pricing`; input is `model_ratio * 2` USD/Mtok  |
| River        | public pricing JSON                | the list and the prices are the same document (`input`/`output`) |
| Nous Portal  | public OpenRouter-shaped `/models` | `pricing.prompt`/`completion` per token, times 1e6               |
| Kilo Code    | keyed gateway catalog              | `pricing.prompt`/`completion` per token, times 1e6               |

Yeta is a New API gateway: one ratio unit is $0.002 per 1K tokens, so a ratio is
worth $2 per million and the output price is the input price times
`completion_ratio`. `quota_type = 1` means per-call pricing, so those models get
null prices; `group_ratio` is not applied. The public pricing URL defaults to
`https://console.river.ai/api/public/pricing` and is overridden with
`BANDAR_RIVER_PRICING_URL`; when that document cannot be read, River falls back
to its keyed `/models` list with null prices. Nous Portal keeps only models whose
`architecture.output_modalities` includes `text`.

## Errors

Adapters throw one type:

```ts
new UpstreamError(message, kind, status);
```

`kind` is one of `auth`, `rate_limit`, `invalid_request`, `unavailable`,
`protocol`, or `network`. `status` is the upstream HTTP status when there was
one. The gateway maps `rate_limit` to 429, `invalid_request` to 400, and the rest
to 502, then records the event with the error kind.

Helpers in `src/server/providers/http.ts`:

- `joinUrl(baseUrl, "/path")` strips duplicate slashes.
- `postJson({ url, headers, body, signal })` turns a network failure into
  `UpstreamError(..., "network")` and passes an abort through.
- `postForm({ url, headers, form, signal })` sends a form-urlencoded body with
  the same network mapping.
- `requireOk(response)` reads an error envelope (`error.message`, `message`, or
  plain text) and classifies the status.
- `sseData(body, signal)` yields the joined `data:` lines of each SSE event.
- `apiKeyHeader(name, key)` omits the header when the upstream needs no key.

## Wire mapping

|                | OpenAI                                            | Anthropic                                                    | Google GenAI                             | Kilo Code                                         | Token Harbor, Yeta, River                         | Nous Portal                                                  |
| -------------- | ------------------------------------------------- | ------------------------------------------------------------ | ---------------------------------------- | ------------------------------------------------- | ------------------------------------------------- | ------------------------------------------------------------ |
| Chat URL       | `{base}/chat/completions`                         | `{base}/messages`                                            | `{base}/models/{model}:generateContent`  | `{base}/chat/completions`                         | `{base}/chat/completions`                         | `{base}/chat/completions`                                    |
| Stream URL     | same                                              | same                                                         | `...:streamGenerateContent?alt=sse`      | same                                              | same                                              | same                                                         |
| Auth header    | `Authorization: Bearer`                           | `x-api-key` + `anthropic-version: 2023-06-01`                | `x-goog-api-key`                         | `Authorization: Bearer` + optional org header     | `Authorization: Bearer`                           | `Authorization: Bearer` with the token from the device login |
| System prompt  | a `system` message                                | top-level `system`                                           | `systemInstruction`                      | a `system` message                                | a `system` message                                | a `system` message                                           |
| Assistant role | `assistant`                                       | `assistant`                                                  | `model`                                  | `assistant`                                       | `assistant`                                       | `assistant`                                                  |
| Max tokens     | `max_tokens`                                      | required `max_tokens` (default 1024)                         | `generationConfig.maxOutputTokens`       | `max_tokens`                                      | `max_tokens`                                      | `max_tokens`                                                 |
| Stop           | `stop`                                            | `stop_sequences`                                             | `generationConfig.stopSequences`         | `stop`                                            | `stop`                                            | `stop`                                                       |
| Stream usage   | final chunk, after `stream_options.include_usage` | `message_start` + `message_delta`                            | `usageMetadata` on chunks                | final chunk, after `stream_options.include_usage` | final chunk, after `stream_options.include_usage` | final chunk, after `stream_options.include_usage`            |
| Finish reason  | native                                            | `end_turn`/`stop_sequence` → `stop`, `max_tokens` → `length` | `STOP` → `stop`, `MAX_TOKENS` → `length` | native                                            | native                                            | native                                                       |

Anthropic and Google reject adjacent messages with the same role in some
configurations, so both adapters merge consecutive same-role messages. Every
other wire is the OpenAI chat shape, so it is passed through unchanged apart from
optional fields the canonical request does not carry. That is one adapter
implementation, not five: Kilo Code, Token Harbor, Yeta, River, and Nous Portal
all differ only in their headers and their catalogs.

Kilo Code has two URLs: the OpenRouter-shaped gateway at
`https://api.kilo.ai/api/openrouter` for chat, and the catalog at
`https://api.kilo.ai/api/gateway/models`. Its `index.ts` builds the shared
adapter with its own header hook. `catalog.ts` in the same directory reads the
catalog for **Import catalog** and turns per-token pricing into
per-million-token prices. A `-1` price means Kilo routes the model dynamically
and is stored as `null`. River's catalog is its console's public pricing JSON,
which is why it can list models before any key is saved.

## Streaming rules

1. `stream()` yields text events only for non-empty deltas.
2. Yield `usage` as soon as the provider reports it. The gateway keeps the last
   value it saw and writes one usage chunk at the end.
3. Yield exactly one `finish` before returning, even when the provider omitted a
   reason; use `null`.
4. A provider error frame throws `UpstreamError`. The gateway sends an SSE error
   object and `[DONE]`, records the failure, and closes.
5. Respect `input.signal`. The gateway aborts it when the client disconnects, and
   records the attempt as `aborted`.

TTFT is measured by the gateway at the first non-empty text event. Adapters do
not measure time, and non-streaming requests have no TTFT.

## Adding a kind

1. For a generic wire, add the literal to `GENERIC_PROVIDER_KINDS` in
   `src/shared/providers.ts`. For a built-in, add it to
   `BUILT_IN_PROVIDER_KINDS`, add its name, slug, and base URL to
   `BUILT_IN_PROVIDERS`, and add its label to `PROVIDER_KIND_LABELS`.
2. Create `src/server/providers/<kind>/index.ts` with the definition, annotated
   with its own kind. An OpenAI-compatible kind builds its adapter with
   `bearerAdapter("<kind>")`; a wire that needs its own headers builds one with
   `chatAdapter({ kind, label, headers })`. Add an `OAuthConnector`, a
   `ProviderCatalog`, or a `CredentialRenewer` when the provider has one.
3. Register the definition in `genericDefinitions` or `builtInDefinitions` in
   `src/server/providers/registry.ts`. Both `satisfies` records report a missing
   entry, a wrong kind for the key, and a built-in without its `builtIn`
   settings.
4. Add a logo path to `LOGO_PATHS` and a base URL to `PLACEHOLDERS` in the
   client. The client's `Record<ProviderKind, ...>` tables fail until both exist.
5. Add the fake upstream routes and the checks that prove each capability: one
   streaming or non-streaming text/usage assertion per wire, plus one for every
   catalog, login, or renewal. The fake verifies the auth header too.
6. Run `bun run check && bun run test && bun run build && bun run smoke`.

No database migration is needed for a new kind: `providers.kind` is text and its
TypeScript type comes from `ProviderKind`. A credential row carries an
`auth_mode` column and a sealed bundle, so an API-key kind and an OAuth kind use
the same `provider_credentials` shape. `origin` separates a seeded built-in from a custom row. The
dashboard's kind picker, the add dialog, and the provider logo table read the
generic and built-in lists, so a new kind appears once it has a path in
`./src/client/components/provider-logo.tsx`.

## OAuth built-ins

Kilo Code and Nous Portal log in with a device code. A definition with an
`oauth` connector serves the `/api/providers/:id/oauth/{start,poll}` routes;
without one, both routes answer 400. The dashboard shows the **Connection** tab
when the kind's `authModes` includes `oauth`, so a new OAuth kind needs no client
branch.

The connector contract lives in `src/server/providers/types.ts`:

```ts
export interface OAuthConnector {
  start(signal: AbortSignal): Promise<DeviceLogin>;
  poll(code: string, signal: AbortSignal): Promise<DevicePollResult>;
}
```

`src/server/providers/kilocode/oauth.ts` and
`src/server/providers/nous/oauth.ts` implement it. The API keeps the device code
server-side, keyed by user and provider; the start response returns only the
short user code and the verification URL. The poll appends a credential with
`addOAuthCredential`, which seals the OAuth bundle and records `auth_mode =
"oauth"` on that row. An API key added later is another credential in the chain,
so the gateway can fall from the token to the key or the other way round, except
for Nous Portal, whose definition lists only `oauth` and whose credential routes
reject a key with `unsupported_mode`. A built-in provider's row is seeded before
login, so the Connection tab works on the first visit.

Nous Portal's login posts `client_id=hermes-cli` and `scope=inference:invoke`
to `/api/oauth/device/code` and polls `/api/oauth/token` with the device grant.
A 400 `authorization_pending` or `slow_down` is a pending poll; `expired_token`
or `access_denied` is an `invalid_request`. The token response supplies the
access token, the rotating refresh token, and `expires_in`, which become the
credential's `expiresAt`. A token without `expires_in` is a protocol error.

An OAuth connector that needs an account identifier should look it up during
`poll` and return it in the bundle, as Kilo Code does with `organizationId`. The
adapter then decides whether that identifier becomes a header.

## OAuth renewal

A definition may carry a `CredentialRenewer` beside its connector:

```ts
export type CredentialRenewal = {
  readonly providerId: string;
  readonly credential: OAuthCredential;
  readonly signal: AbortSignal;
};

export interface CredentialRenewer {
  due(credential: OAuthCredential, now: number): boolean;
  renew(input: CredentialRenewal): Promise<Credential>;
}
```

`chat.ts` resolves each attempt's credential through `freshCredential`
(`src/server/providers/refresh.ts`) instead of reading it directly. That function
returns the stored credential unchanged unless the definition has a renewer, the
credential is OAuth, the renewer reports it due, and the attempt names a
credential row. Otherwise it renews once per row:

1. A map keyed by credential id is the single-flight slot. Every request that
   arrives while a renewal is in flight awaits the same promise, so a burst of
   chats rotates the refresh token once.
2. Inside the slot it re-reads the row by id. If the sealed value moved, another
   request already renewed it, and that stored credential is returned as is.
3. It calls `renew` with `AbortSignal.timeout(15_000)`, seals the result, and
   writes it with a compare-and-swap:
   `UPDATE provider_credentials SET credential = ?, auth_mode = 'oauth' WHERE id = ? AND credential = ?`.
   A lost race falls back to the stored row; a deleted row is an `auth` error.
4. A failed renewal throws `UpstreamError(..., "auth")`. The gateway records the
   attempt and falls through to the next credential rather than sending a token
   the provider has already rejected.

Nous Portal's renewer is `src/server/providers/nous/renewal.ts`. It reports a
credential due 120 seconds before `expiresAt`, posts `grant_type=refresh_token`
with the refresh token in `x-nous-refresh-token`, stores the rotated token the
response carries, and maps a 400 `invalid_grant` to the "connection expired;
connect it again" auth error. A credential with no refresh token cannot renew and
fails the same way.

## Contract tests

The smoke run is the adapter conformance suite. It boots the compiled binary,
points one custom provider of each generic wire at a local fake upstream, checks
that the five built-in rows were seeded with their auth modes and catalogs, drives
the gateway with a gateway key, and reads the analytics row back. That covers key
decryption, header construction, request translation, non-stream parsing, SSE
parsing, usage extraction, finish normalization, TTFT, and tokens-per-second.

The built-in checks go through fake catalog, pricing, and device-auth servers.
They import each catalog: one keyed with null prices, one keyed with a ratio join,
one public with per-token prices. They approve both device logins, prove Nous
Portal rejects an API key, call the gateway with each credential, renew a Nous
token under two concurrent chats and assert exactly one refresh with no replayed
refresh token, prove a spent refresh token and a credential without one are
`auth` failures, and prove a built-in row cannot be added, edited, removed, or
seeded twice.

Adapters whose wire differs in a way the fake does not model (for example, a
provider that sends usage only on a final event) should extend the fake and add
a focused check rather than mock the adapter in a unit test.
